import * as zlib from 'zlib';

/**
 * Document reading (omp / Claude Code read PDFs; GLM-OCR for scans).
 *
 *  - pdfText: local, dependency-free text extraction — Flate-compressed
 *    content streams, Tj/TJ/'/" text operators, literal and hex strings, and
 *    ToUnicode CMaps (bfchar / bfrange) for CID fonts. Good for PDFs made by
 *    Word, LaTeX, browsers, docs tools; scans have no text layer.
 *  - glmOcr: Z.ai / BigModel GLM-OCR `layout_parsing` for scans and images,
 *    returns Markdown (tables and formulas included).
 */

function streams(pdf: Buffer): Array<{ dict: string; data: Buffer }> {
	const out: Array<{ dict: string; data: Buffer }> = [];
	const text = pdf.toString('latin1');
	const re = /<<((?:[^<>]|<[^<]|>[^>]|<<(?:[^<>]|<[^<]|>[^>])*>>)*)>>\s*stream\r?\n/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		const start = m.index + m[0].length;
		const end = text.indexOf('endstream', start);
		if (end < 0) {
			break;
		}
		let raw = pdf.subarray(start, end);
		// trim the EOL before "endstream"
		if (raw[raw.length - 1] === 0x0a) raw = raw.subarray(0, -1);
		if (raw[raw.length - 1] === 0x0d) raw = raw.subarray(0, -1);
		let data = raw;
		if (/\/FlateDecode/.test(m[1])) {
			try {
				data = zlib.inflateSync(raw);
			} catch {
				try {
					data = zlib.inflateRawSync(raw.subarray(2));
				} catch {
					continue;
				}
			}
		} else if (/\/(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode)/.test(m[1])) {
			continue; // images
		}
		out.push({ dict: m[1], data });
		re.lastIndex = end;
	}
	return out;
}

/** Merge every ToUnicode CMap into one code → text map (good enough for most files). */
function cmaps(all: Array<{ data: Buffer }>): Map<string, string> {
	const map = new Map<string, string>();
	const hexToStr = (h: string) => {
		let s = '';
		for (let i = 0; i + 4 <= h.length; i += 4) {
			s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
		}
		return s;
	};
	for (const { data } of all) {
		const t = data.toString('latin1');
		if (!t.includes('begincmap')) {
			continue;
		}
		for (const block of t.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
			for (const [, src, dst] of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
				map.set(src.toLowerCase(), hexToStr(dst));
			}
		}
		for (const block of t.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
			for (const [, lo, hi, dst] of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
				const a = parseInt(lo, 16);
				const b = Math.min(parseInt(hi, 16), a + 5000);
				const base = parseInt(dst, 16);
				for (let c = a; c <= b; c++) {
					map.set(c.toString(16).padStart(lo.length, '0'), String.fromCharCode(base + (c - a)));
				}
			}
		}
	}
	return map;
}

function literal(s: string): string {
	return s.replace(/\\([nrtbf()\\]|[0-7]{1,3}|\r?\n)/g, (_m, e: string) => {
		if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
		return ({ n: '\n', r: '\r', t: '\t', b: '', f: '', '(': '(', ')': ')', '\\': '\\' } as Record<string, string>)[e] ?? '';
	});
}

function decodeHex(h: string, map: Map<string, string>): string {
	const hex = h.replace(/\s+/g, '').toLowerCase();
	if (map.size) {
		let out = '';
		const width = hex.length % 4 === 0 && [...map.keys()].some((k) => k.length === 4) ? 4 : 2;
		for (let i = 0; i < hex.length; i += width) {
			const code = hex.slice(i, i + width);
			out += map.get(code) ?? (width === 2 ? String.fromCharCode(parseInt(code, 16)) : '');
		}
		return out;
	}
	let out = '';
	for (let i = 0; i + 2 <= hex.length; i += 2) {
		out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
	}
	return out;
}

