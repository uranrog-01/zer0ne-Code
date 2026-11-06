(function () {
	'use strict';
	window.SettingsBenchmarkProfiles = { create({ S, esc, post, renderPage }) {
		const labels = { current: 'Current settings', thorough: 'More reasoning · full tools', lean: 'Less reasoning · core tools', strict: 'Strict tool arguments · full tools' };
		function options() { return { execution: S.benchExecution || 'production', trials: S.benchTrials || 3, profiles: S.benchProfiles?.length ? S.benchProfiles : ['current'] }; }
		function form() {
			const o = options();
			return '<fieldset><legend>Comparison</legend><label class="bench-pick">Run with<select class="select" data-bench-execution><option value="production"' + (o.execution === 'production' ? ' selected' : '') + '>Chat engine</option><option value="core"' + (o.execution === 'core' ? ' selected' : '') + '>Core tools only</option></select></label><label class="bench-pick">Trials per task<input class="input" style="width:5em" type="number" min="1" max="10" value="' + o.trials + '" data-bench-trials></label>' + Object.entries(labels).map(([key, label]) => '<label class="bench-pick"><input type="checkbox" data-bench-profile="' + key + '"' + (o.profiles.includes(key) ? ' checked' : '') + '>' + label + '</label>').join('') + '<p class="feature-check-note">Chat engine uses your execution settings and this chat’s worker workflow. External integrations and personal memories are isolated. API-key and local providers are supported. Core mode also supports signed-in accounts. Reasoning levels apply when the model supports them. Every trial adds to quota use.</p></fieldset>';
		}
		function label(run) { return run.profile ? (run.profile.kind === 'production' ? 'Chat engine' : 'Core') + ' · ' + (labels[run.profile.name] || run.profile.name) + ' · ' + (run.trials || 1) + ' trials' : 'Core · earlier version'; }
		function details(run) {
			const m = run.summary.measurement;
			if (!m) return '';
			const ms = value => value == null ? 'unavailable' : (value / 1000).toFixed(2) + 's';
			const eligible = !run.stopped && !run.error && run.profile?.kind === 'production' && run.profile.tools !== 'auto' && run.trials >= 3 && m.cases >= 2 && run.summary.rate >= 0.9 && Date.now() - run.at < 30 * 86400000;
			const downgrades = [...new Set((run.cases || []).flatMap(c => c.metrics?.capabilityDowngrades || []))];
			return '<p class="feature-check-note">' + esc(label(run)) + ' · ' + m.cases + ' tasks · ' + m.samples + ' samples. Typical time ' + ms(m.medianMs) + ' · 95th percentile ' + ms(m.p95Ms) + ' · first text or tool ' + ms(m.firstUsefulMedianMs) + '. Cost per success ' + (m.costPerSuccess == null ? 'unavailable' : '$' + m.costPerSuccess.toFixed(4)) + '.</p><p class="feature-check-note">' + m.requests + ' requests · ' + m.retries + ' retries · ' + m.truncations + ' cutoffs · ' + m.toolFailures + ' tool failures · ' + m.cacheWrites + ' cache-write tokens. Observed warm request time ' + ms(m.warmMedianMs) + ' · cold ' + ms(m.coldMedianMs) + '. Cache reporting available for ' + m.cacheKnown + ' requests. These are observed cache states, not a controlled speed comparison.</p>' + (downgrades.length ? '<p class="bench-error">Provider options not accepted: ' + esc(downgrades.join(', ')) + '</p>' : '') + '<p class="feature-check-note">Repeated tasks can have related results. Compare identical tasks and settings; a small sample does not establish a winner.</p>' + (eligible ? '<button class="btn btn-secondary btn-sm" data-bench-apply="' + esc(run.id) + '">Use this tool profile for this model</button><p class="feature-check-note">Saves only core/full tool selection. Reasoning and cache settings stay under your control. Expires after 30 days or a context-window change.</p>' : '');
		}
		function bind(root) {
			root.querySelector('[data-bench-execution]')?.addEventListener('change', event => { S.benchExecution = event.target.value; });
			root.querySelector('[data-bench-trials]')?.addEventListener('change', event => { S.benchTrials = Math.min(10, Math.max(1, Math.round(Number(event.target.value) || 3))); event.target.value = S.benchTrials; });
			for (const input of root.querySelectorAll('[data-bench-profile]')) input.addEventListener('change', () => { const set = new Set(options().profiles); input.checked ? set.add(input.dataset.benchProfile) : set.delete(input.dataset.benchProfile); S.benchProfiles = set.size ? [...set] : ['current']; renderPage(); });
			for (const button of root.querySelectorAll('[data-bench-apply]')) button.addEventListener('click', () => post({ type: 'benchmarkApplyProfile', id: button.dataset.benchApply }));
		}
		function settings() {
			const select = (key, choices) => '<select class="select" data-setting="' + key + '">' + choices.map(([value, label]) => '<option value="' + value + '"' + (S.settings[key] === value || !S.settings[key] && value === choices[0][0] ? ' selected' : '') + '>' + label + '</option>').join('') + '</select>';
			return '<details class="card"><summary>Advanced model controls</summary><label class="bench-pick">Tool selection' + select('toolProfile', [['auto', 'Automatic · use measured profile when available'], ['full', 'Full tool list'], ['lean', 'Core tool list']]) + '</label><label class="bench-pick">Strict tool arguments' + select('strictTools', [['auto', 'Provider-aware default'], ['on', 'Enable on supported transports'], ['off', 'Disable']]) + '</label><label class="bench-pick">OpenAI prompt cache' + select('openaiCache', [['provider', 'Provider default'], ['implicit', 'Implicit'], ['explicit', 'Explicit system prefix']]) + '</label><label class="bench-pick">OpenAI cache lifetime' + select('openaiCacheTtl', [['30m', '30 minutes'], ['12h', '12 hours · higher write cost']]) + '</label><p class="feature-check-note">OpenAI cache controls apply to supported models on the official API. Cache writes may cost extra. Other providers keep their own cache behavior. Enabling every option does not guarantee better answers; compare the results above.</p></details>';
		}
		return { options, form, label, details, bind, settings };
	} };
})();
