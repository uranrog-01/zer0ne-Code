import { createHash } from 'crypto';
import { McpClient } from './mcpClient';
import { object } from './mcpProtocol';
import { withCredentialLock } from './mcpRefresh';
import type { MessageImage, ToolDef } from '../chatClient';
import type { McpServerConfig } from '../providerStore';
import { McpTokens, canonicalResource, signIn as oauthSignIn } from './mcpOAuth';

/**
 * Minimal Model Context Protocol client (JSON-RPC 2.0) with the two
 * standard transports — stdio (newline-delimited JSON) and streamable
 * HTTP (JSON or SSE responses, Mcp-Session-Id). Servers' tools are
 * exposed to the agent as `mcp__<server>__<tool>`.
 */

export interface RegistryEntry {
	name: string;
	title: string;
	description: string;
	version?: string;
	repository?: string;
	/** Ready-to-save config (secrets left empty for the user to fill in). */
	config: { name: string; transport: 'stdio' | 'http'; command: string; args: string[]; env: Record<string, string>; url: string; headers: Record<string, string> };
	/** Variables / headers the user must fill in. */
	needs: string[];
}

/** Search the official MCP Registry (registry.modelcontextprotocol.io). */
export async function searchMcpRegistry(query: string, signal?: AbortSignal): Promise<RegistryEntry[]> {
	// v0.1 is the current API; v0 is kept as a fallback while both are served.
	let res: Response | undefined;
	for (const v of ['v0.1', 'v0']) {
		res = await fetch(`https://registry.modelcontextprotocol.io/${v}/servers?search=${encodeURIComponent(query)}&limit=40`, { signal: signal ?? AbortSignal.timeout(20_000), headers: { Accept: 'application/json' } });
		if (res.ok) {
			break;
		}
	}
	res = res!;
	if (!res.ok) {
		throw new Error(`MCP Registry search failed (HTTP ${res.status}).`);
	}
	const json = (await res.json()) as { servers?: Array<{ server: any; _meta?: any }> };
	const out: RegistryEntry[] = [];
	const seen = new Set<string>();
	for (const { server: s, _meta } of json.servers ?? []) {
		const official = _meta?.['io.modelcontextprotocol.registry/official'];
		if (!s?.name || seen.has(s.name) || official?.isLatest === false || (official?.status && official.status !== 'active')) {
			continue;
		}
		const short = String(s.name).split('/').pop()!.replace(/[^\w-]+/g, '-').slice(0, 40);
		const needs: string[] = [];
		let config: RegistryEntry['config'] | undefined;
		const pkg = (s.packages ?? []).find((p: any) => ['npm', 'pypi', 'oci'].includes(p.registryType ?? p.registry_type) && (p.transport?.type ?? 'stdio') === 'stdio');
		const remote = (s.remotes ?? []).find((r: any) => r.type === 'streamable-http');
		if (pkg) {
			const kind = pkg.registryType ?? pkg.registry_type;
			const id = pkg.identifier ?? pkg.name;
			const env: Record<string, string> = {};
			for (const v of pkg.environmentVariables ?? pkg.environment_variables ?? []) {
				env[v.name] = v.isSecret || v.is_secret ? '' : String(v.default ?? v.value ?? '');
				if (v.isRequired || v.is_required) {
					needs.push(v.name);
				}
			}
			const argumentList = (items: any[]) => items.flatMap(a => {
				const value = a.value ?? a.default;
				if (value === undefined && (a.isRequired || a.is_required)) { needs.push(a.name ?? a.valueHint ?? 'argument'); return []; }
				if (value !== undefined && /\{[^}]+\}/.test(String(value))) { needs.push(a.name ?? a.valueHint ?? 'argument'); return []; }
				return a.type === 'named' && typeof a.name === 'string' ? [a.name, ...(value === undefined ? [] : [String(value)])] : a.type === 'positional' && value !== undefined ? [String(value)] : [];
			});
			const extra = argumentList(pkg.packageArguments ?? []), runtime = argumentList(pkg.runtimeArguments ?? []);
			config =
				kind === 'npm'
					? { name: short, transport: 'stdio', command: 'npx', args: ['-y', ...runtime, pkg.version ? `${id}@${pkg.version}` : id, ...extra], env, url: '', headers: {} }
					: kind === 'pypi'
						? { name: short, transport: 'stdio', command: 'uvx', args: [...runtime, pkg.version ? `${id}==${pkg.version}` : id, ...extra], env, url: '', headers: {} }
						: { name: short, transport: 'stdio', command: 'docker', args: ['run', '-i', '--rm', ...runtime, ...Object.keys(env).flatMap((k) => ['-e', k]), pkg.version && !/@|:[^/]+$/.test(id) ? `${id}:${pkg.version}` : id, ...extra], env, url: '', headers: {} };
		} else if (remote) {
			const headers: Record<string, string> = {};
			for (const h of remote.headers ?? []) {
				headers[h.name] = h.isSecret || h.is_secret ? '' : String(h.value ?? '');
				if (h.isRequired || h.is_required) {
					needs.push(h.name);
				}
			}
			config = { name: short, transport: 'http', command: '', args: [], env: {}, url: String(remote.url), headers };
		}
		if (!config) {
			continue;
		}
		seen.add(s.name);
		out.push({ name: s.name, title: s.title ?? short, description: String(s.description ?? ''), version: s.version, repository: s.repository?.url, config, needs });
	}
	return out;
}

