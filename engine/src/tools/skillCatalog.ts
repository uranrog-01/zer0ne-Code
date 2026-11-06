import * as fs from 'fs';
import * as path from 'path';
import { parseSkill, slugify } from './skills';
import { pathLock, publish, readText, relativePath, removeStage, responseBytes, stageFor, within } from './extensionFiles';

/**
 * Skills catalog: public SKILL.md collections on GitHub, sorted into a few
 * categories, installable one skill at a time (the whole skill folder —
 * SKILL.md plus its scripts and references — copied into the user skills
 * folder). One GitHub API call per collection (the repo tree); the SKILL.md
 * files come from raw.githubusercontent.com. Cached on disk for a day.
 */

export interface CatalogSource {
	repo: string;
	name: string;
	/** Only skills under this folder. */
	prefix?: string;
	/** Skip skills whose path matches (e.g. 800 app-automation stubs). */
	exclude?: RegExp;
	license: string;
}

export const SKILL_SOURCES: CatalogSource[] = [
	{ repo: 'citrolabs/ego-lite', name: 'ego browser', prefix: 'skills/', license: 'MIT (skill and harness; browser installed separately)' },
	{ repo: 'anthropics/skills', name: 'Anthropic', prefix: 'skills/', license: 'per skill (see its LICENSE)' },
	{ repo: 'obra/superpowers', name: 'Superpowers', prefix: 'skills/', license: 'MIT' },
	{ repo: 'ComposioHQ/awesome-claude-skills', name: 'Awesome Claude Skills', exclude: /^composio-skills\//, license: 'per skill' },
	{ repo: 'openai/skills', name: 'OpenAI', prefix: 'skills/', license: 'per skill (see its LICENSE)' },
	{ repo: 'vercel-labs/agent-skills', name: 'Vercel', prefix: 'skills/', license: 'see the repo' },
	{ repo: 'huggingface/skills', name: 'Hugging Face', license: 'Apache-2.0' },
	{ repo: 'trailofbits/skills', name: 'Trail of Bits', prefix: 'plugins/', license: 'CC-BY-SA-4.0' },
	{ repo: 'K-Dense-AI/claude-scientific-skills', name: 'Scientific (K-Dense)', prefix: 'skills/', license: 'MIT' }
];

/** Directories that list skills by their GitHub repos (browse there, paste a link here). */
export const SKILL_DIRECTORIES = [
	{ name: 'SkillsLLM', url: 'https://skillsllm.com', note: '5,000+ skills and MCP servers, security-scanned' },
	{ name: 'Anthropic skills', url: 'https://github.com/anthropics/skills', note: 'The reference collection' }
];

export interface CatalogSkill {
	/** repo:path — stable id */
	id: string;
	name: string;
	description: string;
	category: string;
	source: string;
	repo: string;
	/** Folder of the skill inside the repo. */
	dir: string;
	/** Files in the folder (relative to it). */
	files: string[];
	url: string;
	commit?: string;
}

/** Categories, most specific first. Matched on the skill name, then on its description. */
export const SKILL_CATEGORIES: Array<[string, RegExp]> = [
	['Security', /secur|vulnerab|\baudit|fuzz|exploit|semgrep|codeql|sarif|threat|malware|constant-time|\bcrypto/i],
	['Science', /\bbio|chem|protein|genom|molecul|clinical|scientif|physics|astro|single-cell|alphafold|pubmed|drug|cell\b/i],
	['Documents', /docx|pdf|pptx|xlsx|spreadsheet|powerpoint|coauthor|\bword\b/i],
	['Testing & debugging', /test|debug|diagnos|verif|\bqa\b|playwright/i],
	['Git & workflow', /\bgit\b|branch|worktree|commit|plan|brainstorm|agents?\b|review|superpowers|changelog|workflow/i],
	['Design & frontend', /design|frontend|canvas|\bart\b|brand|theme|\bgif\b|artifact|\bui\b|css|react|vue|svelte|next\.?js|tailwind|composition/i],
	['Code & APIs', /\bapi\b|\bmcp\b|\bcode\b|\bsdk\b|skill-creator|developer|refactor|typescript|python/i],
	['Writing', /comms|writ|content|resume|twitter|blog|article|copy/i],
	['Data & research', /research|analy|insight|lead|\bads?\b|invoice|data|csv|finance/i]
];

export function categorize(name: string, description: string): string {
	const n = name.replace(/[-_]/g, ' ');
	return SKILL_CATEGORIES.find(([, re]) => re.test(n))?.[0] ?? SKILL_CATEGORIES.find(([, re]) => re.test(description))?.[0] ?? 'Utilities';
}

/** Repo tree → skill folders with their files (pure; tested). */
export function skillFolders(tree: Array<{ path: string; type: string; size?: number }>, src: Pick<CatalogSource, 'prefix' | 'exclude'>): Array<{ dir: string; files: string[] }> {
	const skills = tree.filter((t) => t.type === 'blob' && /(^|\/)SKILL\.md$/.test(t.path) && (!src.prefix || t.path.startsWith(src.prefix)) && !(src.exclude && src.exclude.test(t.path)));
	return skills.map((s) => {
		const dir = s.path.replace(/\/?SKILL\.md$/, '');
		const files = tree
			.filter((t) => t.type === 'blob' && (dir ? t.path.startsWith(dir + '/') : true))
			.map((t) => (dir ? t.path.slice(dir.length + 1) : t.path))
			// A nested skill folder belongs to that skill, not this one.
			.filter(f => f === 'SKILL.md' || !skills.some(other => other.path !== s.path && (!dir || other.path.startsWith(dir + '/')) && f.startsWith((dir ? other.path.slice(dir.length + 1) : other.path).replace(/SKILL\.md$/, ''))));
		return { dir, files };
	});
}

const API = () => process.env.ZER0NE_GITHUB_API || 'https://api.github.com';
const RAW = () => process.env.ZER0NE_GITHUB_RAW || 'https://raw.githubusercontent.com';

async function getJson(url: string): Promise<any> {
	const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'zer0ne-coding' }, signal: AbortSignal.timeout(20_000) });
	if (!res.ok) throw new Error(`${new URL(url).host} answered HTTP ${res.status}${res.status === 403 ? ' (GitHub rate limit — try again in an hour)' : ''}`);
	return JSON.parse((await responseBytes(res, 16_000_000)).toString('utf8'));
}