/** Text of a PDF, one block per page-ish content stream. */
export function pdfText(pdf: Buffer): { text: string; pages: number; streams: number } {
	if (!pdf.subarray(0, 1024).toString('latin1').includes('%PDF')) {
		throw new Error('Not a PDF file.');
	}
	const all = streams(pdf);
	const map = cmaps(all);
	const chunks: string[] = [];
	for (const { data } of all) {
		const t = data.toString('latin1');
		if (!/\bBT\b/.test(t)) {
			continue;
		}
		let out = '';
		const tokens = /\((?:\\.|[^\\)])*\)|<[0-9a-fA-F\s]*>|\[|\]|-?\d*\.?\d+|\/[^\s/<>()[\]]+|[A-Za-z'"*]+/g;
		let pending: string[] = [];
		let inArray = false;
		for (const [tok] of t.matchAll(tokens)) {
			if (tok.startsWith('(')) {
				pending.push(literal(tok.slice(1, -1)));
			} else if (tok.startsWith('<')) {
				pending.push(decodeHex(tok.slice(1, -1), map));
			} else if (tok === '[') {
				inArray = true;
			} else if (tok === ']') {
				inArray = false;
			} else if (inArray && /^-?\d/.test(tok)) {
				if (Number(tok) < -200) pending.push(' '); // big kerning gap = word space
			} else if (tok === 'Tj' || tok === 'TJ') {
				out += pending.join('');
				pending = [];
			} else if (tok === "'" || tok === '"') {
				out += '\n' + pending.join('');
				pending = [];
			} else if (tok === 'Td' || tok === 'TD' || tok === 'T*' || tok === 'Tm') {
				if (out && !out.endsWith('\n') && !out.endsWith(' ')) out += tok === 'Tm' ? ' ' : '\n';
			} else if (tok === 'ET') {
				if (out && !out.endsWith('\n')) out += '\n';
			} else if (!/^-?\d|^\//.test(tok)) {
				pending = [];
			}
		}
		const clean = out.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
		if (clean) {
			chunks.push(clean);
		}
	}
	const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
	return { text: chunks.join('\n\n'), pages, streams: all.length };
}

/** Share of letters/digits/punctuation — low values mean garbage (no usable text layer). */
export function readable(text: string): number {
	if (!text) return 0;
	const good = (text.match(/[\p{L}\p{N}\s.,;:!?'"()\-–—/%$€@#&*+=[\]{}<>]/gu) ?? []).length;
	return good / text.length;
}

export interface OcrTarget {
	url: string;
	apiKey: string;
}

/** GLM-OCR (Z.ai / BigModel) layout parsing → Markdown. */
export async function glmOcr(t: OcrTarget, bytes: Buffer, mime: string, signal?: AbortSignal): Promise<string> {
	const res = await fetch(t.url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.apiKey}` },
		body: JSON.stringify({ model: 'glm-ocr', file: `data:${mime};base64,${bytes.toString('base64')}` }),
		signal: signal ?? AbortSignal.timeout(180_000)
	});
	const body = await res.text();
	if (!res.ok) {
		throw new Error(`GLM-OCR failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
	}
	const json = JSON.parse(body) as { md_results?: string; data?: { md_results?: string }; layout_details?: unknown };
	const md = json.md_results ?? json.data?.md_results;
	if (typeof md !== 'string') {
		throw new Error('GLM-OCR returned no text.');
	}
	return md;
}

/** layout_parsing endpoint for a Z.ai / BigModel provider base URL (coding-plan URLs included). */
export function ocrEndpoint(baseUrl: string): string | undefined {
	try {
		const u = new URL(baseUrl);
		if (/(^|\.)bigmodel\.cn$/i.test(u.hostname)) return 'https://open.bigmodel.cn/api/paas/v4/layout_parsing';
		if (/(^|\.)z\.ai$/i.test(u.hostname)) return 'https://api.z.ai/api/paas/v4/layout_parsing';
	} catch {
		// not a URL
	}
	return undefined;
}
