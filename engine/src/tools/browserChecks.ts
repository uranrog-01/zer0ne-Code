import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { BrowserAgent } from './browser';
import { projectFile } from './projectChecks';
import type { ProjectReport, StageResult } from './projectChecks';
import { redactSecrets } from './redact';

export interface BrowserScenario { name: string; url: string; assertions: Array<{kind:'text'|'title'|'url'|'selector'|'no-console-errors'; value:string}>; }
export function browserScenarios(root: string, deny = ''): BrowserScenario[] {
	const file = projectFile(root,'.zer0ne/browser-checks.json',deny);
	if (fs.statSync(file).size > 128000) throw new Error('Browser checks configuration exceeds 128 KiB.');
	const raw = JSON.parse(fs.readFileSync(file,'utf8'));
	if (!Array.isArray(raw) || !raw.length || raw.length > 20) throw new Error('Browser checks must be an array of 1–20 scenarios.');
	return raw.map(s => {
		if (!s || typeof s.name !== 'string' || !s.name.trim() || s.name.length > 120 || typeof s.url !== 'string' || s.url.length > 2048 || !/^https?:\/\//.test(s.url)) throw new Error('Each browser scenario needs a name and an HTTP(S) URL.');
		const url = new URL(s.url); if (url.username || url.password) throw new Error('Browser check URLs cannot contain credentials.');
		if (!Array.isArray(s.assertions) || !s.assertions.length || s.assertions.length > 20) throw new Error('Each scenario needs 1–20 assertions.');
		return {name:s.name,url:url.href,assertions:s.assertions.map((a: any) => {
			if (!a || !['text','title','url','selector','no-console-errors'].includes(a.kind) || typeof a.value !== 'string' || a.value.length > 2000 || (a.kind !== 'no-console-errors' && !a.value)) throw new Error('Use supported browser assertions with a bounded string value.');
			return {kind:a.kind,value:a.value};
		})};
	});
}

export async function runBrowserScenarios(scenarios: BrowserScenario[], report: ProjectReport, storage: string, options: {path:string;headless:boolean}, signal: AbortSignal, update: (report:ProjectReport) => void): Promise<void> {
	const browser = new BrowserAgent(path.join(storage,'regression-browser',createHash('sha256').update(report.root).digest('hex').slice(0,20)),() => options);
	const stop = () => { void browser.close(true); };
	signal.addEventListener('abort',stop,{once:true});
	try {
		for (const scenario of scenarios) {
			signal.throwIfAborted(); const started = Date.now();
			let output = '', status: StageResult['status'] = 'passed';
			try {
				browser.consoleLogs(true);
				await browser.navigate(scenario.url);
				for (const assertion of scenario.assertions) {
					signal.throwIfAborted();
					if (assertion.kind === 'text') await browser.waitFor({text:assertion.value,seconds:5},signal);
					else if (assertion.kind === 'no-console-errors') { const errors = browser.consoleLogs(false).split('\n').filter(line => /^\[(console\.error|uncaught)\]/i.test(line)); if (errors.length) throw new Error(errors.join('\n')); }
					else {
						const expression = assertion.kind === 'selector' ? `Boolean(document.querySelector(${JSON.stringify(assertion.value)}))` : `${assertion.kind === 'title' ? 'document.title' : 'location.href'}.includes(${JSON.stringify(assertion.value)})`;
						const result = await browser.evaluate(expression);
						if (result.trim() !== 'true') throw new Error(`Assertion failed: ${assertion.kind} ${assertion.value}`);
					}
					output += `Passed: ${assertion.kind} ${assertion.value}\n`;
				}
			} catch (error) { status = signal.aborted ? 'cancelled' : 'failed'; output += String((error as Error).message); }
			if (!signal.aborted) {
				try { const snap = await browser.snapshot(true); if (snap.screenshot) { fs.mkdirSync(path.join(storage,'feature-shots'),{recursive:true}); const file = `${report.id}-${report.stages.length}.jpg`; fs.writeFileSync(path.join(storage,'feature-shots',file),Buffer.from(snap.screenshot,'base64')); output += `\nScreenshot: ${file}`; } }
				catch (error) { output += '\nScreenshot unavailable: '+String((error as Error).message); }
			}
			report.stages.push({name:scenario.name,command:scenario.url,status,output:redactSecrets(output).text.slice(0,64000),durationMs:Date.now()-started});
			update(report);
			if (signal.aborted) signal.throwIfAborted();
		}
	} finally { signal.removeEventListener('abort',stop); await browser.close(true); }
}
