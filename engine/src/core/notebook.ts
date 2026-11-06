/**
 * Jupyter notebooks (.ipynb, nbformat 4) for the agent: read them as
 * numbered cells with their outputs, and edit one cell at a time
 * (replace / insert / delete) without disturbing the rest of the file —
 * the way Claude Code's NotebookEdit works. VS Code-free (core).
 */

interface Output {
	output_type?: string;
	text?: string | string[];
	data?: Record<string, unknown>;
	ename?: string;
	evalue?: string;
	traceback?: string[];
}
interface Cell {
	cell_type: 'code' | 'markdown' | 'raw';
	id?: string;
	source: string | string[];
	outputs?: Output[];
	execution_count?: number | null;
	metadata?: Record<string, unknown>;
}
interface Notebook {
	cells: Cell[];
	metadata?: { kernelspec?: { display_name?: string; language?: string }; language_info?: { name?: string } };
	nbformat?: number;
	nbformat_minor?: number;
}

const join = (s: unknown) => (Array.isArray(s) ? s.join('') : typeof s === 'string' ? s : '');
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function parse(raw: string): Notebook {
	const nb = JSON.parse(raw) as Notebook;
	if (!nb || !Array.isArray(nb.cells)) {
		throw new Error('Not a Jupyter notebook (no "cells" array).');
	}
	return nb;
}

function outputText(o: Output): string {
	if (o.output_type === 'error') {
		return stripAnsi(`${o.ename ?? 'Error'}: ${o.evalue ?? ''}\n${(o.traceback ?? []).slice(-6).join('\n')}`);
	}
	if (o.text) {
		return stripAnsi(join(o.text));
	}
	const data = o.data ?? {};
	if (data['text/plain']) {
		return join(data['text/plain']);
	}
	const kind = Object.keys(data).find((k) => k.startsWith('image/')) ?? Object.keys(data)[0];
	return kind ? `[${kind} output]` : '';
}

/** The notebook as the agent reads it: "## Cell 3 · code · [5] · id abc", source, then output. */
export function renderNotebook(raw: string, maxOutput = 2000): string {
	const nb = parse(raw);
	const lang = nb.metadata?.language_info?.name ?? nb.metadata?.kernelspec?.language ?? 'python';
	const head = `Notebook · ${nb.cells.length} cells · ${nb.metadata?.kernelspec?.display_name ?? lang}. Edit with notebook_edit (cell numbers start at 1).`;
	const cells = nb.cells.map((c, i) => {
		const tag = [`## Cell ${i + 1}`, c.cell_type, c.cell_type === 'code' && c.execution_count != null ? `[${c.execution_count}]` : '', c.id ? `id ${c.id}` : ''].filter(Boolean).join(' · ');
		const source = join(c.source);
		const fence = c.cell_type === 'code' ? '```' + lang : '```' + (c.cell_type === 'markdown' ? 'markdown' : '');
		let out = (c.outputs ?? []).map(outputText).filter(Boolean).join('\n').trimEnd();
		if (out.length > maxOutput) {
			out = out.slice(0, maxOutput) + `\n[… ${out.length - maxOutput} chars of output trimmed]`;
		}
		return `${tag}\n${fence}\n${source}\n\`\`\`${out ? `\nOutput:\n${out}` : ''}`;
	});
	return [head, ...cells].join('\n\n');
}

export interface NotebookEdit {
	/** 1-based cell number. For insert: the new cell goes at this position (cells.length + 1 appends). */
	cell: number;
	mode: 'replace' | 'insert' | 'delete';
	source?: string;
	cell_type?: 'code' | 'markdown';
}

/** Apply one cell edit; returns the new file text (original indentation kept) and a summary. */
export function editNotebook(raw: string, edit: NotebookEdit): { text: string; summary: string; before: string; after: string } {
	const nb = parse(raw);
	const n = nb.cells.length;
	const i = Math.floor(Number(edit.cell)) - 1;
	const indent = /^\{\s*\n( +|\t)"/.exec(raw)?.[1] ?? ' ';
	const lines = (s: string) => (s ? s.split(/(?<=\n)/) : []);
	let before = '';
	let after = '';
	if (edit.mode === 'insert') {
		if (i < 0 || i > n) {
			throw new Error(`Insert position must be 1…${n + 1}.`);
		}
		const type = edit.cell_type ?? 'code';
		const cell: Cell = type === 'code' ? { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: lines(edit.source ?? '') } : { cell_type: 'markdown', metadata: {}, source: lines(edit.source ?? '') };
		if ((nb.nbformat ?? 4) >= 4 && (nb.nbformat_minor ?? 0) >= 5) {
			cell.id = Math.random().toString(16).slice(2, 10);
		}
		nb.cells.splice(i, 0, cell);
		after = edit.source ?? '';
	} else {
		if (i < 0 || i >= n) {
			throw new Error(`No cell ${edit.cell} — the notebook has ${n} cells.`);
		}
		before = join(nb.cells[i].source);
		if (edit.mode === 'delete') {
			nb.cells.splice(i, 1);
		} else {
			const cell = nb.cells[i];
			const type = edit.cell_type ?? cell.cell_type;
			cell.source = lines(edit.source ?? '');
			if (type !== cell.cell_type) {
				cell.cell_type = type;
				if (type === 'markdown') {
					delete cell.outputs;
					delete cell.execution_count;
				} else {
					cell.outputs = [];
					cell.execution_count = null;
				}
			} else if (type === 'code') {
				// Old outputs belong to the old code.
				cell.outputs = [];
				cell.execution_count = null;
			}
			after = edit.source ?? '';
		}
	}
	const summary = edit.mode === 'insert' ? `inserted ${edit.cell_type ?? 'code'} cell ${edit.cell}` : edit.mode === 'delete' ? `deleted cell ${edit.cell}` : `replaced cell ${edit.cell}`;
	return { text: JSON.stringify(nb, null, indent) + (raw.endsWith('\n') ? '\n' : ''), summary, before, after };
}
