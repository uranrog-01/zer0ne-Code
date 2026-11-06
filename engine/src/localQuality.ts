/**
 * The quality test (Settings → Local models → My models): 40 short questions in five skills,
 * each with one answer a program can recognise. The model may reason first; what is marked
 * is its final line. The test is small on purpose (a few minutes on a laptop): it ranks the
 * models on this computer and shows what a heavy quantisation costs. It does not replace
 * the large public benchmarks.
 *
 * Models Fit Studio asks the same questions and marks them the same way (its
 * Core/QualityQuestions.cs); test/fixtures/quality-cases.json holds both to it, so a score
 * means the same in either app. No vscode dependency (tested with a mock server).
 */

export type AnswerKind = 'number' | 'word' | 'choice' | 'exact' | 'exactCase' | 'list';
export interface QualityQuestion { skill: string; prompt: string; answer: string; kind: AnswerKind }

/** Added to every question. An example line ("Answer: …") gets copied by small models; this wording does not. */
export const QUALITY_ENDING = "\n\nThink it through, then end with a short last line that begins with \"Final answer:\".";

export const QUALITY_QUESTIONS: ReadonlyArray<QualityQuestion> = ([
	["Reasoning", "Alice is older than Bob. Carol is younger than Bob. Dave is older than Alice. Who is the second oldest?", "Alice", "word"],
	["Reasoning", "All bloops are razzies. All razzies are lazzies. Is every bloop a lazzie? Yes or no.", "yes", "word"],
	["Reasoning", "A farm has chickens and cows. Together they have 10 heads and 28 legs. How many cows are there?", "4", "number"],
	["Reasoning", "What is the next number in the sequence: 2, 6, 12, 20, 30, ?", "42", "number"],
	["Reasoning", "Anna's mother has three daughters. Two of them are named April and May. What is the name of the third daughter?", "Anna", "word"],
	["Reasoning", "A clock shows 3:15. What is the angle in degrees between the hour hand and the minute hand?", "7.5", "number"],
	["Reasoning", "I have 3 boxes. Each box holds 4 bags. Each bag holds 5 marbles. I give away 2 bags. How many marbles do I have left?", "50", "number"],
	["Reasoning", "If yesterday was Thursday, what day is the day after tomorrow?", "Sunday", "word"],
	["Math", "What is 37 times 48?", "1776", "number"],
	["Math", "What is 17 squared minus 13 squared?", "120", "number"],
	["Math", "A recipe needs 3 eggs for 8 pancakes. How many eggs are needed for 40 pancakes?", "15", "number"],
	["Math", "What is the least common multiple of 12 and 18?", "36", "number"],
	["Math", "The average of five numbers is 12. Four of them are 10, 14, 9 and 15. What is the fifth number?", "12", "number"],
	["Math", "A price of 2000 rises by 10% and then falls by 10%. What is the final price?", "1980", "number"],
	["Math", "How many seconds are there in 2.5 hours?", "9000", "number"],
	["Math", "Solve for x: 2(x - 3) + 4 = 3x - 7.", "5", "number"],
	["Knowledge", "Which element has the atomic number 6?\nA) Oxygen\nB) Nitrogen\nC) Carbon\nD) Boron", "C", "choice"],
	["Knowledge", "Which of these is a prime number?\nA) 97\nB) 91\nC) 87\nD) 93", "A", "choice"],
	["Knowledge", "About how long does light take to travel from the Sun to the Earth?\nA) 8 seconds\nB) 8 minutes\nC) 8 hours\nD) 8 days", "B", "choice"],
	["Knowledge", "Which sorting algorithm has an average time complexity of O(n log n)?\nA) Bubble sort\nB) Insertion sort\nC) Selection sort\nD) Merge sort", "D", "choice"],
	["Knowledge", "In which organ of the human body is insulin produced?\nA) Liver\nB) Pancreas\nC) Kidney\nD) Spleen", "B", "choice"],
	["Knowledge", "Which treaty ended the First World War?\nA) Treaty of Versailles\nB) Treaty of Vienna\nC) Treaty of Paris\nD) Treaty of Tordesillas", "A", "choice"],
	["Knowledge", "What does the HTTP status code 404 mean?\nA) Server error\nB) Unauthorized\nC) Moved permanently\nD) Not found", "D", "choice"],
	["Knowledge", "What is the capital of Australia?\nA) Sydney\nB) Melbourne\nC) Canberra\nD) Perth", "C", "choice"],
	["Instructions", "Write the letters of the word \"stream\" in alphabetical order, as one word.", "aemrst", "exact"],
	["Instructions", "Write the word \"planet\" backwards.", "tenalp", "exact"],
	["Instructions", "How many letters are in the word \"elephant\"?", "8", "number"],
	["Instructions", "Sort these numbers from smallest to largest, separated by commas: 42, 7, 19, 3", "3,7,19,42", "list"],
	["Instructions", "Write this in capital letters: quiet river", "QUIET RIVER", "exactCase"],
	["Instructions", "What is the third word of this sentence: The quick brown fox jumps.", "brown", "exact"],
	["Instructions", "How many vowels (a, e, i, o, u) are in the word \"education\"?", "5", "number"],
	["Instructions", "Join the first letter of each word into one word: Big Red Apple Tree", "BRAT", "exact"],
	["Code", "What does this Python code print?\n\ndef f(n):\n    return n * f(n - 1) if n > 1 else 1\n\nprint(f(5))", "120", "number"],
	["Code", "What does this Python code print?\n\nd = {\"a\": 1, \"b\": 2}\nd[\"c\"] = d[\"a\"] + d[\"b\"]\nprint(len(d) + d[\"c\"])", "6", "number"],
	["Code", "What does this Python code print?\n\ncount = 0\nfor i in range(10):\n    if i % 3 == 0:\n        count += 1\nprint(count)", "4", "number"],
	["Code", "What does this Python code print?\n\nx = [3, 1, 2]\ny = x\ny.append(4)\nx.sort()\nprint(y[0] + len(x))", "5", "number"],
	["Code", "What does this Python code print?\n\ndef g(a, b=[]):\n    b.append(a)\n    return len(b)\n\nprint(g(1) + g(2))", "3", "number"],
	["Code", "What does this Python code print?\n\ns = \"hello world\"\nprint(s.split()[1][::-1][:3])", "dlr", "exact"],
	["Code", "What does this JavaScript code print?\n\nconsole.log([10, 9, 1].sort()[1]);", "10", "number"],
	["Code", "What does this Python code print?\n\nprint(sum(i * i for i in range(1, 5)))", "30", "number"]
] as Array<[string, string, string, AnswerKind]>).map(([skill, prompt, answer, kind]) => ({ skill, prompt, answer, kind }));

