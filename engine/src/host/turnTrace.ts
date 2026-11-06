import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';

/**
 * The turn trace: an append-only JSONL log of one agent turn (start, every
 * model request with its usage, every tool result, verification, outcome).
 * Off by default; on when `ZER0NE_TRACE_DIR` names a folder. Post-hoc "why did
 * it do that" debugging and eval fixtures read these, so one file per turn is
 * kept small and never blocks the turn itself: writes are synchronous but
 * single-line, and everything fails soft.
 *
 * With an OpenTelemetry endpoint (Settings → General → Diagnostics) the same
 * events also leave as one OTLP/HTTP JSON trace per turn, named after the
 * GenAI semantic conventions. Events hold counts, names and timings only —
 * never prompt, reply or file text — so the export carries nothing else.
 */

export const TRACE_ENV = 'ZER0NE_TRACE_DIR';
/** One trace file stops growing here: the oldest events are dropped, not the turn. */
const MAX_FILE_CHARS = 8_000_000;
/** Events kept in memory for the export; a runaway turn keeps its first ones. */
const MAX_EVENTS = 4000;
const EXPORT_TIMEOUT_MS = 5000;

export type TraceEvent =
	| { kind: 'turn_start'; promptChars: number; plan: boolean; model?: string }
	| { kind: 'request'; step: number; providerId?: string; model?: string; input?: number; output?: number; cached?: number; ms?: number; error?: string; stopReason?: string }
	| { kind: 'tool'; step: number; name: string; ms: number; outcome: 'completed' | 'failed' | 'cancelled'; summaryChars: number; startedAt?: number }
	| { kind: 'verify'; command: string; passed: boolean; ms?: number }
	| { kind: 'steer'; chars: number }
	| { kind: 'turn_end'; outcome: 'completed' | 'failed' | 'stopped'; steps: number; tokensIn: number; tokensOut: number };

export type TimedEvent = TraceEvent & { t: number };

export interface TurnTrace {
	write(event: TraceEvent): void;
	/** The turn is over: sends the OTLP export when one is configured. */
	close(): void;
}

export interface TraceExport {
	/** An OTLP/HTTP traces URL, e.g. http://localhost:4318/v1/traces. */
	endpoint: string;
	version?: string;
	post?: (url: string, body: string) => Promise<unknown>;
}

/** The trace for a turn, or undefined when tracing and export are both off. */
export function createTurnTrace(dir: string | undefined, sessionId: string, turnId: string, exporter?: TraceExport): TurnTrace | undefined {
	const root = dir && dir.trim() ? path.resolve(dir.trim()) : process.env[TRACE_ENV];
	const otlp = exporter && otlpUrl(exporter.endpoint) ? exporter : undefined;
	let file: string | undefined;
	if (root && root.trim()) {
		try {
			fs.mkdirSync(root, { recursive: true });
			file = path.join(root, `${safe(sessionId)}-${safe(turnId)}.jsonl`);
		} catch {
			file = undefined;
		}
	}
	if (!file && !otlp) return undefined;
	let chars = 0;
	try {
		chars = file && fs.existsSync(file) ? fs.statSync(file).size : 0;
	} catch {
		/* a fresh file */
	}
	const events: TimedEvent[] = [];
	let closed = false;
	return {
		write(event) {
			const timed = { t: Date.now(), ...event } as TimedEvent;
			if (otlp && events.length < MAX_EVENTS) events.push(timed);
			if (!file || chars >= MAX_FILE_CHARS) return;
			try {
				const line = JSON.stringify(timed) + '\n';
				fs.appendFileSync(file, line, 'utf8');
				chars += line.length;
			} catch {
				/* a full disk never stops the agent */
			}
		},
		close() {
			if (closed || !otlp || !events.length) return;
			closed = true;
			const body = JSON.stringify(toOtlp(events, { sessionId, turnId, version: otlp.version }));
			const post = otlp.post ?? ((url: string, payload: string) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS) }));
			// A collector that is down never fails or slows the turn.
			void Promise.resolve().then(() => post(otlpUrl(otlp.endpoint)!, body)).catch(() => undefined);
		}
	};
}

/** http(s) only; a bare collector address gets the standard traces path. */
export function otlpUrl(endpoint: string | undefined): string | undefined {
	const raw = (endpoint ?? '').trim();
	if (!raw) return undefined;
	try {
		const u = new URL(raw);
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
		if (u.pathname === '/' || u.pathname === '') u.pathname = '/v1/traces';
		return u.toString();
	} catch {
		return undefined;
	}
}

