import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { pdfText } from './documents';

/**
 * Project index for "where is X handled?" and project-knowledge questions.
 *
 *  - Always: a local BM25 keyword index over code and documentation chunks
 *    (identifiers are split: camelCase / snake_case / paths). No network, no
 *    cost.
 *  - Optional: embeddings from an OpenAI-compatible `/embeddings` endpoint
 *    for search by meaning; results are merged with BM25 (reciprocal rank
 *    fusion).
 * Documentation (Markdown, plain text, reStructuredText, AsciiDoc, Org,
 * LaTeX, CSV and PDF text layers) is indexed too, so specs, ADRs and READMEs
 * join the same persistent index as the code. The index is stored per
 * workspace and refreshed incrementally: only files whose size/mtime changed
 * are re-chunked (and re-embedded).
 */

export interface Chunk {
	file: string;
	start: number;
	end: number;
	text: string;
	terms: Record<string, number>;
	len: number;
	vec?: string; // base64 Float32Array
}

interface IndexData {
	version: number;
	files: Record<string, { size: number; mtime: number }>;
	chunks: Chunk[];
	embedModel?: string;
}

export interface EmbedTarget {
	baseUrl: string;
	apiKey: string;
	model: string;
	/** Task prefixes some embedding models want (nomic-embed: "search_query: " / "search_document: "). */
	queryPrefix?: string;
	docPrefix?: string;
	/** A reranker (llama.cpp /v1/rerank) that re-orders the best hits by reading them against the query. */
	rerank?: { baseUrl: string; model: string };
}

export interface SearchHit {
	file: string;
	start: number;
	end: number;
	score: number;
	preview: string;
	via: string;
	/** Code or project documentation (the caller labels it for the model). */
	kind: 'code' | 'doc';
}

const VERSION = 3;
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|cs|cpp|cc|c|h|hpp|m|mm|swift|rb|php|scala|dart|lua|sh|ps1|sql|vue|svelte|astro|html|css|scss|less|md|mdx|json|yaml|yml|toml|xml|gradle|proto|graphql|tf|ex|exs|erl|clj|hs|ml|r|jl|zig|nim|sol)$/i;
const KNOWLEDGE_EXT = /\.(md|mdx|txt|rst|adoc|org|tex|csv|pdf)$/i;
const MAX_FILES = 6000;
const MAX_FILE_BYTES = 400_000;
const MAX_PDF_BYTES = 2_000_000;
const CHUNK_LINES = 60;

/** True for a documentation file (its hits are labelled `doc`). */
export function isKnowledgeFile(file: string): boolean {
	return KNOWLEDGE_EXT.test(file);
}

function indexable(file: string): boolean {
	return CODE_EXT.test(file) || KNOWLEDGE_EXT.test(file);
}

export function tokenize(text: string): string[] {
	const out: string[] = [];
	for (const raw of text.match(/[A-Za-z_$][A-Za-z0-9_$]*|\d{2,}/g) ?? []) {
		const parts = raw
			.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
			.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
			.split(/[\s_$]+/);
		const whole = raw.toLowerCase();
		if (whole.length >= 2 && whole.length <= 40) {
			out.push(whole);
		}
		if (parts.length > 1) {
			for (const p of parts) {
				const t = p.toLowerCase();
				if (t.length >= 2 && t !== whole) {
					out.push(t);
				}
			}
		}
	}
	return out;
}

/** Split a file into ~60-line chunks, preferring blank lines as boundaries. */
export function chunkFile(file: string, text: string): Array<Pick<Chunk, 'file' | 'start' | 'end' | 'text'>> {
	const lines = text.split(/\r?\n/);
	const out: Array<Pick<Chunk, 'file' | 'start' | 'end' | 'text'>> = [];
	let start = 0;
	while (start < lines.length) {
		let end = Math.min(lines.length, start + CHUNK_LINES);
		if (end < lines.length) {
			for (let k = end; k > start + CHUNK_LINES * 0.6; k--) {
				if (!lines[k - 1].trim()) {
					end = k;
					break;
				}
			}
		}
		const body = lines.slice(start, end).join('\n');
		if (body.trim()) {
			out.push({ file, start: start + 1, end, text: body.slice(0, 6000) });
		}
		start = end;
	}
	return out;
}

function counts(tokens: string[]): Record<string, number> {
	const m: Record<string, number> = {};
	for (const t of tokens) {
		m[t] = (m[t] ?? 0) + 1;
	}
	return m;
}

export class CodeIndex {
	private data?: IndexData;
	private building?: Promise<void>;

	constructor(
		private readonly storeFile: string,
		private readonly root: string,
		private readonly listFiles: () => Promise<string[]>
	) {}