const strip = (s: string, chars: string) => { let a = 0, b = s.length; while (a < b && chars.includes(s[a])) a++; while (b > a && chars.includes(s[b - 1])) b--; return s.slice(a, b); };

/**
 * What the model settled on: the text after the last "answer" marker, else its last line.
 * Thinking written in tags, code fences and markdown decoration are set aside first.
 */
export function finalAnswer(reply: string | undefined): string {
	let text = (reply ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '');
	// A reply cut off inside its thinking has no answer at all.
	const open = text.toLowerCase().lastIndexOf('<think>');
	if (open >= 0) text = text.slice(0, open);
	const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && !/^[`$#*\-\s]*(python|js|javascript|text)?$/i.test(l));
	if (!lines.length) return '';
	for (let i = lines.length - 1; i >= 0; i--) {
		const m = /^.*\banswer\b\s*(?:is)?\s*[:：]?\s*(.*)$/i.exec(lines[i]);
		if (!m) continue;
		const rest = strip(m[1], ' *`$');
		if (rest.length) return rest;
		if (i + 1 < lines.length) return lines[i + 1]; // "Final answer:" with the answer on the next line
	}
	return lines[lines.length - 1];
}

/** The model's final answer is the right one. */
export function gradeAnswer(q: Pick<QualityQuestion, 'answer' | 'kind'>, reply: string | undefined): boolean {
	const text = finalAnswer(reply);
	if (!text.length) return false;
	const has = (w: string) => new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(text);
	switch (q.kind) {
		case 'number': {
			const nums = text.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/g);
			return !!nums && Math.abs(Number(nums[nums.length - 1]) - Number(q.answer)) < 1e-6;
		}
		case 'word':
			if (q.answer.toLowerCase() === 'yes') return has('yes') && !has('no');
			if (q.answer.toLowerCase() === 'no') return has('no') && !has('yes');
			return has(q.answer);
		case 'choice': {
			// "B", "B)", "B) Mercury", "**B**": the first letter that stands alone.
			const m = /(?<![A-Za-z])([A-Da-d])(?![A-Za-z])/.exec(text);
			return !!m && m[1].toLowerCase() === q.answer.toLowerCase();
		}
		case 'exact': {
			if (text.replace(/[^A-Za-z0-9]/g, '').toLowerCase() === q.answer.toLowerCase()) return true;
			// "The word backwards is tenalp.": the last word is the answer given.
			const words = text.match(/[A-Za-z0-9]+/g);
			return !!words && words[words.length - 1].toLowerCase() === q.answer.toLowerCase();
		}
		case 'exactCase':
			return strip(text, ' "\'.!*`') === q.answer;
		case 'list':
			return (text.match(/-?\d+/g) ?? []).join(',') === q.answer;
		default:
			return false;
	}
}

