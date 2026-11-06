import { execFile } from 'child_process';
import type { ChatMessage, FetchedModel, StreamOptions, StreamResult, ToolCall } from './chatClient';
import { anthropicAccumulator, anthropicRequestBody, parseJson, post, readSse } from './chatClient';
import { reasoningHints, reasoningControl } from './reasoning';
import { geminiUsage } from './usage';
import { continuation, nativeItems } from './continuation';

/**
 * Native provider APIs beyond the OpenAI / Anthropic wire formats:
 *
 *  - gemini:  Google AI (generativelanguage) :streamGenerateContent — function
 *             calling with thought signatures, thinking, implicit-cache usage.
 *  - bedrock: AWS Bedrock with a Bedrock API key (Bearer) — Claude through
 *             /invoke-with-response-stream (binary AWS event-stream framing).
 *  - vertex:  Google Vertex AI — Claude (:streamRawPredict) and Gemini
 *             (:streamGenerateContent) with a gcloud access token.
 */

// ---------------------------------------------------------------- Gemini

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function geminiBase(baseUrl: string): string {
	const b = (baseUrl || GEMINI_BASE).trim().replace(/\/+$/, '');
	// A pasted OpenAI-compatible URL (…/v1beta/openai) still works.
	return b.replace(/\/openai$/i, '').replace(/\/models.*$/i, '');
}

const SCHEMA_KEYS = new Set(['type', 'format', 'description', 'nullable', 'enum', 'properties', 'required', 'items', 'minItems', 'maxItems', 'minimum', 'maximum', 'anyOf', 'title', 'minLength', 'maxLength', 'pattern']);

/** JSON Schema → the OpenAPI subset Gemini accepts (drops additionalProperties, $schema, $ref…). */
export function geminiSchema(schema: unknown): unknown {
	if (Array.isArray(schema)) {
		return schema.map(geminiSchema);
	}
	if (!schema || typeof schema !== 'object') {
		return schema;
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
		if (!SCHEMA_KEYS.has(k)) {
			continue;
		}
		if (k === 'properties' && v && typeof v === 'object') {
			out.properties = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([p, s]) => [p, geminiSchema(s)]));
		} else if (k === 'type' && Array.isArray(v)) {
			// ["string","null"] → string + nullable
			const types = v.filter((t) => t !== 'null');
			out.type = types[0] ?? 'string';
			if (types.length !== v.length) {
				out.nullable = true;
			}
		} else if (k === 'enum' && Array.isArray(v)) {
			out.enum = v.map(String);
		} else {
			out[k] = typeof v === 'object' ? geminiSchema(v) : v;
		}
	}
	if (out.type === 'object' && !out.properties) {
		out.properties = {};
	}
	return out;
}

type GeminiPart = Record<string, unknown>;

export function toGeminiContents(messages: ChatMessage[], options?: StreamOptions): Array<{ role: 'user' | 'model'; parts: GeminiPart[] }> {
	const out: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }> = [];
	const push = (role: 'user' | 'model', parts: GeminiPart[]) => {
		if (!parts.length) {
			return;
		}
		const last = out[out.length - 1];
		if (last && last.role === role) {
			last.parts.push(...parts);
		} else {
			out.push({ role, parts });
		}
	};
	for (const m of messages) {
		if (m.role === 'user') {
			push('user', [...(m.images ?? []).map((i) => ({ inlineData: { mimeType: i.mime, data: i.base64 } })), ...(m.content.trim() ? [{ text: m.content }] : [])]);
		} else if (m.role === 'assistant') {
			const native = nativeItems(m, options, 'gemini');
			if (native) { push('model', native); continue; }
			const parts: GeminiPart[] = m.content.trim() ? [{ text: m.content }] : [];
			for (const c of m.toolCalls ?? []) {
				let args: unknown = {};
				try {
					args = JSON.parse(c.arguments || '{}');
				} catch {
					args = {};
				}
				parts.push({ functionCall: { name: c.name, args, ...(c.id.startsWith('gem_') ? {} : { id: c.id }) }, ...(!m.native && c.signature && !c.signature.startsWith('{') ? { thoughtSignature: c.signature } : {}) });
			}
			push('model', parts);
		} else {
			const parts: GeminiPart[] = [{ functionResponse: { name: m.name, ...(m.toolCallId.startsWith('gem_') ? {} : { id: m.toolCallId }), response: { content: m.content || '(empty)' } } }];
			for (const i of m.images ?? []) {
				parts.push({ inlineData: { mimeType: i.mime, data: i.base64 } });
			}
			push('user', parts);
		}
	}
	while (out.length && out[0].role !== 'user') {
		out.shift();
	}
	return out;
}