/** Risk hints a server declares about its own tool (MCP `annotations`). */
export interface McpToolAnnotations {
	title?: string;
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

export interface McpToolInfo {
	_meta?: Record<string, any>;
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	/** Absent when the server sent none — which is not a promise that the tool is safe. */
	annotations?: McpToolAnnotations;
	/** MCP 2025-11-25: whether the tool runs as a task (started, polled, then its result fetched). */
	taskSupport?: 'forbidden' | 'optional' | 'required';
}

/**
 * True only when the server itself declares the tool destructive. A missing hint
 * is not read as a warning, so only the MCP setting governs those tools.
 */
export function destructiveTool(t: McpToolInfo): boolean {
	return t.annotations?.destructiveHint === true;
}

/** Display hint only: missing annotations do not establish that anything changed. */
export function externalTool(t: McpToolInfo): boolean {
	return destructiveTool(t) || t.annotations?.readOnlyHint === false;
}

export interface McpStatus {
	id: string;
	name: string;
	state: 'stopped' | 'connecting' | 'ready' | 'error' | 'auth';
	error?: string;
	tools: Array<{ name: string; description: string }>;
	/** Remote server signed in with OAuth. */
	oauth?: boolean;
}

/** Where OAuth tokens for remote servers are kept (the OS keychain in the extension). */
export interface McpAuthStore {
	get(resource: string): Promise<McpTokens | undefined>;
	set(resource: string, tokens: McpTokens | undefined): Promise<void>;
}

/**
 * The largest tool schema (serialized) that is passed on to the model. A server can send a
 * multi-megabyte schema; that would inflate every request with tokens the model never needs.
 */
const MAX_SCHEMA_CHARS = 16 * 1024;

/** The name an MCP tool is offered under: `mcp__<server>__<tool>`, sanitized and bounded. */
function toolKey(server: string, tool: string): string {
	return `mcp__${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

/** A name that cannot collide with another tool's: derived from the server id and tool name. */
function hashedToolKey(base: string, clientId: string, tool: string): string {
	return `${base.slice(0, 47)}_${createHash('sha256').update(`${clientId}\0${tool}`).digest('hex').slice(0, 16)}`;
}

/**
 * A server's input schema is untrusted input: it is passed on to the model with every request,
 * so an oversized one is replaced by a minimal schema instead of inflating every request.
 */
/**
 * MCP 2025-11-25 makes JSON Schema 2020-12 the default dialect. Several model APIs reject
 * `$schema`, `$defs` and `$ref`, so local references are inlined (a cycle becomes a plain
 * object) and the dialect keywords dropped.
 */
export function portableSchema(schema: Record<string, unknown>): Record<string, unknown> {
	const defs = { ...(object(schema.definitions) ? schema.definitions : {}), ...(object(schema.$defs) ? schema.$defs : {}) } as Record<string, unknown>;
	const walk = (node: unknown, seen: string[]): unknown => {
		if (Array.isArray(node)) return node.map((n) => walk(n, seen));
		if (!object(node)) return node;
		const ref = typeof node.$ref === 'string' ? /^#\/(?:\$defs|definitions)\/(.+)$/.exec(node.$ref)?.[1] : undefined;
		if (ref !== undefined) {
			const name = decodeURIComponent(ref).replace(/~1/g, '/').replace(/~0/g, '~');
			const { $ref: _ref, ...rest } = node;
			if (seen.includes(name) || seen.length > 20 || !object(defs[name])) return { type: 'object', ...(walk(rest, seen) as object) };
			return { ...(walk(defs[name], [...seen, name]) as object), ...(walk(rest, seen) as object) };
		}
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(node)) {
			if (key === '$schema' || key === '$defs' || key === 'definitions' || key === '$id' || key === '$anchor' || key === '$comment') continue;
			// `properties` maps names to schemas; its keys are not keywords.
			out[key] = key === 'properties' && object(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, seen)])) : walk(value, seen);
		}
		return out;
	};
	return walk(schema, []) as Record<string, unknown>;
}

function cappedSchema(raw: Record<string, unknown>): Record<string, unknown> {
	let size = 0;
	let schema = raw;
	try {
		schema = portableSchema(raw);
	} catch {
		/* used as sent */
	}
	try {
		size = JSON.stringify(schema)?.length ?? 0;
	} catch {
		// A schema that cannot be serialized is not usable either.
		return { type: 'object', description: 'Schema omitted: it could not be serialized.' };
	}
	if (size <= MAX_SCHEMA_CHARS) {
		return schema;
	}
	return { type: 'object', description: `Schema omitted: it is ${size} characters, over the ${MAX_SCHEMA_CHARS} character limit. Call the tool with the arguments its description names.` };
}

export class McpManager {
	private readonly clients = new Map<string, McpClient>();
	private readonly authorizing = new Map<string, AbortController>();
	private readonly retiring = new Map<string, Promise<void>>();
	private retire(id: string, client: McpClient): Promise<void> {
		const closing = client.stop(); this.retiring.set(id, closing);
		void closing.then(() => { if (this.retiring.get(id) === closing) this.retiring.delete(id); }).catch(() => undefined);
		return closing;
	}

	constructor(private readonly cwd: () => string | undefined, private readonly onChange: () => void, private readonly auth?: McpAuthStore) {}

	/** Interactive OAuth sign-in for a remote server, then reconnect. */
	async signIn(id: string, openExternal: (url: string) => Thenable<boolean> | Promise<boolean>): Promise<void> {
		const client = this.clients.get(id);
		if (!client || client.config.transport !== 'http' || !this.auth) {
			throw new Error('Only running remote (HTTP) servers can sign in.');
		}
		const key = canonicalResource(client.config.url);
		this.authorizing.get(id)?.abort();
		const flow = new AbortController(); this.authorizing.set(id, flow);
		try {
			const tokens = await oauthSignIn(client.config.url, client.wwwAuthenticate, openExternal, await this.auth.get(key), flow.signal);
			flow.signal.throwIfAborted();
			if (this.clients.get(id) !== client) throw new Error('MCP server changed during sign-in. Try again.');
			await withCredentialLock(key, flow.signal, async () => {
				flow.signal.throwIfAborted();
				if (this.clients.get(id) !== client) throw new Error('MCP server changed during sign-in. Try again.');
				await this.auth!.set(key, tokens);
			});
			this.restart(id);
		} finally { if (this.authorizing.get(id) === flow) this.authorizing.delete(id); }
	}

	async signOut(id: string): Promise<void> {
		this.authorizing.get(id)?.abort();
		const client = this.clients.get(id);
		if (client && this.auth) {
			const key = canonicalResource(client.config.url);
			this.retire(id, client);
			await withCredentialLock(key, new AbortController().signal, () => this.auth!.set(key, undefined));
			if (this.clients.get(id) === client) this.restart(id);
		}
	}

	/** Start/stop/restart clients so they match the saved configuration. */
	sync(configs: McpServerConfig[], enabled: boolean): void {
		const wanted = new Map(configs.filter((c) => enabled && c.enabled).map((c) => [c.id, c]));
		for (const [id, client] of this.clients) {
			const next = wanted.get(id);
			if (!next || new McpClient(next, undefined, () => undefined).signature !== client.signature) {
				this.authorizing.get(id)?.abort();
				this.retire(id, client);
				this.clients.delete(id);
			} else {
				(client.config as McpServerConfig).trusted = next.trusted;
				(client.config as McpServerConfig).disabledTools = next.disabledTools;
				(client.config as McpServerConfig).name = next.name;
			}
		}
		for (const [id, config] of wanted) {
			if (!this.clients.has(id)) {
				const client = new McpClient({ ...config }, this.cwd(), this.onChange, this.auth, this.retiring.get(id));
				this.clients.set(id, client);
				void client.start();
			}
		}
		this.onChange();
	}

	restart(id: string): void {
		this.authorizing.get(id)?.abort();
		const client = this.clients.get(id);
		if (client) {
			const next = new McpClient({ ...client.config }, this.cwd(), this.onChange, this.auth, this.retire(id, client));
			this.clients.set(id, next);
			void next.start();
		}
	}

	statuses(configs: McpServerConfig[]): McpStatus[] {
		return configs.map((c) => {
			const client = this.clients.get(c.id);
			return {
				id: c.id,
				name: c.name,
				state: client?.state ?? 'stopped',
				error: client?.error,
				oauth: client?.hasToken || undefined,
				tools: (client?.tools ?? []).map((t) => ({ name: t.name, description: t.description.slice(0, 160) }))
			};
		});
	}

	/**
	 * Every tool of every server, under a name of its own. A name collision never removes a
	 * tool: the claimants are disambiguated deterministically instead.
	 */
	private entries(): Map<string, { client: McpClient; tool: McpToolInfo }> {
		type Claim = { client: McpClient; tool: McpToolInfo; base: string; raw: string };
		const claims: Claim[] = [];
		for (const client of this.clients.values()) for (const tool of client.tools) {
			const raw = `mcp__${client.config.name}__${tool.name}`;
			claims.push({ client, tool, base: toolKey(client.config.name, tool.name), raw });
		}
		// A stable order makes the names a function of the server set, not of arrival order.
		const groups = new Map<string, Claim[]>();
		for (const claim of [...claims].sort((a, b) => a.client.config.id.localeCompare(b.client.config.id) || a.tool.name.localeCompare(b.tool.name))) {
			const group = groups.get(claim.base) ?? [];
			group.push(claim);
			groups.set(claim.base, group);
		}
		const names = new Map<Claim, string>();
		const taken = new Set<string>();
		// Plain names first: a server keeps its readable name unless another one claims it.
		for (const [base, group] of groups) {
			if (group.length !== 1 || group[0].raw.length > 64) continue;
			const claim = group[0];
			if (taken.has(base)) continue;
			taken.add(base);
			names.set(claim, base);
		}
		// The rest get a hashed name, salted until it is free: a raw name can be crafted to
		// look like a hashed one, so the two are kept apart rather than trusted.
		for (const [base, group] of groups) {
			for (const claim of group) {
				if (names.has(claim)) continue;
				let name = hashedToolKey(base, claim.client.config.id, claim.tool.name);
				for (let salt = 1; taken.has(name); salt++) {
					name = hashedToolKey(base, claim.client.config.id, `${claim.tool.name}\0${salt}`);
				}
				taken.add(name);
				names.set(claim, name);
			}
		}
		// The tools are offered in the order the servers listed them, whatever order
		// their names were assigned in.
		const entries = new Map<string, { client: McpClient; tool: McpToolInfo }>();
		for (const claim of claims) {
			const name = names.get(claim);
			if (name) entries.set(name, { client: claim.client, tool: claim.tool });
		}
		return entries;
	}

	toolDefs(): ToolDef[] {
		const defs: ToolDef[] = [];
		for (const [name, { client, tool: t }] of this.entries()) {
			if (client.state !== 'ready') {
				continue;
			}
			if (!client.config.enabled || client.config.disabledTools?.includes(t.name)) continue;
			if (Array.isArray(t._meta?.ui?.visibility) && !t._meta!.ui.visibility.includes('model')) continue;
			defs.push({ name, description: `[MCP ${client.config.name}] ${t.description}`.slice(0, 1000), parameters: cappedSchema(t.inputSchema) });
		}
		defs.push(...this.bridgeToolDefs());
		return defs;
	}

	/** Resolve an agent tool name to its server + tool, if it is an MCP tool. */
	resolve(name: string): { client: McpClient; tool: McpToolInfo } | undefined {
		if (!name.startsWith('mcp__')) {
			return undefined;
		}
		const hit = this.entries().get(name);
		return hit && hit.client.state === 'ready' && hit.client.config.enabled && !hit.client.config.disabledTools?.includes(hit.tool.name) ? hit : undefined;
	}

	/** A ready, enabled client by its display name or id (for the resource/prompt bridge tools). */
	private byServer(server: string): McpClient | undefined {
		const hit = [...this.clients.values()].find((c) => c.state === 'ready' && c.config.enabled && (c.config.name === server || c.config.id === server));
		if (hit) return hit;
		const lower = server.toLowerCase();
		return [...this.clients.values()].find((c) => c.state === 'ready' && c.config.enabled && c.config.name.toLowerCase() === lower);
	}

	/** Any ready server advertising resources / prompts decides whether the bridge tools are offered. */
	bridgeCapabilities(): { resources: boolean; prompts: boolean } {
		const ready = [...this.clients.values()].filter((c) => c.state === 'ready' && c.config.enabled);
		return { resources: ready.some((c) => c.hasResources), prompts: ready.some((c) => c.hasPrompts) };
	}

	/** Tool definitions for the resource/prompt bridge, offered beside the servers' own tools. */
	bridgeToolDefs(): ToolDef[] {
		const caps = this.bridgeCapabilities();
		const defs: ToolDef[] = [];
		if (caps.resources) {
			defs.push({
				name: 'mcp_resources',
				description: 'Read resources a connected MCP server exposes (files, database rows, documents — tools/list ≠ resources). action "list" shows every server\'s resources with their URIs; "read" returns one by server + URI. Use it for live context a tool call cannot carry.',
				parameters: {
					type: 'object',
					properties: {
						action: { type: 'string', enum: ['list', 'read'], description: 'list (default): all resources — read: one resource' },
						server: { type: 'string', description: 'read: server name from the list output' },
						uri: { type: 'string', description: 'read: the resource URI exactly as listed' }
					}
				}
			});
		}
		if (caps.prompts) {
			defs.push({
				name: 'mcp_prompts',
				description: 'Read prompt templates a connected MCP server offers (ready-made work instructions its maintainer wrote). action "list" shows them per server; "get" renders one with the arguments it declares.',
				parameters: {
					type: 'object',
					properties: {
						action: { type: 'string', enum: ['list', 'get'], description: 'list (default): all prompts — get: render one' },
						server: { type: 'string', description: 'get: server name from the list output' },
						name: { type: 'string', description: 'get: the prompt name exactly as listed' },
						arguments: { type: 'object', description: 'get: the prompt\'s arguments, e.g. {"code": "..."}' }
					}
				}
			});
		}
		return defs;
	}

	private serverList(names: string): string {
		const list = [...this.clients.values()].filter((c) => c.state === 'ready' && c.config.enabled).map((c) => c.config.name);
		return ` Connected servers: ${names ? names : list.join(', ') || 'none'}.`;
	}

	async readResource(server: string, uri: string, signal?: AbortSignal): Promise<string> {
		const client = this.byServer(server);
		if (!client || !client.hasResources) throw new Error(`MCP server "${server}" is not running or exposes no resources.${this.serverList(server)}`);
		const contents = await client.readResource(uri, signal);
		if (!contents.length) return '(the resource has no contents)';
		return contents.map((c) => c.text !== undefined
			? `${c.uri}${c.mimeType ? ` (${c.mimeType})` : ''}\n${c.text}`
			: c.base64 !== undefined ? `${c.uri}: binary resource (${c.mimeType ?? 'application/octet-stream'}), ${(c.base64.length * 0.75 / 1024).toFixed(0)} kB — not shown inline` : `${c.uri}: (unreadable content)`).join('\n\n');
	}

	async listAllResources(signal?: AbortSignal): Promise<string> {
		const ready = [...this.clients.values()].filter((c) => c.state === 'ready' && c.config.enabled && c.hasResources);
		if (!ready.length) return '(no connected MCP server exposes resources)';
		const parts: string[] = [];
		for (const client of ready) {
			try {
				const { resources } = await client.listResources(undefined, signal);
				parts.push(`## ${client.config.name}\n${resources.length ? resources.map((r) => `- ${r.uri}${r.name ? ` — ${r.name}` : ''}${r.mimeType ? ` (${r.mimeType})` : ''}`).join('\n') : '(none listed)'}`);
			} catch (error) {
				parts.push(`## ${client.config.name}\nError: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return parts.join('\n\n');
	}

	async listAllPrompts(signal?: AbortSignal): Promise<string> {
		const ready = [...this.clients.values()].filter((c) => c.state === 'ready' && c.config.enabled && c.hasPrompts);
		if (!ready.length) return '(no connected MCP server offers prompts)';
		const parts: string[] = [];
		for (const client of ready) {
			try {
				const prompts = await client.listPrompts(signal);
				parts.push(`## ${client.config.name}\n${prompts.length ? prompts.map((p) => `- ${p.name}${p.description ? ` — ${p.description}` : ''}${p.args.length ? ` (args: ${p.args.join(', ')})` : ''}`).join('\n') : '(none listed)'}`);
			} catch (error) {
				parts.push(`## ${client.config.name}\nError: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return parts.join('\n\n');
	}

	async getPrompt(server: string, name: string, args: Record<string, string>, signal?: AbortSignal): Promise<string> {
		const client = this.byServer(server);
		if (!client || !client.hasPrompts) throw new Error(`MCP server "${server}" is not running or offers no prompts.${this.serverList(server)}`);
		const rendered = await client.getPrompt(name, args, signal);
		const header = rendered.description ? `${rendered.description}\n\n` : '';
		return header + rendered.messages.map((m) => (m.role === 'user' ? '[user]\n' : '[assistant]\n') + m.text).join('\n\n');
	}

	async call(name: string, args: Record<string, unknown>, signal?: AbortSignal, expected?: { client: McpClient; tool: McpToolInfo }): Promise<{ text: string; images: MessageImage[]; isError: boolean; server: string; trusted: boolean; result: Record<string, unknown> }> {
		const hit = this.resolve(name);
		if (!hit || (expected && (hit.client !== expected.client || hit.tool !== expected.tool))) {
			throw new Error(`MCP tool ${name} is not available (server stopped?).`);
		}
		const result = await hit.client.callTool(hit.tool, args, signal);
		if (!object(result) || (!Array.isArray(result.content) && !object(result.structuredContent))) throw new Error('Invalid MCP tool result.');
		const texts: string[] = [];
		const images: MessageImage[] = [];
		for (const c of result?.content ?? []) {
			if (!object(c)) throw new Error('Invalid MCP content block.');
			if (c.type === 'text' && typeof c.text === 'string') {
				texts.push(c.text);
			} else if (c.type === 'image' && typeof c.data === 'string') {
				images.push({ mime: c.mimeType ?? 'image/png', base64: c.data, name: 'mcp-image' });
			} else if (c.type === 'resource' && typeof c.resource?.text === 'string') {
				texts.push(c.resource.text);
			} else if (c.type === 'resource_link') {
				texts.push(`[resource] ${c.uri}${c.name ? ` — ${c.name}` : ''}${c.description ? `: ${c.description}` : ''}`);
			} else {
				texts.push(`[MCP ${String(c.type ?? 'unknown')} content is available in the original result; this chat cannot display it.]`);
			}
		}
		if (result?.structuredContent) {
			texts.push(JSON.stringify(result.structuredContent, null, 2));
		}
		return { text: texts.join('\n\n') || '(no content)', images, isError: result?.isError === true, server: hit.client.config.name, trusted: hit.client.config.trusted === true, result };
	}

	isTrusted(name: string): boolean {
		return this.resolve(name)?.client.config.trusted === true;
	}

	dispose(): Promise<void> {
		for (const flow of this.authorizing.values()) flow.abort();
		this.authorizing.clear();
		const closing = [...this.clients.values()].map(client => client.stop());
		this.clients.clear();
		return Promise.allSettled(closing).then(() => undefined);
	}
}

/** Parse Claude Desktop / Cursor / VS Code style MCP JSON into configs. */
export function parseMcpJson(text: string): Array<Omit<McpServerConfig, 'id'>> {
	const json = JSON.parse(text);
	if (!object(json)) throw new Error('MCP configuration must be a JSON object.');
	const servers = json.mcpServers ?? json.servers ?? json.mcp?.servers ?? json.mcp ?? json;
	if (!object(servers)) {
		throw new Error('Expected {"mcpServers": {...}} or {"servers": {...}}.');
	}
	return Object.entries(servers as Record<string, any>).map(([name, s]) => {
		if (!object(s)) throw new Error(`MCP server "${name}" must be an object.`);
		if (s.type === 'sse' || s.transport === 'sse') throw new Error(`MCP server "${name}" uses legacy SSE. Use its Streamable HTTP endpoint instead.`);
		if (s.type && !['stdio', 'http', 'streamable-http', 'local', 'remote'].includes(s.type)) throw new Error(`Unsupported MCP transport for "${name}".`);
		const isHttp = !!s.url || ['http', 'streamable-http', 'remote'].includes(s.type) || s.transport === 'http';
		const commandArray = Array.isArray(s.command) ? s.command : undefined;
		const command = commandArray ? commandArray[0] : s.command;
		if (!Array.isArray(s.args ?? [])) throw new Error(`MCP server "${name}" needs a string argument array.`);
		const args = [...(commandArray?.slice(1) ?? []), ...(s.args ?? [])];
		if ((!isHttp && (typeof command !== 'string' || !command.trim())) || args.some(a => typeof a !== 'string')) throw new Error(`MCP server "${name}" needs a command and a string argument array.`);
		if (isHttp) {
			let url: URL; try { url = new URL(s.url); } catch { throw new Error(`MCP server "${name}" needs an HTTP(S) URL.`); }
			if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`MCP server "${name}" needs an HTTP(S) URL without embedded credentials.`);
		}
		const record = (value: unknown, field: string): Record<string, string> => {
			if (value === undefined) return {};
			if (!object(value) || Object.values(value).some(v => typeof v !== 'string')) throw new Error(`MCP server "${name}" needs string values in ${field}.`);
			return { ...value };
		};
		return {
			name,
			transport: isHttp ? 'http' : 'stdio',
			command: isHttp ? '' : command,
			args: isHttp ? [] : args,
			env: record(s.env ?? s.environment, 'environment'),
			url: String(s.url ?? ''),
			headers: record(s.headers, 'headers'),
			enabled: s.disabled !== true && s.enabled !== false,
			trusted: false,
			disabledTools: Array.isArray(s.disabledTools) ? s.disabledTools.filter((n: unknown): n is string => typeof n === 'string') : []
		};
	});
}