	static fileFor(storageDir: string, root: string): string {
		return path.join(storageDir, 'index', createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 16) + '.json');
	}

	stats(): { files: number; chunks: number; embedded: number } | undefined {
		if (!this.data) {
			this.load();
		}
		return this.data ? { files: Object.keys(this.data.files).length, chunks: this.data.chunks.length, embedded: this.data.chunks.filter((c) => c.vec).length } : undefined;
	}

	private load(): void {
		try {
			const d = JSON.parse(fs.readFileSync(this.storeFile, 'utf8')) as IndexData;
			if (d.version === VERSION) {
				this.data = d;
			}
		} catch {
			// no index yet
		}
	}

	private save(): void {
		if (!this.data) {
			return;
		}
		fs.mkdirSync(path.dirname(this.storeFile), { recursive: true });
		fs.writeFileSync(this.storeFile, JSON.stringify(this.data));
	}

	clear(): void {
		this.data = undefined;
		fs.rmSync(this.storeFile, { force: true });
	}

	/** Bring the index up to date (only changed files are re-read). */
	refresh(embed?: EmbedTarget, signal?: AbortSignal): Promise<void> {
		this.building ??= this.doRefresh(embed, signal).finally(() => (this.building = undefined));
		return this.building;
	}

	private async doRefresh(embed?: EmbedTarget, signal?: AbortSignal): Promise<void> {
		if (!this.data) {
			this.load();
		}
		const data: IndexData = this.data ?? { version: VERSION, files: {}, chunks: [] };
		if (embed && data.embedModel !== embed.model) {
			data.chunks.forEach((c) => delete c.vec); // model changed → re-embed
			data.embedModel = embed.model;
		}
		const listed = (await this.listFiles()).filter(indexable);
		// Documentation survives the file cap even in a large repository.
		const files = [...listed.filter(isKnowledgeFile), ...listed.filter((f) => !isKnowledgeFile(f))].slice(0, MAX_FILES);
		const keep = new Set(files);
		const changed: string[] = [];
		const seen: IndexData['files'] = {};
		for (const f of files) {
			try {
				const st = fs.statSync(path.join(this.root, f));
				if (st.size > (/\.pdf$/i.test(f) ? MAX_PDF_BYTES : MAX_FILE_BYTES)) {
					continue;
				}
				seen[f] = { size: st.size, mtime: Math.round(st.mtimeMs) };
				const prev = data.files[f];
				if (!prev || prev.size !== st.size || prev.mtime !== Math.round(st.mtimeMs)) {
					changed.push(f);
				}
			} catch {
				// vanished
			}
		}
		const drop = new Set([...changed, ...Object.keys(data.files).filter((f) => !keep.has(f) || !seen[f])]);
		data.chunks = data.chunks.filter((c) => !drop.has(c.file));
		for (const f of changed) {
			if (signal?.aborted) {
				break;
			}
			let text: string;
			try {
				const buf = fs.readFileSync(path.join(this.root, f));
				if (/\.pdf$/i.test(f)) {
					// Only the PDF text layer; scans have none and stay out of the index.
					text = pdfText(buf).text.slice(0, 500_000);
				} else {
					if (buf.subarray(0, 4000).includes(0)) {
						continue;
					}
					text = buf.toString('utf8');
				}
			} catch {
				continue;
			}
			if (!text.trim()) {
				continue;
			}
			for (const c of chunkFile(f, text)) {
				const toks = tokenize(`${f} ${c.text}`);
				data.chunks.push({ ...c, terms: counts(toks), len: toks.length });
			}
		}
		data.files = seen;
		if (embed) {
			await this.embedMissing(data, embed, signal);
		}
		this.data = data;
		this.save();
	}

	private async embedMissing(data: IndexData, t: EmbedTarget, signal?: AbortSignal): Promise<void> {
		const todo = data.chunks.filter((c) => !c.vec);
		for (let i = 0; i < todo.length && !signal?.aborted; i += 64) {
			const batch = todo.slice(i, i + 64);
			const vecs = await embedTexts(t, batch.map((c) => `${t.docPrefix ?? ''}${c.file}\n${c.text}`.slice(0, 4000)), signal);
			batch.forEach((c, k) => (c.vec = Buffer.from(new Float32Array(vecs[k]).buffer).toString('base64')));
			if (i % 640 === 0) {
				this.data = data;
				this.save(); // keep progress on big repos
			}
		}
	}

	async search(query: string, limit = 8, embed?: EmbedTarget, signal?: AbortSignal): Promise<SearchHit[]> {
		await this.refresh(embed, signal);
		const data = this.data;
		if (!data || !data.chunks.length) {
			return [];
		}
		// BM25
		const q = [...new Set(tokenize(query))];
		const N = data.chunks.length;
		const avg = data.chunks.reduce((s, c) => s + c.len, 0) / N || 1;
		const df = new Map<string, number>();
		for (const t of q) {
			df.set(t, data.chunks.reduce((n, c) => n + (c.terms[t] ? 1 : 0), 0));
		}
		const k1 = 1.2;
		const b = 0.75;
		const bm = data.chunks
			.map((c, i) => {
				let s = 0;
				for (const t of q) {
					const f = c.terms[t];
					if (!f) {
						continue;
					}
					const n = df.get(t) ?? 0;
					const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
					s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * c.len) / avg)));
				}
				return { i, s };
			})
			.filter((x) => x.s > 0)
			.sort((x, y) => y.s - x.s)
			.slice(0, 50);
		// Embeddings (optional) + reciprocal rank fusion
		const rank = new Map<number, { score: number; via: Set<string> }>();
		const add = (list: Array<{ i: number }>, via: string) =>
			list.forEach((x, r) => {
				const e = rank.get(x.i) ?? { score: 0, via: new Set<string>() };
				e.score += 1 / (60 + r);
				e.via.add(via);
				rank.set(x.i, e);
			});
		add(bm, 'keywords');
		if (embed && data.chunks.some((c) => c.vec)) {
			const [qv] = await embedTexts(embed, [(embed.queryPrefix ?? '') + query], signal);
			const qn = Math.hypot(...qv) || 1;
			const sem = data.chunks
				.map((c, i) => {
					if (!c.vec) {
						return { i, s: -1 };
					}
					// Copy out of Node's shared buffer pool before viewing the bytes as floats.
					const v = new Float32Array(new Uint8Array(Buffer.from(c.vec, 'base64')).buffer);
					let dot = 0;
					let vn = 0;
					for (let k = 0; k < v.length; k++) {
						dot += v[k] * qv[k];
						vn += v[k] * v[k];
					}
					return { i, s: dot / (qn * (Math.sqrt(vn) || 1)) };
				})
				.filter((x) => x.s > 0)
				.sort((x, y) => y.s - x.s)
				.slice(0, 50);
			add(sem, 'meaning');
		}
		let fused = [...rank.entries()].sort((x, y) => y[1].score - x[1].score);
		// Reranker: read the best 24 against the query and put the truly relevant ones first.
		if (embed?.rerank && fused.length > 1) {
			try {
				const top = fused.slice(0, 24);
				const order = await rerankTexts(embed.rerank, query, top.map(([i]) => `${data.chunks[i].file}\n${data.chunks[i].text}`.slice(0, 2000)), signal);
				fused = [...order.map((k) => { top[k][1].via.add('rerank'); return top[k]; }), ...fused.slice(24)];
			} catch {
				/* reranking is a bonus: keep the fused order */
			}
		}
		return fused
			.slice(0, limit)
			.map(([i, e]) => {
				const c = data.chunks[i];
				return { file: c.file, start: c.start, end: c.end, score: Math.round(e.score * 1e4) / 1e4, via: [...e.via].join('+'), kind: isKnowledgeFile(c.file) ? 'doc' : 'code', preview: c.text.split('\n').slice(0, 14).join('\n') };
			});
	}
}