export function geminiBody(options: StreamOptions): Record<string, unknown> {
	const c = options.reasoningControl ?? reasoningControl(options);
	const responseFormat = options.responseFormat
		? {
				responseMimeType: 'application/json',
				// Gemini constrains the shape itself only with a schema; 'json' mode still forces valid JSON.
				...(options.responseFormat.type === 'schema' ? { responseSchema: geminiSchema(options.responseFormat.schema) } : {})
			}
		: {};
	const body: Record<string, unknown> = {
		contents: toGeminiContents(options.messages, options),
		generationConfig: { maxOutputTokens: options.maxTokens ?? 8192, ...responseFormat, ...(c.protocol.startsWith('gemini-') ? { thinkingConfig: { includeThoughts: !(options.effort === 'none' && c.levels.includes('none')), ...reasoningHints(options) } } : {}) }
	};
	if (options.system) {
		body.systemInstruction = { parts: [{ text: options.system }] };
	}
	if (options.tools?.length) {
		body.tools = [{ functionDeclarations: options.tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters) })) }];
	}
	return body;
}

async function geminiStream(url: string, headers: Record<string, string>, options: StreamOptions): Promise<StreamResult> {
	const response = await post(url, headers, geminiBody(options), options.signal, options.model, options.requestTrace);
	let text = '';
	let reasoning = '';
	let stopReason: string | undefined;
	let usage: StreamResult['usage'];
	const toolCalls: ToolCall[] = [];
	const nativeParts: GeminiPart[] = [];
	const onChunk = (json: any) => {
		options.requestTrace?.event();
		if (json?.error) {
			throw new Error(`Provider error: ${json.error.message ?? JSON.stringify(json.error)}`);
		}
		const chunks = Array.isArray(json) ? json : [json];
		for (const c of chunks) {
			const cand = c?.candidates?.[0];
			for (const part of cand?.content?.parts ?? []) {
				nativeParts.push(part);
				if (part.functionCall) {
					toolCalls.push({
						id: part.functionCall.id || `gem_${toolCalls.length}_${Date.now().toString(36)}`,
						name: part.functionCall.name,
						arguments: JSON.stringify(part.functionCall.args ?? {}),
						signature: part.thoughtSignature
					});
				} else if (typeof part.text === 'string' && part.text) {
					if (part.thought) {
						reasoning += part.text;
						options.onReasoning?.(part.text);
					} else {
						text += part.text;
						options.onText?.(part.text);
					}
				}
			}
			if (cand?.finishReason) {
				stopReason = cand.finishReason === 'MAX_TOKENS' ? 'length' : String(cand.finishReason).toLowerCase();
			}
			const u = c?.usageMetadata;
			if (u) {
				usage = geminiUsage(u, usage);
				options.requestTrace?.usage(usage);
			}
			if (cand?.finishReason === 'SAFETY' && !text && !toolCalls.length) {
				throw new Error('Gemini blocked the answer for safety reasons.');
			}
		}
	};
	await readSse(response, (payload) => {
		const json = parseJson(payload);
		if (json) {
			onChunk(json);
		}
	});
	return { text, reasoning, toolCalls, usage, stopReason, native: continuation(options, 'gemini', nativeParts, text, usage?.output) };
}

