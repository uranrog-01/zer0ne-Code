import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { markdown, textField } from './frontmatter';
import { identity, noLinks, pathLock, publish, readText, removeStage, stageFor, validateTree, within } from './extensionFiles';

export interface SkillInfo {
	id: string;
	name: string;
	baseName: string;
	description: string;
	source: 'workspace' | 'user' | 'claude' | 'agents' | 'codex' | 'plugin';
	plugin?: string;
	path: string;
	editable: boolean;
	enabled: boolean;
	modelInvocable: boolean;
	userInvocable: boolean;
	/** Phrases in the user's message that make this skill relevant (frontmatter `triggers`). */
	triggers: string[];
	/** Tools the skill says it needs (frontmatter `allowed-tools`); informational for the agent. */
	allowedTools: string[];
	/** `tier: always` skills load with every turn (pinned), like Claude Desktop's bundled tier. */
	tierAlways: boolean;
}

function listField(meta: Record<string, unknown>, ...names: string[]): string[] {
	for (const name of names) {
		const value = meta[name];
		if (value === undefined) continue;
		const rows = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\n]/) : [];
		return rows.map((row) => String(row).trim()).filter(Boolean).slice(0, 20);
	}
	return [];
}

export function slugify(name: string): string {
	return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/** Default characters the skill list may take in the system prompt (settings.skillCatalogChars). */
export const SKILL_CATALOG_CHARS = 12_000;
const CATALOG_HEAD = '\n\nSkills available (load one with the `skill` tool before doing a task it covers):\n';

/**
 * The skill list for the system prompt, within `budget` characters (ZCode's metadata budget): every
 * skill is named if the names fit, the first ones keep their descriptions while room is left, and
 * names that do not fit are counted. A large skill set never silently crowds out the conversation
 * (pure; tested).
 */
export function skillCatalogText(skills: ReadonlyArray<{ name: string; description: string }>, budget: number): string {
	if (!skills.length) return '';
	const full = skills.map(s => `- ${s.name}: ${s.description}`);
	const namesLine = (from: number) => from < skills.length ? `\n- Also available (name only): ${skills.slice(from).map(s => s.name).join(', ')}` : '';
	// The most leading skills that keep descriptions while every other skill is still named.
	let described = 0;
	let used = CATALOG_HEAD.length;
	while (described < skills.length && used + (described ? 1 : 0) + full[described].length + namesLine(described + 1).length <= budget) {
		used += (described ? 1 : 0) + full[described].length;
		described++;
	}
	if (used + namesLine(described).length <= budget) return CATALOG_HEAD + full.slice(0, described).join('\n') + (described ? namesLine(described) : namesLine(0).slice(1));
	// Not even every name fits: name as many as fit and count the rest.
	const tail = (rest: number) => `\n(${rest} more skills not listed: the skill set is larger than the prompt budget)`;
	const names: string[] = [];
	let length = CATALOG_HEAD.length + '- Also available (name only): '.length;
	for (const s of skills) {
		if (length + s.name.length + 2 + tail(skills.length).length > budget) break;
		names.push(s.name);
		length += s.name.length + 2;
	}
	return CATALOG_HEAD + (names.length ? `- Also available (name only): ${names.join(', ')}` : '') + tail(skills.length - names.length);
}

export function parseSkill(text: string): { name?: string; description?: string; tierAlways: boolean; body: string } {
	const { meta, body } = markdown(text);
	return { name: textField(meta, 'name'), description: textField(meta, 'description'), tierAlways: meta['tier'] === 'always', body };
}

export class SkillStore {
	constructor(private readonly userDir: string, private readonly workspaceRoot: () => string | undefined, private readonly disabled: () => string[], private readonly extra: () => Array<{ dir: string; plugin: string }> = () => [], private readonly homeDir: string = os.homedir()) {}

	private sources(): Array<{ dir: string; source: SkillInfo['source']; editable: boolean; plugin?: string }> {
		const root = this.workspaceRoot();
		return [
			...(root ? [{ dir: path.join(root, '.zer0ne', 'skills'), source: 'workspace' as const, editable: true }] : []),
			{ dir: this.userDir, source: 'user', editable: true },
			...this.extra().map(x => ({ ...x, source: 'plugin' as const, editable: false })),
			...(root ? [{ dir: path.join(root, '.agents', 'skills'), source: 'agents' as const, editable: false }, { dir: path.join(root, '.codex', 'skills'), source: 'codex' as const, editable: false }] : []),
			{ dir: path.join(this.homeDir, '.agents', 'skills'), source: 'agents', editable: false },
			{ dir: path.join(this.homeDir, '.codex', 'skills'), source: 'codex', editable: false },
			...(root ? [{ dir: path.join(root, '.claude', 'skills'), source: 'claude' as const, editable: false }] : []),
			{ dir: path.join(this.homeDir, '.claude', 'skills'), source: 'claude', editable: false }
		];
	}

	list(): SkillInfo[] {
		const seenFiles = new Set<string>(), names = new Set<string>(), out: SkillInfo[] = [], disabled = new Set(this.disabled());
		for (const src of this.sources()) {
			let files: string[];
			try {
				noLinks(src.dir);
				files = fs.existsSync(path.join(src.dir, 'SKILL.md')) ? [path.join(src.dir, 'SKILL.md')] : fs.readdirSync(src.dir, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => path.join(src.dir, e.name, 'SKILL.md'));
			} catch { continue; }
			for (const file of files) {
				try {
					const parsed = markdown(readText(file)), baseName = slugify(textField(parsed.meta, 'name') || path.basename(path.dirname(file))), id = 'skill:' + identity(file);
					if (!baseName || seenFiles.has(id)) continue;
					seenFiles.add(id); let name = baseName;
					if (names.has(name)) name = `${slugify(src.plugin ?? src.source) || 'skill'}-${identity(src.dir).slice(0, 6)}/${baseName}`;
					if (names.has(name)) name = `${slugify(src.plugin ?? src.source) || 'skill'}-${identity(file).slice(0, 12)}/${baseName}`;
					names.add(name);
					out.push({ id, name, baseName, description: (textField(parsed.meta, 'description') || parsed.body.split('\n').find(l => l.trim()) || '').slice(0, 300), source: src.source, plugin: src.plugin, path: file, editable: src.editable, enabled: !disabled.has(id) && !disabled.has(name) && !disabled.has(baseName), modelInvocable: parsed.meta['disable-model-invocation'] !== true, userInvocable: parsed.meta['user-invocable'] !== false, triggers: listField(parsed.meta, 'triggers', 'trigger'), allowedTools: listField(parsed.meta, 'allowed-tools', 'allowed_tools', 'tools'), tierAlways: parsed.meta['tier'] === 'always' });
				} catch { /* One invalid skill must not hide the remaining readable catalog. */ }
			}
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}

	read(name: string, invocation: 'model' | 'user' | 'settings' = 'model'): { info: SkillInfo; body: string } | undefined {
		const info = this.list().find(s => s.id === name || s.name === name.toLowerCase());
		if (!info || (invocation !== 'settings' && (!info.enabled || !(invocation === 'model' ? info.modelInvocable : info.userInvocable)))) return undefined;
		const parsed = markdown(readText(info.path)), dir = path.dirname(info.path);
		if (invocation !== 'settings' && (invocation === 'model' ? parsed.meta['disable-model-invocation'] === true : parsed.meta['user-invocable'] === false)) return undefined;
		const extras = fs.readdirSync(dir).filter(f => f !== 'SKILL.md' && !f.startsWith('.')).slice(0, 30);
		return { info, body: parsed.body + (extras.length ? `\n\n(Skill folder ${dir} also contains: ${extras.join(', ')})` : '') };
	}

	/**
	 * Skills whose declared triggers appear in the message, longest trigger
	 * first. Only explicit triggers match: a skill without them is never
	 * suggested, so a large library does not add noise to every prompt.
	 */
	suggest(text: string, limit = 3): SkillInfo[] {
		const hay = ` ${text.toLowerCase().replace(/\s+/g, ' ')} `;
		return this.list()
			.filter((skill) => skill.enabled && skill.modelInvocable && skill.triggers.length)
			.map((skill) => {
				let best = 0;
				for (const trigger of skill.triggers) {
					const phrase = trigger.toLowerCase().trim();
					if (phrase.length > best && hay.includes(phrase)) best = phrase.length;
				}
				return { skill, best };
			})
			.filter((entry) => entry.best > 0)
			.sort((a, b) => b.best - a.best || a.skill.name.localeCompare(b.skill.name))
			.slice(0, limit)
			.map((entry) => entry.skill);
	}

	save(skill: { name: string; description: string; body: string; scope: 'workspace' | 'user'; previous?: string; triggers?: string[] }): SkillInfo {
		const name = slugify(skill.name);
		if (!name) throw new Error('Give the skill a name (letters, numbers, dashes).');
		if (!skill.description.trim()) throw new Error('Add a one-line description — the agent uses it to decide when to load the skill.');
		const root = this.workspaceRoot(), base = skill.scope === 'workspace' ? (root ? path.join(root, '.zer0ne', 'skills') : undefined) : this.userDir;
		if (!base) throw new Error('Open a folder to save workspace skills, or save it as a user skill.');
		const dir = within(base, name);
		const previousInfo = skill.previous ? this.list().find(s => s.id === skill.previous || (s.baseName === slugify(skill.previous!) && s.source === skill.scope)) : undefined;
		if (skill.previous && !previousInfo) throw new Error('The skill being edited is no longer available.');
		if (previousInfo && !previousInfo.editable) throw new Error('This skill is read-only.');
		const previous = previousInfo ? path.dirname(previousInfo.path) : dir;
		return pathLock([dir, previous], () => {
			if (previous !== dir && fs.existsSync(dir)) throw new Error('A skill with that name already exists.');
			const stage = stageFor(dir);
			try {
				if (fs.existsSync(previous)) { validateTree(previous, 20_000_000); fs.cpSync(previous, stage, { recursive: true }); }
				const description = skill.description.replace(/\r?\n/g, ' ').trim();
				const triggers = [...new Set((skill.triggers ?? []).map((trigger) => trigger.trim().toLowerCase()).filter(Boolean))].slice(0, 20);
				const triggerLine = triggers.length ? `triggers: [${triggers.map((trigger) => JSON.stringify(trigger)).join(', ')}]\n` : '';
				fs.writeFileSync(path.join(stage, 'SKILL.md'), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n${triggerLine}---\n\n${skill.body.trim()}\n`);
				parseSkill(readText(path.join(stage, 'SKILL.md'))); publish(stage, dir, previous);
			} finally { removeStage(stage); }
			const saved = this.list().find(s => path.resolve(s.path) === path.join(dir, 'SKILL.md'));
			if (!saved) throw new Error('The saved skill could not be loaded.');
			return saved;
		});
	}

	remove(name: string): void {
		const info = this.list().find(s => s.id === name || s.name === name.toLowerCase());
		if (!info) return;
		if (!info.editable) throw new Error('This skill is read-only — disable it or remove its plugin instead.');
		const dir = path.dirname(info.path);
		pathLock([dir], () => { noLinks(dir); fs.rmSync(dir, { recursive: true, force: true }); });
	}

	/** Within the budget, the project's own skills come first, then the user's, then plugins and shared folders. */
	promptCatalog(budget = SKILL_CATALOG_CHARS): string {
		const root = this.workspaceRoot();
		const inProject = (s: SkillInfo) => !!root && !path.relative(root, s.path).startsWith('..') && !path.isAbsolute(path.relative(root, s.path));
		// `tier: always` skills come first so their descriptions survive a tight
		// prompt budget (skillCatalogText trims the tail first).
		const rank = (s: SkillInfo) => (s.tierAlways ? 0 : 10) + (s.source === 'workspace' || inProject(s) ? 0 : s.source === 'user' ? 1 : s.source === 'plugin' ? 2 : 3);
		const skills = this.list().filter(s => s.enabled && s.modelInvocable);
		return skillCatalogText(skills.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map(x => x.s), budget);
	}
}
