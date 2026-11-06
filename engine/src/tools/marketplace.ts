import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gunzipSync } from 'zlib';
import { execFile } from 'child_process';
import { PluginHost } from './plugins';
import { relativePath, responseBytes, within, validateTree } from './extensionFiles';

/**
 * Plugin marketplaces in the Claude Code format (`.claude-plugin/marketplace.json`
 * in a Git repository) — the same catalogues Claude Code and ZCode read:
 * Anthropic's official directory, community marketplaces, or any repo you add.
 *
 * GitHub sources install without git: the repository tarball is fetched from
 * codeload.github.com and only the plugin's folder is unpacked. Other hosts
 * fall back to `git clone --depth 1`.
 */

export interface MarketplaceRef {
	/** owner/repo on GitHub, or a git URL. */
	id: string;
	name: string;
	builtIn?: boolean;
}

export const DEFAULT_MARKETPLACES: MarketplaceRef[] = [
	{ id: 'anthropics/claude-plugins-official', name: 'Official catalogue', builtIn: true },
	{ id: 'anthropics/claude-code', name: 'Anthropic essentials', builtIn: true },
	{ id: 'wshobson/agents', name: 'Agents & workflows', builtIn: true },
	{ id: 'obra/superpowers-marketplace', name: 'Superpowers', builtIn: true },
	{ id: 'ananddtyagi/claude-code-marketplace', name: 'Community marketplace', builtIn: true },
	{ id: 'jeremylongshore/claude-code-plugins-plus', name: 'Plugins Plus', builtIn: true },
	{ id: 'EveryInc/every-marketplace', name: 'Every', builtIn: true },
	{ id: 'ComposioHQ/awesome-claude-plugins', name: 'Composio', builtIn: true }
];

export type PluginSource = string | { source: 'url' | 'git' | 'github' | 'git-subdir'; url?: string; repo?: string; path?: string; ref?: string; sha?: string };

export interface MarketplacePlugin {
	name: string;
	description: string;
	version?: string;
	category?: string;
	author?: string;
	homepage?: string;
	tags: string[];
	source: PluginSource;
	marketplace: string;
}

const RAW = () => process.env.ZER0NE_GITHUB_RAW || 'https://raw.githubusercontent.com';
const CODELOAD = () => process.env.ZER0NE_GITHUB_CODELOAD || 'https://codeload.github.com';

const cache = new Map<string, { at: number; plugins: MarketplacePlugin[]; name: string }>();

/** owner/repo from "owner/repo", "https://github.com/owner/repo(.git)". */
export function githubRepo(ref: string): string | undefined {
	const m = /^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(ref.trim());
	return m ? `${m[1]}/${m[2]}` : undefined;
}