async function getText(url: string): Promise<string> {
	const res = await fetch(url, { headers: { 'User-Agent': 'zer0ne-coding' }, signal: AbortSignal.timeout(20_000) });
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	return (await responseBytes(res, 2_000_000)).toString('utf8');
}

async function pinnedTree(repo: string, ref = 'HEAD'): Promise<{ commit: string; tree: Array<{ path: string; type: string; size?: number }> }> {
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !ref || /[\x00-\x1f]/.test(ref)) throw new Error('Invalid skill repository or ref.');
	const info = await getJson(`${API()}/repos/${repo}/commits/${encodeURIComponent(ref)}`);
	if (!/^[a-f0-9]{40}$/i.test(info.sha)) throw new Error('GitHub returned no immutable skill commit.');
	const result = await getJson(`${API()}/repos/${repo}/git/trees/${info.sha}?recursive=1`);
	if (result.truncated || !Array.isArray(result.tree)) throw new Error('The skill repository tree is incomplete.');
	return { commit: info.sha, tree: result.tree };
}

/** Run `fn` over `items` with at most `n` in flight. */
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let i = 0;
	await Promise.all(
		Array.from({ length: Math.min(n, items.length) }, async () => {
			while (i < items.length) {
				const k = i++;
				out[k] = await fn(items[k]);
			}
		})
	);
	return out;
}

export async function fetchSkillCatalog(cacheDir: string, force = false): Promise<{ at: number; skills: CatalogSkill[]; errors: string[] }> {
	const file = path.join(cacheDir, 'skill-catalog.json');
	if (!force) {
		try {
			const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
			if (cached.version === 3 && Date.now() - cached.at < 24 * 60 * 60_000 && Array.isArray(cached.skills) && cached.skills.every((s: CatalogSkill) => /^[a-f0-9]{40}$/i.test(s.commit ?? ''))) return cached;
		} catch {
			/* not cached */
		}
	}
	const skills: CatalogSkill[] = [];
	const errors: string[] = [];
	for (const src of SKILL_SOURCES) {
		try {
			const tree = await pinnedTree(src.repo);
			const all = skillFolders(tree.tree, src), folders = all.slice(0, 120);
			if (all.length > 120) errors.push(`${src.name}: showing the first 120 of ${all.length} skills.`);
			const read = await pool(folders, 8, async (f) => {
				try {
					const text = await getText(`${RAW()}/${src.repo}/${tree.commit}/${f.dir ? f.dir + '/' : ''}SKILL.md`);
					const meta = parseSkill(text);
					const name = meta.name || path.posix.basename(f.dir) || src.repo.split('/')[1];
					const description = (meta.description || '').slice(0, 400);
					return { id: src.repo + ':' + f.dir, name, description, category: categorize(name, description), source: src.name, repo: src.repo, dir: f.dir, files: f.files, commit: tree.commit, url: `https://github.com/${src.repo}/tree/${tree.commit}/${f.dir}` } as CatalogSkill;
				} catch {
					return undefined;
				}
			});
			// Collections re-publish each other's skills: keep the first (official) copy.
			for (const x of read) if (x && x.description && !skills.some((k) => k.name === x.name)) skills.push(x);
		} catch (e) {
			errors.push(src.name + ': ' + (e instanceof Error ? e.message : String(e)));
		}
	}
	const out = { version: 3, at: Date.now(), skills, errors };
	if (skills.length) {
		try {
			fs.mkdirSync(cacheDir, { recursive: true });
			fs.writeFileSync(file, JSON.stringify(out));
		} catch {
			/* cache is optional */
		}
	}
	return out;
}