type Attr = { key: string; value: { stringValue: string } | { intValue: string } | { boolValue: boolean } };
const attr = (key: string, value: string | number | boolean | undefined): Attr[] =>
	value === undefined || value === '' ? [] : [{ key, value: typeof value === 'boolean' ? { boolValue: value } : typeof value === 'number' ? { intValue: String(Math.round(value)) } : { stringValue: value } }];
const nanos = (ms: number) => `${Math.round(ms)}000000`;
const spanId = () => randomBytes(8).toString('hex');

/**
 * One turn as an OTLP JSON trace: an `invoke_agent` root span, a `chat` span per model
 * request and an `execute_tool` span per tool (pure apart from span ids; tested).
 */
export function toOtlp(events: TimedEvent[], ids: { sessionId: string; turnId: string; version?: string }): Record<string, unknown> {
	const traceId = createHash('sha256').update(`${ids.sessionId}\0${ids.turnId}`).digest('hex').slice(0, 32);
	const start = events.find((e) => e.kind === 'turn_start') as (TimedEvent & { kind: 'turn_start' }) | undefined;
	const end = [...events].reverse().find((e) => e.kind === 'turn_end') as (TimedEvent & { kind: 'turn_end' }) | undefined;
	const begin = start?.t ?? events[0]!.t, finish = end?.t ?? events.at(-1)!.t;
	const root = spanId();
	const spans: Record<string, unknown>[] = [{
		traceId, spanId: root, name: 'invoke_agent zer0ne', kind: 1, startTimeUnixNano: nanos(begin), endTimeUnixNano: nanos(Math.max(begin, finish)),
		attributes: [
			...attr('gen_ai.operation.name', 'invoke_agent'), ...attr('gen_ai.agent.name', 'zer0ne'), ...attr('gen_ai.conversation.id', ids.sessionId),
			...attr('gen_ai.request.model', start?.model), ...attr('zer0ne.turn.id', ids.turnId), ...attr('zer0ne.turn.plan', start?.plan),
			...attr('zer0ne.turn.steps', end?.steps), ...attr('gen_ai.usage.input_tokens', end?.tokensIn), ...attr('gen_ai.usage.output_tokens', end?.tokensOut), ...attr('zer0ne.turn.outcome', end?.outcome)
		],
		status: { code: end?.outcome === 'failed' ? 2 : 1 }
	}];
	let previous = begin;
	for (const e of events) {
		if (e.kind === 'request') {
			const from = e.ms ? e.t - e.ms : previous;
			spans.push({
				traceId, spanId: spanId(), parentSpanId: root, name: `chat ${e.model ?? ''}`.trim(), kind: 3, startTimeUnixNano: nanos(from), endTimeUnixNano: nanos(e.t),
				attributes: [...attr('gen_ai.operation.name', 'chat'), ...attr('gen_ai.provider.name', e.providerId), ...attr('gen_ai.request.model', e.model), ...attr('gen_ai.usage.input_tokens', e.input), ...attr('gen_ai.usage.output_tokens', e.output), ...attr('zer0ne.usage.cached_tokens', e.cached), ...attr('gen_ai.response.finish_reasons', e.stopReason), ...attr('zer0ne.step', e.step)],
				status: { code: e.error ? 2 : 1 }
			});
			previous = e.t;
		} else if (e.kind === 'tool') {
			const from = e.startedAt ?? e.t - e.ms;
			spans.push({
				traceId, spanId: spanId(), parentSpanId: root, name: `execute_tool ${e.name}`, kind: 1, startTimeUnixNano: nanos(from), endTimeUnixNano: nanos(from + e.ms),
				attributes: [...attr('gen_ai.operation.name', 'execute_tool'), ...attr('gen_ai.tool.name', e.name), ...attr('zer0ne.tool.outcome', e.outcome), ...attr('zer0ne.step', e.step)],
				status: { code: e.outcome === 'failed' ? 2 : 1 }
			});
		}
	}
	return {
		resourceSpans: [{
			resource: { attributes: [...attr('service.name', 'zer0ne-code'), ...attr('service.version', ids.version)] },
			scopeSpans: [{ scope: { name: 'zer0ne.agent' }, spans }]
		}]
	};
}

const safe = (s: string) => s.replace(/[^\w.-]/g, '_').slice(0, 80) || 'turn';