export async function fetchMarketplace(ref: string, force = false): Promise<{ name: string; plugins: MarketplacePlugin[] }> {
	const hit = cache.get(ref);
	if (hit && !force && Date.now() - hit.at < 10 * 60_000) {
		return hit;
	}
	const repo = githubRepo(ref);
	if (!repo) {
		throw new Error('Only GitHub marketplaces can be browsed (owner/repo). Other hosts: install a plugin from its Git URL.');
	}
	let json: any;
	for (const branch of ['main', 'master', 'HEAD']) {
		const res = await fetch(`${RAW()}/${repo}/${branch}/.claude-plugin/marketplace.json`, { signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
		if (res?.ok) {
			json = JSON.parse((await responseBytes(res, 2 * 1024 * 1024)).toString('utf8'));
			if (json) {
				break;
			}
		}
	}
	if (!json || !Array.isArray(json.plugins)) {
		throw new Error(`${repo} has no .claude-plugin/marketplace.json.`);
	}
	const plugins: MarketplacePlugin[] = json.plugins
		.filter((p: any) => p && typeof p.name === 'string' && p.source)
		.map((p: any) => ({
			name: p.name,
			description: String(p.description ?? ''),
			version: typeof p.version === 'string' ? p.version : undefined,
			category: typeof p.category === 'string' ? p.category : undefined,
			author: typeof p.author === 'string' ? p.author : p.author?.name,
			homepage: typeof p.homepage === 'string' ? p.homepage : undefined,
			tags: Array.isArray(p.tags) ? p.tags.slice(0, 6).map(String) : Array.isArray(p.keywords) ? p.keywords.slice(0, 6).map(String) : [],
			source: p.source,
			marketplace: repo
		}));
	const out = { at: Date.now(), name: String(json.name ?? repo), plugins };
	cache.set(ref, out);
	return out;
}

/** Where a plugin's files live: repository, sub-folder and ref. */
export function resolveSource(p: Pick<MarketplacePlugin, 'source' | 'marketplace'>): { repoUrl: string; github?: string; sub: string; ref?: string } {
	const s = p.source;
	if (typeof s === 'string') {
		return { repoUrl: `https://github.com/${p.marketplace}.git`, github: p.marketplace, sub: relativePath(s, true), ref: undefined };
	}
	const url = s.url ?? (s.repo ? `https://github.com/${s.repo}.git` : '');
	if (!url) {
		throw new Error('This marketplace entry has no source URL.');
	}
	return { repoUrl: url, github: githubRepo(url) ?? (s.repo ? githubRepo(s.repo) : undefined), sub: relativePath(s.path ?? '', true), ref: s.sha ?? s.ref };
}

/** Minimal ustar/pax reader: extract the entries under `prefix` into `dest`. */
export function extractTar(tar: Buffer, prefix: string, dest: string): number {
	prefix = relativePath(prefix, true);
	if (tar.length > 64 * 1024 * 1024 || tar.length % 512) throw new Error('Invalid or oversized plugin archive.');
	let off = 0;
	let longName: string | undefined;
	let count = 0;
	const root = path.resolve(dest);
	while (off + 512 <= tar.length) {
		const header = tar.subarray(off, off + 512);
		if (header.every((b) => b === 0)) {
			break;
		}
		const str = (a: number, n: number) => header.subarray(a, a + n).toString('utf8').replace(/\0.*$/s, '');
		const octal = (a: number, n: number) => {
			const value = str(a, n).trim();
			if (!/^[0-7]+$/.test(value)) throw new Error('Invalid archive number.');
			return parseInt(value, 8);
		};
		const size = octal(124, 12);
		const checksum = octal(148, 8);
		const actual = header.reduce((sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b), 0);
		if (checksum !== actual || size > 32 * 1024 * 1024 || off + 512 + Math.ceil(size / 512) * 512 > tar.length) throw new Error('Damaged plugin archive.');
		const type = String.fromCharCode(header[156] || 48);
		const ustarPrefix = str(345, 155);
		let name = longName ?? (ustarPrefix ? `${ustarPrefix}/${str(0, 100)}` : str(0, 100));
		longName = undefined;
		const body = tar.subarray(off + 512, off + 512 + size);
		off += 512 + Math.ceil(size / 512) * 512;
		if (type === 'x') {
			const m = /\d+ path=([^\n]+)\n/.exec(body.toString('utf8'));
			if (m) {
				longName = m[1];
			}
			continue;
		}
		if (type === 'L') {
			longName = body.toString('utf8').replace(/\0.*$/s, '');
			continue;
		}
		if (type === 'g' || (type !== '0' && type !== '5' && header[156] !== 0)) {
			continue;
		}
		// GitHub tarballs wrap everything in "<repo>-<sha>/".
		name = name.split('/').slice(1).join('/');
		if (prefix && !(name === prefix || name.startsWith(prefix + '/'))) {
			continue;
		}
		const rel = prefix ? name.slice(prefix.length).replace(/^\//, '') : name;
		if (!rel) {
			continue;
		}
		let target: string;
		try { target = within(root, rel.replace(/\/$/, '')); } catch { continue; }
		if (type === '5') {
			fs.mkdirSync(target, { recursive: true });
		} else {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, body);
			count++;
			if (count > 5000) throw new Error('Plugin archive has too many files.');
		}
	}
	return count;
}

/** Download a plugin's folder into a fresh temp directory named after the plugin. */
export async function fetchPluginFolder(p: MarketplacePlugin, signal?: AbortSignal): Promise<{ dir: string; cleanup: () => void }> {
	const src = resolveSource(p);
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-mkt-'));
	const dir = path.join(tmp, p.name.replace(/[^\w.-]/g, '-'));
	const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
	try {
		if (src.github) {
			const res = await fetch(`${CODELOAD()}/${src.github}/tar.gz/${src.ref ?? 'HEAD'}`, { redirect: 'follow', signal: signal ?? AbortSignal.timeout(120_000) });
			if (!res.ok) {
				throw new Error(`GitHub answered HTTP ${res.status} for ${src.github}.`);
			}
			const n = extractTar(gunzipSync(await responseBytes(res, 32 * 1024 * 1024), { maxOutputLength: 64 * 1024 * 1024 }), src.sub, dir);
			if (!n) {
				throw new Error(`No files under "${src.sub || '/'}" in ${src.github}.`);
			}
		} else {
			const clone = path.join(tmp, 'repo');
			await new Promise<void>((resolve, reject) =>
				execFile('git', ['clone', '--depth', '1', ...(src.ref && !/^[0-9a-f]{40}$/.test(src.ref) ? ['--branch', src.ref] : []), src.repoUrl, clone], { windowsHide: true, timeout: 180_000 }, (err, _o, stderr) =>
					err ? reject(new Error((stderr || err.message).trim().slice(0, 300))) : resolve()
				)
			);
			if (src.ref && /^[0-9a-f]{40}$/i.test(src.ref)) {
				await new Promise<void>((resolve, reject) => execFile('git', ['-C', clone, 'fetch', '--depth', '1', 'origin', src.ref!], { windowsHide: true, timeout: 120_000, signal }, err => err ? reject(err) : resolve()));
				await new Promise<void>((resolve, reject) => execFile('git', ['-C', clone, 'checkout', '--detach', src.ref!], { windowsHide: true, timeout: 30_000, signal }, err => err ? reject(err) : resolve()));
			}
			const source = within(clone, src.sub, true);
			validateTree(source);
			fs.cpSync(source, dir, { recursive: true, filter: (x) => !/[\\/]\.git([\\/]|$)/.test(x) });
		}
		return { dir, cleanup };
	} catch (e) {
		cleanup();
		throw e;
	}
}

/** What a downloaded plugin contains — hooks and MCP servers run code on this machine. */
export function inspectPlugin(dir: string): { commands: number; agents: number; skills: number; hooks: boolean; mcp: boolean } {
	return new PluginHost('', () => undefined, () => []).inspect(dir);
}