export async function streamGemini(options: StreamOptions): Promise<StreamResult> {
	const model = options.model.replace(/^models\//, '');
	return geminiStream(`${geminiBase(options.baseUrl)}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, { 'x-goog-api-key': options.apiKey }, options);
}

// ---------------------------------------------------------------- AWS event-stream (Bedrock)

interface EventMessage {
	headers: Record<string, string>;
	payload: Uint8Array;
}

/**
 * Split an AWS event-stream buffer into complete messages; returns the
 * messages and the unconsumed tail. Frame: total length (4) · headers length
 * (4) · prelude CRC (4) · headers · payload · message CRC (4).
 */
export function decodeEventStream(buf: Uint8Array): { messages: EventMessage[]; rest: Uint8Array } {
	const messages: EventMessage[] = [];
	let off = 0;
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	while (buf.length - off >= 12) {
		const total = view.getUint32(off);
		const headersLen = view.getUint32(off + 4);
		if (total < 16 || buf.length - off < total) {
			break;
		}
		const headers: Record<string, string> = {};
		let h = off + 12;
		const hEnd = h + headersLen;
		while (h < hEnd) {
			const nameLen = buf[h];
			const name = new TextDecoder().decode(buf.subarray(h + 1, h + 1 + nameLen));
			h += 1 + nameLen;
			const type = buf[h];
			h += 1;
			if (type === 7 || type === 6) {
				const len = view.getUint16(h);
				const value = buf.subarray(h + 2, h + 2 + len);
				headers[name] = type === 7 ? new TextDecoder().decode(value) : '';
				h += 2 + len;
			} else {
				// bool true/false (0/1), byte (2), short (3), int (4), long / timestamp (5 / 8), uuid (9)
				h += ({ 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 } as Record<number, number>)[type] ?? 0;
			}
		}
		messages.push({ headers, payload: buf.subarray(hEnd, off + total - 4) });
		off += total;
	}
	return { messages, rest: buf.subarray(off) };
}

function bedrockBase(baseUrl: string): string {
	return (baseUrl || 'https://bedrock-runtime.us-east-1.amazonaws.com').trim().replace(/\/+$/, '');
}

export async function streamBedrock(options: StreamOptions): Promise<StreamResult> {
	const url = `${bedrockBase(options.baseUrl)}/model/${encodeURIComponent(options.model)}/invoke-with-response-stream`;
	const body = { anthropic_version: 'bedrock-2023-05-31', ...anthropicRequestBody(options) };
	const response = await post(url, { Authorization: `Bearer ${options.apiKey}`, Accept: 'application/vnd.amazon.eventstream' }, body, options.signal, options.model, options.requestTrace);
	const acc = anthropicAccumulator(options);
	if (!response.body) {
		throw new Error('Bedrock returned an empty response.');
	}
	const reader = response.body.getReader();
	let pending: Uint8Array = new Uint8Array(0);
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		const joined = new Uint8Array(pending.length + value.length);
		joined.set(pending);
		joined.set(value, pending.length);
		const { messages, rest } = decodeEventStream(joined);
		pending = new Uint8Array(rest);
		for (const m of messages) {
			const payload = new TextDecoder().decode(m.payload);
			if (m.headers[':message-type'] === 'exception' || m.headers[':message-type'] === 'error') {
				const detail = parseJson(payload)?.message ?? payload;
				throw new Error(`Bedrock ${m.headers[':exception-type'] ?? m.headers[':error-code'] ?? 'error'}: ${String(detail).slice(0, 300)}`);
			}
			const wrapper = parseJson(payload);
			if (wrapper?.bytes) {
				const event = parseJson(Buffer.from(wrapper.bytes, 'base64').toString('utf8'));
				if (event) {
					acc.handle(event);
				}
			}
		}
	}
	return acc.result();
}

// ---------------------------------------------------------------- Vertex AI

let gcloudToken: { value: string; until: number } | undefined;

/** An OAuth access token: the pasted one (ya29.…), else `gcloud auth print-access-token`. */
function vertexToken(apiKey: string): Promise<string> {
	if (/^ya29\./.test(apiKey.trim())) {
		return Promise.resolve(apiKey.trim());
	}
	if (gcloudToken && gcloudToken.until > Date.now()) {
		return Promise.resolve(gcloudToken.value);
	}
	return new Promise((resolve, reject) => {
		execFile('gcloud', ['auth', 'print-access-token'], { timeout: 20_000, windowsHide: true, shell: process.platform === 'win32' }, (err, stdout) => {
			const token = String(stdout ?? '').trim();
			if (err || !token) {
				return reject(new Error('Vertex AI needs Google credentials: install the gcloud CLI and run `gcloud auth login` (or paste an access token as the API key).'));
			}
			gcloudToken = { value: token, until: Date.now() + 45 * 60_000 };
			resolve(token);
		});
	});
}

/** https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{region} */
function vertexBase(baseUrl: string): string {
	const b = baseUrl.trim().replace(/\/+$/, '');
	if (!/\/projects\/[^/]+\/locations\/[^/]+$/.test(b)) {
		throw new Error('Vertex base URL must end with /projects/<project>/locations/<region>, e.g. https://us-east5-aiplatform.googleapis.com/v1/projects/my-project/locations/us-east5');
	}
	return b;
}

export async function streamVertex(options: StreamOptions): Promise<StreamResult> {
	const base = vertexBase(options.baseUrl);
	const token = await vertexToken(options.apiKey);
	const auth = { Authorization: `Bearer ${token}` };
	if (/^claude/i.test(options.model)) {
		const url = `${base}/publishers/anthropic/models/${encodeURIComponent(options.model)}:streamRawPredict`;
		const body = { anthropic_version: 'vertex-2023-10-16', ...anthropicRequestBody(options), stream: true };
		const response = await post(url, auth, body, options.signal, options.model, options.requestTrace);
		const acc = anthropicAccumulator(options);
		await readSse(response, (payload) => {
			const json = parseJson(payload);
			if (json) {
				acc.handle(json);
			}
		});
		return acc.result();
	}
	return geminiStream(`${base}/publishers/google/models/${encodeURIComponent(options.model)}:streamGenerateContent?alt=sse`, auth, options);
}

// ---------------------------------------------------------------- model lists

export async function fetchNativeModels(baseUrl: string, apiKey: string, format: 'gemini' | 'bedrock' | 'vertex'): Promise<FetchedModel[]> {
	if (format === 'gemini') {
		const res = await fetch(`${geminiBase(baseUrl)}/models?pageSize=1000`, { headers: { 'x-goog-api-key': apiKey }, signal: AbortSignal.timeout(20_000) });
		if (!res.ok) {
			throw new Error(`Could not list Gemini models (HTTP ${res.status}). Check the API key.`);
		}
		const j = (await res.json()) as { models?: Array<{ name: string; inputTokenLimit?: number; supportedGenerationMethods?: string[] }> };
		return (j.models ?? [])
			.filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
			.map((m) => ({ id: m.name.replace(/^models\//, ''), contextWindow: m.inputTokenLimit }))
			.sort((a, b) => a.id.localeCompare(b.id));
	}
	if (format === 'bedrock') {
		// Cross-region inference profiles for Claude (what invoke needs for newer models).
		const region = /bedrock-runtime\.([a-z0-9-]+)\.amazonaws/.exec(bedrockBase(baseUrl))?.[1] ?? 'us-east-1';
		const res = await fetch(`https://bedrock.${region}.amazonaws.com/inference-profiles?typeEquals=SYSTEM_DEFINED&maxResults=1000`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
		if (res?.ok) {
			const j = (await res.json()) as { inferenceProfileSummaries?: Array<{ inferenceProfileId: string }> };
			const ids = (j.inferenceProfileSummaries ?? []).map((p) => p.inferenceProfileId).filter((id) => id.includes('anthropic.'));
			if (ids.length) {
				return ids.sort().map((id) => ({ id, contextWindow: 200_000 }));
			}
		}
		throw new Error('Could not list Bedrock models with this key — add the model or inference profile ID by hand (e.g. us.anthropic.claude-sonnet-4-5-20250929-v1:0).');
	}
	const base = vertexBase(baseUrl);
	const token = await vertexToken(apiKey);
	const res = await fetch(`${base.replace(/\/projects\/.*$/, '')}/publishers/google/models?pageSize=200`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
	const gem = res?.ok ? (((await res.json()) as { publisherModels?: Array<{ name: string }> }).publisherModels ?? []).map((m) => m.name.split('/').pop()!).filter((id) => id.startsWith('gemini')) : [];
	if (!gem.length) {
		throw new Error('Could not list Vertex models — add model IDs by hand (gemini-2.5-pro, claude-sonnet-4-5@20250929…).');
	}
	return gem.sort().map((id) => ({ id }));
}