/**
 * A pasted link → owner/repo (+ folder): a GitHub repo or tree URL, "owner/repo",
 * or a SkillsLLM skill page (its "github.com/owner/repo" link) (tested).
 */
export async function resolveSkillLink(input: string, fetchText: (url: string) => Promise<string> = getText): Promise<{ repo: string; dir: string; ref?: string }> {
	const s = input.trim().replace(/\.git$/, '');
	const gh = /^(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(?:tree|blob)\/([^/?#]+)\/?([^?#]*))?\/?(?:[?#].*)?$/i.exec(s);
	if (gh) { const dir = decodeURIComponent(gh[4] || '').replace(/\/?SKILL\.md$/i, '').replace(/\/+$/, ''); relativePath(dir, true); return { repo: gh[1] + '/' + gh[2], dir, ...(gh[3] ? { ref: decodeURIComponent(gh[3]) } : {}) }; }
	if (/^[\w.-]+\/[\w.-]+$/.test(s)) return { repo: s, dir: '' };
	if (/^(?:https?:\/\/)?(?:www\.)?skillsllm\.com\/skill\/[\w.-]+/i.test(s)) {
		const html = await fetchText(s.startsWith('http') ? s : 'https://' + s);
		const m = /href="https:\/\/github\.com\/([\w.-]+\/[\w.-]+)#readme"/.exec(html) ?? />github\.com\/([\w.-]+\/[\w.-]+)</.exec(html);
		if (!m) throw new Error('That SkillsLLM page has no GitHub link.');
		return { repo: m[1], dir: '' };
	}
	throw new Error('Paste a GitHub repo (owner/repo or https://github.com/…) or a skillsllm.com/skill/… link.');
}

/** Every SKILL.md folder in a repo (or under one folder of it), ready to install. */
export async function repoSkills(repo: string, dir = '', ref = 'HEAD'): Promise<CatalogSkill[]> {
	dir = relativePath(dir, true); const tree = await pinnedTree(repo, ref);
	const folders = skillFolders(tree.tree, {}).filter(f => !dir || f.dir === dir || f.dir.startsWith(dir + '/'));
	if (folders.length > 120) throw new Error('This repository has more than 120 skills. Paste a link to a specific skill folder.');
	const out: CatalogSkill[] = [];
	for (const f of await pool(folders, 6, async (f) => {
		try {
			const meta = parseSkill(await getText(`${RAW()}/${repo}/${tree.commit}/${f.dir ? f.dir + '/' : ''}SKILL.md`));
			const name = meta.name || path.posix.basename(f.dir) || repo.split('/')[1];
			const description = (meta.description || '').slice(0, 400);
			return { id: repo + ':' + f.dir, name, description, category: categorize(name, description), source: repo, repo, dir: f.dir, files: f.files, commit: tree.commit, url: `https://github.com/${repo}/tree/${tree.commit}/${f.dir}` } as CatalogSkill;
		} catch {
			return undefined;
		}
	}))
		if (f && !out.some((x) => x.id === f.id)) out.push(f);
	return out;
}

/** Copy one catalog skill's folder into `userDir/<name>/`. Returns the installed folder. */
export async function installCatalogSkill(skill: CatalogSkill, userDir: string): Promise<string> {
	if (!/^[\w.-]+\/[\w.-]+$/.test(skill.repo) || !/^[a-f0-9]{40}$/i.test(skill.commit ?? '')) throw new Error('Refresh this skill to obtain its immutable source commit.');
	const dir = relativePath(skill.dir, true), files = skill.files.map(file => relativePath(file));
	if (!files.includes('SKILL.md') || files.length > 1000 || new Set(files.map(file => file.toLowerCase())).size !== files.length) throw new Error('Incomplete, oversized or duplicate skill file list.');
	const name = slugify(skill.name); if (!name) throw new Error('Invalid skill name.');
	const dest = within(userDir, name);
	return pathLock([dest], async () => {
		const stage = stageFor(dest); let total = 0;
		try {
			for (const file of files) {
				const res = await fetch(`${RAW()}/${skill.repo}/${skill.commit}/${[...(dir ? dir.split('/') : []), ...file.split('/')].map(encodeURIComponent).join('/')}`, { headers: { 'User-Agent': 'zer0ne-coding' }, signal: AbortSignal.timeout(30_000) });
				const bytes = await responseBytes(res, Math.min(2_000_000, 20_000_000 - total)); total += bytes.length;
				const target = within(stage, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
			}
			const meta = parseSkill(readText(path.join(stage, 'SKILL.md')));
			if (!meta.description || !meta.body || (meta.name && slugify(meta.name) !== name)) throw new Error('The downloaded skill metadata is invalid or changed. Refresh the catalog.');
			fs.writeFileSync(path.join(stage, '.zer0ne-origin.json'), JSON.stringify({ repo: skill.repo, dir, commit: skill.commit, source: skill.source, installedAt: Date.now() }, null, 2));
			publish(stage, dest); return dest;
		} finally { removeStage(stage); }
	});
}
