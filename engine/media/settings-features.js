(function () {
	'use strict';
	window.SettingsFeatures = { create({ I, S, capabilityHeader, capabilityStats, capabilityTabs, esc, featureHealth, featureItems, featureStatus, h, healthPanel, indexSection, openDialog, post, renderPage, requestFeaturesHealth, since, sw }) {
	const benchmarkProfiles = window.SettingsBenchmarkProfiles.create({ S, esc, post, renderPage });
	function minutesPick(label, setting, options, fallback, enabled) {
		const current = Number(S.settings[setting] || fallback);
		return '<label class="fc-extra">' + esc(label) + '<select class="select" data-setting="' + setting + '" data-num="1"' + (!enabled ? ' disabled' : '') + '>' + options.map(v => '<option value="' + v + '"' + (current === v ? ' selected' : '') + '>' + v + ' min</option>').join('') + '</select></label>';
	}
	function featureCard(definition) {
		const key = definition.key, enabled = !!S.settings[key], status = featureStatus(definition), health = featureHealth(definition);
		const dependencies = (definition.requires || []).filter(k => !S.settings[k]);
		const configure = key === 'computerUse' ? '<button class="link-btn" data-computer-use>Manage app permissions ' + I('chevronRight') + '</button>' : definition.configure && definition.configure !== 'features' ? '<button class="link-btn" data-nav-to="' + esc(definition.configure) + '">Configure ' + I('chevronRight') + '</button>' : '';
		const action = definition.action ? '<button class="btn btn-secondary btn-sm" data-act="feature-' + (definition.action === 'language' ? 'language-connect' : 'plan') + '" data-kind="' + esc(definition.action) + '"' + (!enabled || dependencies.length || S.featureRunning || !S.workspace?.path || S.mode === 'chat' && definition.action !== 'language' ? ' disabled' : '') + '>' + (definition.action === 'language' ? 'Test connection' : 'Preview run') + '</button>' : '';
		const extras = key === 'autoCompact' ? '<label class="fc-extra">Compact at<input type="range" class="range" id="s-compactThreshold" data-setting="compactThreshold" min="50" max="95" step="5" value="' + (S.settings.compactThreshold || 80) + '"' + (!enabled ? ' disabled' : '') + '><b id="compact-val">' + (S.settings.compactThreshold || 80) + '%</b></label><label class="fc-extra">or at most<select class="select" data-setting="compactMaxTokens" data-num="1"' +(!enabled ? ' disabled' : '') + '>' + [[0, 'no token limit'], [100000, '100k tokens'], [200000, '200k tokens'], [300000, '300k tokens'], [500000, '500k tokens']].map(([v, l]) => '<option value="' + v + '"' + (Number(S.settings.compactMaxTokens ?? 200000) === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label>' : key === 'cacheWarm' ? '<label class="fc-extra">Lifetime<select class="select" data-setting="cacheTtl"><option value="5m"' + (S.settings.cacheTtl !== '1h' ? ' selected' : '') + '>5 minutes</option><option value="1h"' + (S.settings.cacheTtl === '1h' ? ' selected' : '') + '>1 hour · higher write cost</option></select></label>' : key === 'skills' ? '<label class="fc-extra">Prompt budget<input type="range" class="range" data-setting="skillCatalogChars" min="2000" max="40000" step="1000" value="' + (S.settings.skillCatalogChars || 12000) + '"' + (!enabled ? ' disabled' : '') + '><b id="skill-budget-val">' + Math.round((S.settings.skillCatalogChars || 12000)/1000) + 'k</b></label>' : key === 'imageGenerate' ? '<label class="fc-extra">Image model<input class="input mono" data-setting="imageGenModel" value="' + esc(S.settings.imageGenModel || '') + '" placeholder="provider/model — empty uses the local Studio"' + (!enabled ? ' disabled' : '') + '></label>' : key === 'agentWatchdog' ? minutesPick('Stalled after', 'watchdogStallMinutes', [5, 10, 20, 30, 60], 10, enabled) : key === 'eventSources' ? minutesPick('Check every', 'eventPollMinutes', [2, 5, 10, 30, 60], 5, enabled) + '<label class="fc-extra"><input type="checkbox" data-setting="eventAutoAct"' + (S.settings.eventAutoAct ? ' checked' : '') + (!enabled ? ' disabled' : '') + '>Hand events to the agent — off, it only records what it would hand over (recall list shows it)</label>' +
				'<label class="fc-extra">Ask it with<input class="input mono" data-setting="eventMention" value="' + esc(S.settings.eventMention ?? '@zer0ne') + '" placeholder="@zer0ne"' + (!enabled ? ' disabled' : '') + '></label>' +
				'<label class="fc-extra">Others who may ask<input class="input mono" data-setting="eventAllowed" value="' + esc(S.settings.eventAllowed || '') + '" placeholder="GitHub logins, comma-separated — you always may"' + (!enabled ? ' disabled' : '') + '></label><label class="fc-extra fc-extra-block">Policy — what to do with a CI failure or a review<textarea class="input" rows="4" data-setting="eventPolicy"' + (!enabled ? ' disabled' : '') + '>' + esc(S.settings.eventPolicy || '') + '</textarea></label>' : '';
		return '<article class="feature-card feature-hub-card' + (enabled ? ' on' : '') + '" data-feature="' + esc(key) + '"><div class="fc-head"><span class="fc-icon">' + I(definition.icon) + '</span><span class="fc-name">' + esc(definition.name) + '</span>' + sw(key) + '</div><div class="feature-card-meta"><span class="feature-state is-' + status.kind + '">' + esc(status.label) + '</span><span>' + esc(definition.scope) + (definition.advanced ? ' · Advanced' : '') + '</span></div><p class="fc-desc">' + esc(definition.description) + '</p>' +
			(dependencies.length ? '<p class="feature-dependency">Requires ' + esc(dependencies.map(k => featureItems().find(f => f.key === k)?.name || (k === 'commandTool' ? 'Terminal commands in Agent settings' : k)).join(', ')) + '</p>' : '') +
			(health && enabled ? '<details data-key="feature-evidence-' + esc(key) + '"><summary>Check details' + (S.health?.stale ? ' · stale' : '') + '</summary><p>' + esc(health.detail) + '</p><small>' + esc(health.evidence || 'Configuration') + ' · ' + esc(since(health.checkedAt || S.health.at)) + '</small></details>' : '') + extras +
			(configure || action ? '<div class="feature-card-actions">' + configure + action + '</div>' : '') + '</article>';
	}
	function featureReports() {
		const section = h('section','feature-reports');
		const reports = (S.featureReports || []).slice().sort((a,b) => b.startedAt-a.startedAt);
		section.innerHTML = '<div class="feature-section-title"><h3>Project runs</h3>' + (S.featureRunning ? '<button class="btn btn-secondary btn-sm" data-act="feature-stop">Stop current run</button>' : '') + '</div>' +
			(!reports.length ? '<div class="empty-state"><b>No project runs yet</b><p>Preview verification, a dependency audit or browser scenarios from Capabilities. Opening this page does not execute them.</p></div>' : reports.map(report => '<details class="feature-report card" data-key="feature-report-' + esc(report.id) + '"><summary><span class="feature-state is-' + (report.status === 'passed' && !report.stale ? 'available' : report.status === 'running' ? 'unknown' : 'problem') + '">' + esc(report.status) + (report.stale ? ' · stale' : '') + '</span><b>' + esc(report.kind) + '</b><span>' + esc(since(report.startedAt)) + '</span></summary><p class="feature-check-note">' + esc(report.scope || '') + ' Snapshot ' + esc(report.fingerprint?.slice(0,12) || 'unavailable') + '</p>' + (report.stages || []).map(stage => '<section class="feature-stage"><h4>' + esc(stage.name) + ' · ' + esc(stage.status) + ' · ' + Math.round(stage.durationMs || 0) + ' ms</h4><code>' + esc(stage.command) + '</code>' +
			(stage.findings?.length ? '<div class="feature-findings">' + stage.findings.map(item => '<p><b>' + esc(item.name) + '</b>' + (item.versions?.length ? ' ' + esc(item.versions.join(', ')) : '') + ' · ' + esc(item.severity) + (item.fixAvailable ? ' · fix available' : '') + '</p>').join('') + '</div>' : '') + '<pre>' + esc(stage.output || '') + '</pre>' + featureFileLinks(stage.output || '') + ((stage.output || '').match(/Screenshot: ([a-f0-9-]{36}-\d+\.jpg)/g) || []).map(line => '<button class="link-btn" data-act="feature-image" data-file="' + esc(line.slice(12)) + '">View screenshot</button>').join('') + '</section>').join('') + '</details>').join(''));
		return section;
	}
	function featureFileLinks(output) {
		const paths = new Set();
		for (const match of output.matchAll(/(?:^|\n)\s*([^\s:()]{1,240}\.(?:[cm]?[jt]sx?|py|rs|go|cs|cpp|c|h|java|vue|svelte))(?:\((\d+),\d+\)|:(\d+)(?::\d+)?)/g)) paths.add(match[1] + ':' + (match[2] || match[3]));
		return [...paths].slice(0,10).map(file => '<button class="link-btn" data-act="feature-file" data-file="' + esc(file) + '">' + esc(file) + '</button>').join(' ');
	}
	function featureLanguagePanel() {
		const panel = h('details','card feature-language'); panel.dataset.key = 'feature-language';
		panel.innerHTML = '<summary>Code intelligence setup & queries</summary><p>Choose an installed local language server (for example typescript-language-server with ["--stdio"], pyright-langserver or rust-analyzer). No server is installed automatically. Its process runs with project access.</p>' +
			'<label class="field-label" for="s-languageServerCommand">Executable</label><input class="input mono" id="s-languageServerCommand" data-setting="languageServerCommand" value="' + esc(S.settings.languageServerCommand || '') + '" placeholder="typescript-language-server"><label class="field-label" for="s-languageServerArgs">Arguments · JSON array</label><input class="input mono" id="s-languageServerArgs" data-setting="languageServerArgs" value="' + esc(S.settings.languageServerArgs || '[]') + '">' +
			'<div class="feature-query"><label>Operation<select class="select" id="feature-language-operation" data-feature-field="featureLanguageOperation">' + ['diagnostics','definition','references','implementation','document_symbols','workspace_symbols','hover'].map(op => '<option' + ((S.featureLanguageOperation || 'diagnostics') === op ? ' selected' : '') + '>' + op + '</option>').join('') + '</select></label><label>Project file<input class="input mono" id="feature-language-path" data-feature-field="featureLanguagePath" value="' + esc(S.featureLanguagePath || '') + '" placeholder="src/index.ts"></label><label>Line<input type="number" min="1" class="input" id="feature-language-line" data-feature-field="featureLanguageLine" value="' + esc(S.featureLanguageLine || 1) + '"></label><label>Character<input type="number" min="1" class="input" id="feature-language-character" data-feature-field="featureLanguageCharacter" value="' + esc(S.featureLanguageCharacter || 1) + '"></label><label>Symbol query<input class="input" id="feature-language-query" data-feature-field="featureLanguageQuery" value="' + esc(S.featureLanguageQuery || '') + '"></label></div><button class="btn btn-secondary btn-sm" data-act="feature-language-query"' + (!S.settings.codeIntelligence || S.featureRunning ? ' disabled' : '') + '>Run read-only query</button>' + (S.featureLanguageResult ? '<pre class="feature-language-output">' + esc(S.featureLanguageResult) + '</pre>' : '');
		return panel;
	}
	// ------------------------------------------------------------ Benchmark

	const benchPct = (n) => Math.round((n || 0) * 100) + '%';
	const benchTokens = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n || 0);
	const benchCost = (s) => !s.cost && !s.costKnown ? '—' : (s.costKnown ? '' : '≥ ') + '$' + (s.cost < 1 ? s.cost.toFixed(3) : s.cost.toFixed(2));
	/** Defects caught of those seeded, plus finished controls accepted: a judge that approves everything fails the first, one that rejects everything the second. */
	const judgeCell = (j) => !j ? '—' : '<span class="bench-score" data-level="' + (j.caught === j.defects && j.controlsPassed === j.controls ? 'good' : j.caught >= j.defects * 0.8 ? 'fair' : 'poor') + '" title="' + j.controlsPassed + ' of ' + j.controls + ' finished records accepted' + (j.unanswered ? ', ' + j.unanswered + ' unanswered' : '') + '">' + j.caught + '/' + j.defects + ' caught</span>';
	function benchModels() {
		return (S.providers || []).filter(p => p.enabled && p.apiFormat !== 'acp' && p.apiFormat !== 'vscode-lm').flatMap(p => (p.models || []).filter(m => m.enabled && m.tools !== false).map(m => ({ spec: p.id + '::' + m.id, label: p.name + ' · ' + (m.name || m.id) })));
	}
	function benchmarkPanel() {
		const wrap = h('div','bench-panel'), b = S.bench;
		if (!S.benchLoaded) { S.benchLoaded = true; post({type:'benchmarkList'}); }
		const cats = Object.entries(b?.categories || {});
		S.benchModels = S.benchModels || new Set(); S.benchCats = S.benchCats || new Set();
		const models = benchModels(), full = S.mode === 'full', r = b?.running;
		const chosen = cats.filter(([c]) => !S.benchCats.size || S.benchCats.has(c)).reduce((n, [, k]) => n + k, 0);
		wrap.innerHTML = '<section class="card bench-intro"><div class="feature-health-heading"><span class="fc-icon">' + I('chart') + '</span><div class="grow"><h3>Agent benchmark</h3><p>' +
			esc((b?.total || 0) + ' coding tasks in ' + cats.length + ' categories: fixing bugs, adding features, refactoring, finding things, staying in scope and using the terminal. Each task runs in a throwaway folder and hidden tests grade the result, so you can see which model works best here.') + '</p></div></div>' +
			'<p class="feature-check-note">Runs use your quota. Inside those folders the agent runs commands without asking, so a run needs Full Access and asks you first.</p>' +
			(r ? '<div class="bench-running" role="status"><div class="bench-bar"><i style="width:' + Math.round((r.done / Math.max(1, r.total)) * 100) + '%"></i></div><span>' + esc(r.model) + ' · ' + r.done + ' of ' + r.total + (r.current ? ' · ' + esc(r.current) : '') + '</span><button class="btn btn-secondary btn-sm" data-act="bench-stop">Stop</button></div>' :
			'<div class="bench-form"><fieldset><legend>Models (up to 4)</legend>' + (models.length ? models.map(m => '<label class="bench-pick"><input type="checkbox" data-bench-model="' + esc(m.spec) + '"' + (S.benchModels.has(m.spec) ? ' checked' : '') + '>' + esc(m.label) + '</label>').join('') : '<p class="page-desc">Add a provider with a model that supports tools.</p>') + '</fieldset>' +
			'<fieldset><legend>Categories</legend>' + cats.map(([c, n]) => '<label class="bench-pick"><input type="checkbox" data-bench-cat="' + esc(c) + '"' + (!S.benchCats.size || S.benchCats.has(c) ? ' checked' : '') + '>' + esc(c) + ' <small>' + n + '</small></label>').join('') + '</fieldset>' +
			benchmarkProfiles.form() + '<div class="bench-actions"><button class="btn btn-primary btn-sm" data-act="bench-run"' + (!full || !S.benchModels.size || S.benchModels.size > 4 || !chosen ? ' disabled' : '') + '>Compare selected tasks' + (S.benchModels.size > 1 ? ' × ' + S.benchModels.size + ' models' : '') + '</button>' +
			(!full ? '<span class="page-desc">Switch this project to Full Access to run the benchmark.</span>' : '') + '</div></div>') +
			(S.benchError ? '<p class="bench-error" role="alert">' + esc(S.benchError) + '</p>' : '') + '</section>';
		const history = b?.history || [];
		const latest = []; const seen = new Set();
		for (const run of history) { const key = JSON.stringify([run.spec, run.suite || 'legacy', run.profile?.id]); if (!seen.has(key)) { seen.add(key); latest.push(run); } }
		latest.sort((x, y) => y.summary.rate - x.summary.rate || x.summary.ms - y.summary.ms);
		const allCats = [...new Set(latest.flatMap(run => Object.keys(run.summary.byCategory || {})))];
		const hasJudge = latest.some(run => run.judge);
		const card = h('section','card bench-scorecard');
		card.innerHTML = '<div class="feature-section-title"><h3>Scorecard</h3>' + (history.length && !r ? '<button class="btn btn-ghost btn-sm" data-act="bench-clear">Clear results</button>' : '') + '</div>' +
			(!latest.length ? '<div class="empty-state"><b>No benchmark runs yet</b><p>Choose models above and run the tasks. The latest run of each model appears here.</p></div>' :
			'<div class="bench-table-wrap"><table class="bench-table"><thead><tr><th>Model</th><th>Score</th>' + allCats.map(c => '<th>' + esc(c) + '</th>').join('') + '<th>Steps</th><th>Time</th><th>Tokens</th><th>Cache</th><th>Cost</th>' + (hasJudge ? '<th title="The goal judge on this model: seeded defects caught, and genuinely finished work accepted">Judge</th>' : '') + '</tr></thead><tbody>' +
			latest.map((run, i) => { const s = run.summary; return '<tr><td><b>' + esc(run.model) + '</b><small>' + esc(run.provider) + ' · ' + esc(since(run.at)) + ' · ' + esc(benchmarkProfiles.label(run)) + (run.stopped ? ' · stopped' : '') + '</small></td><td><span class="bench-score" data-level="' + (s.rate >= 0.8 ? 'good' : s.rate >= 0.5 ? 'fair' : 'poor') + '">' + s.passed + '/' + s.total + ' · ' + benchPct(s.rate) + '</span></td>' +
				allCats.map(c => { const g = s.byCategory?.[c]; return '<td>' + (g ? g.passed + '/' + g.total : '—') + '</td>'; }).join('') +
				'<td>' + s.steps + '</td><td>' + Math.round(s.ms / 1000) + 's</td><td>' + benchTokens(s.tokens.input + s.tokens.output) + '</td><td>' + (s.cacheRate == null ? '—' : benchPct(s.cacheRate)) + '</td><td>' + benchCost(s) + '</td>' + (hasJudge ? '<td>' + judgeCell(run.judge) + '</td>' : '') + '</tr>'; }).join('') + '</tbody></table></div>' +
			history.slice(0, 12).map(run => '<details class="bench-run" data-key="bench-' + esc(run.id) + '"><summary><b>' + esc(run.model) + '</b> · ' + run.summary.passed + '/' + run.summary.total + ' · ' + esc(since(run.at)) + '</summary>' + (run.error ? '<p class="bench-error">' + esc(run.error) + '</p>' : '') + (run.judge?.misses?.length ? '<p class="page-desc">Judge mistakes: ' + run.judge.misses.map(m => esc(m.id) + ' (said ' + esc(m.got) + ')').join(', ') + '</p>' : '') +
				'<ul>' + run.cases.map(c => '<li class="' + (c.pass ? 'pass' : 'fail') + '"><span>' + (c.pass ? '✓' : '✗') + '</span><b>' + esc(c.id) + '</b> <small>' + esc(c.category) + ' · ' + c.steps + ' steps · ' + Math.round(c.ms / 1000) + 's</small>' + (c.failures.length ? '<p>' + esc(c.failures[0]) + '</p>' : '') + '</li>').join('') + '</ul></details>').join(''));
		wrap.appendChild(card);
		const advanced = h('div'); advanced.innerHTML = benchmarkProfiles.settings(); wrap.appendChild(advanced);
		for (const detail of card.querySelectorAll('.bench-run')) { const run = history.find(item => detail.dataset.key === 'bench-' + item.id); if (run) { const metrics = h('div'); metrics.innerHTML = benchmarkProfiles.details(run); detail.insertBefore(metrics, detail.querySelector('ul')); } }
		benchmarkProfiles.bind(wrap);
		for (const input of wrap.querySelectorAll('[data-bench-model]')) input.addEventListener('change', () => { input.checked ? S.benchModels.add(input.dataset.benchModel) : S.benchModels.delete(input.dataset.benchModel); renderPage(); });
		for (const input of wrap.querySelectorAll('[data-bench-cat]')) input.addEventListener('change', () => {
			if (!S.benchCats.size) for (const [c] of cats) S.benchCats.add(c);
			input.checked ? S.benchCats.add(input.dataset.benchCat) : S.benchCats.delete(input.dataset.benchCat);
			if (S.benchCats.size === cats.length) S.benchCats.clear();
			renderPage();
		});
		return wrap;
	}
	function confirmBenchmark() {
		const dialog = openDialog({title:'Run the benchmark?'});
		const cats = S.benchCats.size ? [...S.benchCats] : [];
		const options = benchmarkProfiles.options();
		dialog.body.innerHTML = '<p>Each task runs in its own temporary folder with ' + esc([...S.benchModels].map(spec => benchModels().find(m => m.spec === spec)?.label || spec).join(', ')) + '.</p><p>' + options.trials + ' trials per coding task × ' + options.profiles.length + ' profiles × ' + S.benchModels.size + ' models. Mode: ' + (options.execution === 'production' ? 'Chat engine, including the configured worker workflow' : 'Core tools') + '. Judge records run once per profile.</p><p class="page-desc">The agent runs commands there without approval cards and uses your quota. Your projects are not opened. You can stop at any time; finished tasks are kept.</p>';
		dialog.foot.innerHTML = '<button class="btn btn-ghost" data-cancel>Cancel</button><span class="spacer"></span><button class="btn btn-primary" data-ok>Run benchmark</button>';
		dialog.foot.querySelector('[data-cancel]').addEventListener('click', dialog.close);
		dialog.foot.querySelector('[data-ok]').addEventListener('click', () => { dialog.close(); S.benchError = ''; post({type:'benchmarkStart',approved:true,models:[...S.benchModels],categories:cats,...options}); });
	}
	function featuresPage() {
		const root = h('div','page features-hub'), definitions = featureItems();
		const counts = {on:definitions.filter(f => S.settings[f.key]).length,attention:definitions.filter(f => ['setup','problem'].includes(featureStatus(f).kind)).length};
		root.appendChild(capabilityHeader('Features','zap','Configure capabilities for your project and model. Inspect evidence, then choose when to run execution tests.',''));
		root.appendChild(capabilityStats([[definitions.length,'Capabilities','zap'],[counts.on,'Enabled','check'],[counts.attention,'Need attention','alert'],[(S.featureReports || []).length,'Project runs','terminal']]));
		root.appendChild(h('div','feature-scope',I('folder') + '<span>' + esc(S.featureRoot || S.workspace?.path || 'Current project') + '</span><span class="feature-scope-model">' + esc((S.providers || []).find(p => p.id === S.selection.providerId)?.name || 'No provider') + ' · ' + esc(S.selection.model || 'No model selected') + '</span>'));
		root.appendChild(capabilityTabs([['overview','Overview'],['capabilities','Capabilities'],['checks','Checks & activity'],['benchmark','Benchmark']],S.featureTab || 'overview','data-feature-tab','Features views'));
		if (S.featureTab === 'benchmark') { root.appendChild(benchmarkPanel()); return root; }
		root.appendChild(healthPanel());
		if (!S.featureLoaded) { S.featureLoaded = true; post({type:'featureDashboard'}); }
		if (!S.healthBusy && !S.featureHealthError && (!S.health || S.health.stale || Date.now()-S.health.at > 600000)) requestFeaturesHealth(false);
		if (!S.featureTick) S.featureTick = setInterval(() => { if (S.open && S.section === 'features' && !document.hidden && !S.healthBusy && (!S.health || Date.now()-S.health.at > 600000)) { requestFeaturesHealth(false); renderPage(); } },60000);
		if ((S.featureTab || 'overview') === 'capabilities') {
			const toolbar = h('div','feature-toolbar');
			const results = h('div', 'feature-results');
			const refresh = () => {
				const query = (S.featureQuery || '').trim().toLowerCase(), filter = S.featureFilter || 'all';
				const shown = definitions.filter(f => (!query || (f.name + ' ' + f.description + ' ' + f.group).toLowerCase().includes(query)) && (filter === 'all' || filter === 'enabled' && S.settings[f.key] || filter === 'advanced' && f.advanced || featureStatus(f).kind === filter));
				results.replaceChildren();
				for (const group of [...new Set(shown.map(f => f.group))]) { results.appendChild(h('h3','feature-group-title',esc(group))); results.appendChild(h('div','feature-grid',shown.filter(f => f.group === group).map(featureCard).join(''))); }
				if (!shown.length) results.appendChild(h('div','empty-state','No capabilities match. Try another search or filter.'));
			};
			toolbar.innerHTML = '<label class="feature-search">' + I('search') + '<input class="input" id="feature-search" type="search" placeholder="Search capabilities and tools" value="' + esc(S.featureQuery || '') + '" aria-label="Search features"></label><label>Show<select class="select" id="feature-filter">' + [['all','All'],['enabled','Enabled'],['setup','Needs setup'],['problem','Needs attention'],['advanced','Advanced']].map(([value,label]) => '<option value="' + value + '"' + ((S.featureFilter || 'all') === value ? ' selected' : '') + '>' + label + '</option>').join('') + '</select></label>';
			toolbar.querySelector('#feature-search').addEventListener('input',event => { if (event.isComposing) return; S.featureQuery = event.target.value; refresh(); });
			toolbar.querySelector('#feature-search').addEventListener('compositionend',event => { S.featureQuery = event.target.value; refresh(); });
			toolbar.querySelector('#feature-filter').addEventListener('change',event => { S.featureFilter = event.target.value; refresh(); });
			root.appendChild(toolbar);
			refresh(); root.appendChild(results);
			root.appendChild(featureLanguagePanel());
			const index = h('details','card feature-index-settings'); index.dataset.key = 'feature-index'; index.appendChild(h('summary','','Code index & embeddings')); index.appendChild(indexSection()); root.appendChild(index);
			root.appendChild(h('details','card feature-browser-config','<summary>Browser scenario format</summary><p>Save an array in <code>.zer0ne/browser-checks.json</code>. Supported assertions: text, title, url, selector and no-console-errors. URLs and assertions appear in the review before execution.</p><pre>' + esc(JSON.stringify([{name:'Home page',url:'http://localhost:3000',assertions:[{kind:'text',value:'Welcome'},{kind:'selector',value:'main'}]}],null,2)) + '</pre>'));
		} else if (S.featureTab === 'checks') {
			const results = h('div','feature-check-results');
			results.innerHTML = (S.health?.items || []).map(item => '<details class="card" data-key="health-' + esc(item.id) + '"><summary><b>' + esc(item.label) + '</b><span class="feature-state is-' + (item.state === 'fail' ? 'problem' : item.readiness || 'unknown') + '">' + esc(item.state === 'off' ? 'Off' : item.evidence || 'Configuration') + '</span></summary><p>' + esc(item.detail) + '</p></details>').join(''); root.appendChild(results); root.appendChild(featureReports());
		} else {
			root.appendChild(h('div','feature-overview-copy','<h3>Start with a capability, finish with evidence</h3><p>Enabled settings describe intent. Configuration, discovery, measured usage and a successful execution are shown separately.</p><div class="feature-overview-actions"><button class="btn btn-primary" data-feature-tab="capabilities">Explore capabilities</button><button class="btn btn-secondary" data-feature-tab="checks">View checks & activity</button></div>'));
			const attention = definitions.filter(f => ['setup','problem'].includes(featureStatus(f).kind));
			if (attention.length) root.appendChild(h('div','feature-grid',attention.slice(0,6).map(featureCard).join('')));
			root.appendChild(featureReports());
		}
		return root;
	}
	function reviewFeaturePlan(plan) {
		const dialog = openDialog({title:'Review ' + (plan.kind === 'browser' ? 'browser scenarios' : plan.kind === 'audit' ? 'dependency audit' : 'project verification')});
		dialog.body.innerHTML = '<p>' + esc(plan.root) + '</p><p class="page-desc">' + esc(plan.scope) + '</p><p>Snapshot <code>' + esc(plan.fingerprint.slice(0,12)) + '</code></p><ol>' + plan.stages.map((stage,index) => '<li><b>' + esc(stage.name) + '</b><pre>' + esc(stage.command) + '</pre>' + (plan.scenarios?.[index] ? '<pre>' + esc(JSON.stringify(plan.scenarios[index].assertions,null,2)) + '</pre>' : '') + '</li>').join('') + '</ol><p class="page-desc">' + (plan.kind === 'browser' ? 'This opens the declared URLs in a separate browser profile and saves screenshots.' : plan.kind === 'audit' ? 'This sends dependency metadata to the npm registry. It does not apply fixes.' : 'Project scripts can execute code and write files. The run stops on failure; nothing runs before you approve.') + '</p>';
		dialog.foot.innerHTML = '<button class="btn btn-ghost" data-cancel>Cancel</button><span class="spacer"></span><button class="btn btn-primary" data-ok>Run reviewed plan</button>';
		if (plan.execution) dialog.body.appendChild(h('p','feature-check-note',esc(plan.execution)));
		if (plan.outsideSandbox) dialog.foot.querySelector('[data-ok]').textContent = 'Run outside sandbox';
		dialog.foot.querySelector('[data-cancel]').addEventListener('click',dialog.close);
		dialog.foot.querySelector('[data-ok]').addEventListener('click',() => { dialog.close(); S.featureRunning = plan.id; post({type:'featureRun',id:plan.id,approved:true}); renderPage(); });
	}

	return { featuresPage, reviewFeaturePlan, confirmBenchmark };
	} };
})();