export interface QualityResult {
	at: number;
	backend?: string;
	/** Share of the questions answered right (0–100). */
	score: number;
	correct: number;
	total: number;
	/** Right answers per skill. */
	parts: Record<string, number>;
	/** Questions per skill. */
	of: Record<string, number>;
	error?: string;
}

/** Room to reason before the final line; the answer is read from the end. */
const REPLY_TOKENS = 320;

/** Ask every question at `base` (…/v1). A question that fails to answer counts as wrong; a server that stops answering ends the test with an error. */
export async function qualityTest(base: string, model: string, o: { apiKey?: string; backend?: string; signal?: AbortSignal; onStage?: (s: string) => void; questions?: ReadonlyArray<QualityQuestion> } = {}): Promise<QualityResult> {
	const questions = o.questions ?? QUALITY_QUESTIONS;
	const result: QualityResult = { at: Date.now(), backend: o.backend, score: 0, correct: 0, total: questions.length, parts: {}, of: {} };
	let failures = 0;
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i];
		result.of[q.skill] = (result.of[q.skill] ?? 0) + 1;
		result.parts[q.skill] ??= 0;
		if (o.signal?.aborted) { result.error = 'Cancelled.'; break; }
		o.onStage?.(`Question ${i + 1} of ${questions.length}…`);
		try {
			const res = await fetch(`${base.replace(/\/+$/, '')}/chat/completions`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...(o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {}) },
				// Hidden "thinking" is switched off: the reasoning is written in the reply, where its length is bounded.
				body: JSON.stringify({ model, stream: false, temperature: 0, seed: 1, max_tokens: REPLY_TOKENS, cache_prompt: false, chat_template_kwargs: { enable_thinking: false }, messages: [{ role: 'user', content: q.prompt + QUALITY_ENDING }] }),
				signal: o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000)
			});
			const text = await res.text();
			if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
			const reply = (JSON.parse(text) as { choices?: Array<{ message?: { content?: string | null } }> }).choices?.[0]?.message?.content ?? '';
			failures = 0;
			if (gradeAnswer(q, reply)) { result.correct++; result.parts[q.skill]++; }
		} catch (e) {
			if (o.signal?.aborted) { result.error = 'Cancelled.'; break; }
			// Three questions in a row without an answer: the server is gone, and a score would be a lie.
			if (++failures >= 3) { result.error = e instanceof Error ? e.message : String(e); break; }
		}
	}
	result.score = Math.round((100 * result.correct) / Math.max(1, questions.length));
	return result;
}