/** POST {baseUrl}/rerank (llama.cpp / Jina format): the documents' indexes, most relevant first. */
export async function rerankTexts(t: { baseUrl: string; model: string }, query: string, documents: string[], signal?: AbortSignal): Promise<number[]> {
	const base = t.baseUrl.trim().replace(/\/+$/, '').replace(/\/rerank$/i, '');
	const res = await fetch(`${base}/rerank`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model: t.model, query, documents, top_n: documents.length }),
		signal: signal ?? AbortSignal.timeout(60_000)
	});
	const body = await res.text();
	if (!res.ok) throw new Error(`Rerank failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
	const json = JSON.parse(body) as { results?: Array<{ index: number; relevance_score?: number; score?: number }> };
	const rows = (json.results ?? []).filter((r) => Number.isInteger(r.index) && r.index >= 0 && r.index < documents.length);
	rows.sort((a, b) => (b.relevance_score ?? b.score ?? 0) - (a.relevance_score ?? a.score ?? 0));
	const seen = new Set<number>();
	const order = rows.map((r) => r.index).filter((i) => !seen.has(i) && seen.add(i));
	// Anything the reranker left out keeps its place after the ranked ones.
	for (let i = 0; i < documents.length; i++) if (!seen.has(i)) order.push(i);
	return order;
}

/** POST {baseUrl}/embeddings (OpenAI format). */
export async function embedTexts(t: EmbedTarget, input: string[], signal?: AbortSignal): Promise<number[][]> {
	const base = t.baseUrl.trim().replace(/\/+$/, '').replace(/\/(chat\/completions|models|embeddings)$/i, '');
	const res = await fetch(`${base}/embeddings`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...(t.apiKey ? { Authorization: `Bearer ${t.apiKey}` } : {}) },
		body: JSON.stringify({ model: t.model, input }),
		signal: signal ?? AbortSignal.timeout(120_000)
	});
	const body = await res.text();
	if (!res.ok) {
		throw new Error(`Embeddings failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
	}
	const json = JSON.parse(body) as { data?: Array<{ embedding: number[]; index?: number }> };
	const rows = (json.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
	if (rows.length !== input.length) {
		throw new Error('The embeddings endpoint returned an unexpected number of vectors.');
	}
	return rows.map((r) => r.embedding);
}
