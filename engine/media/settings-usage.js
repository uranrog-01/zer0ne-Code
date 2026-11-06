(function () {
	'use strict';
	window.SettingsUsage = { create({ $, I, S, esc, fmtTokens, h, persist, post, renderPage }) {
	const SERIES = ['1', '2', '3', '4'];
	const USAGE_PAGE_SIZE = 12;
	function usageSlice(kind, items) {
		const pages = Math.max(1, Math.ceil(items.length / USAGE_PAGE_SIZE));
		const page = Math.min(pages, Math.max(1, S.usagePages[kind] || 1));
		S.usagePages[kind] = page;
		const start = (page - 1) * USAGE_PAGE_SIZE;
		return { kind, page, pages, total: items.length, start, end: Math.min(start + USAGE_PAGE_SIZE, items.length), items: items.slice(start, start + USAGE_PAGE_SIZE) };
	}
	function usagePager(p, label) {
		const button = (page, content, id, attrs) => '<button class="usage-page-btn" id="usage-' + p.kind + '-' + id + '" data-act="usage-page" data-list="' + p.kind + '" data-page="' + page + '" ' + attrs + '>' + content + '</button>';
		const visible = [...new Set([1, p.pages, p.page - 1, p.page, p.page + 1])].filter((n) => n >= 1 && n <= p.pages).sort((a, b) => a - b);
		const numbers = visible.map((n, i) => (i && n - visible[i - 1] > 1 ? '<span class="usage-page-gap" aria-hidden="true">…</span>' : '') + button(n, n, 'page-' + n, 'aria-label="Page ' + n + '"' + (n === p.page ? ' aria-current="page"' : ''))).join('');
		return '<div class="usage-pagination"><span class="usage-page-summary" role="status">' + (p.total ? (p.start + 1) + '–' + p.end : '0') + ' of ' + p.total.toLocaleString() + ' ' + label + '<span class="usage-page-size"> · 12 per page</span></span>' +
			'<nav class="usage-page-controls" aria-label="' + ({ models: 'By model', budgets: 'Budgets', related: 'Related chats' }[p.kind]) + ' pagination">' +
			button(p.page - 1, '<span class="usage-page-prev">' + I('chevronRight') + '</span>', 'prev', 'aria-label="Previous page"' + (p.page === 1 ? ' disabled' : '')) + numbers +
			button(p.page + 1, I('chevronRight'), 'next', 'aria-label="Next page"' + (p.page === p.pages ? ' disabled' : '')) + '</nav></div>';
	}
	function usageSectionHead(id, icon, title, subtitle, count) {
		return '<div class="usage-section-head"><span class="usage-section-icon">' + I(icon) + '</span><div class="usage-section-copy"><h2 id="' + id + '">' + title + '</h2><p>' + subtitle + '</p></div><span class="usage-count">' + count.toLocaleString() + '</span></div>';
	}
	function usageEmpty(icon, title, text) {
		return '<div class="usage-empty"><span>' + I(icon) + '</span><b>' + title + '</b><p>' + text + '</p></div>';
	}
	let usageDetailSequence = 0;
	const usageMoney = (n) => n > 0 && n < 0.01 ? '<$0.01' : '$' + (n || 0).toFixed(2);
	const usageCostKind = (m) => ['estimated', 'free', 'subscription', 'local', 'unknown'].includes(m.costKind) ? m.costKind : m.cost > 0 ? 'estimated' : 'unknown';
	function usageCostCell(m) {
		const kind = usageCostKind(m);
		const labels = { estimated: 'Estimated', free: 'Free', subscription: 'Subscription', local: 'Local', unknown: 'Unknown price' };
		const notes = { estimated: 'Estimated using recorded request rates; older samples use current rates.', free: 'Applicable token prices are confirmed as zero.', subscription: 'Included in a subscription; no per-token bill is estimated.', local: 'Runs locally; no API bill is estimated.', unknown: 'Pricing or complete usage is unavailable; excluded from estimated cost totals.' };
		return '<span class="usage-cost-value">' + esc(kind === 'estimated' ? usageMoney(m.cost) : kind === 'free' && !m.unknownCost ? '$0.00' : '—') + '</span><span class="usage-cost-kind ' + kind + '" title="' + notes[kind] + '">' + (m.unknownCost ? 'Partial estimate · ' + m.unknownCost + ' unknown request(s)' : labels[kind]) + '</span>';
	}
	function usageCacheLabel(t) {
		if (t.cacheUsageKnown === 0) return 'Unknown';
		const pct = (t.cacheRate || 0) * 100;
		if (pct >= 100) return '100%';
		for (let places = 2; places <= 6; places++) {
			const label = pct.toFixed(places);
			if (Number(label) < 100) return label + '%';
		}
		return '<100%';
	}
	function usageItems(kind) {
		if (kind === 'related') return S.usageDetail?.data?.related || [];
		const q = S.usageQuery[kind].trim().toLowerCase();
		const items = (kind === 'models' ? S.usage?.models || [] : S.usage?.limits || []).filter((m) => !q || (kind === 'models' ? m.model + ' ' + m.provider : m.name).toLowerCase().includes(q));
		const name = (m) => kind === 'models' ? m.model + ' ' + m.provider : m.name;
		const remaining = (m) => Math.min(m.weekly.remainingPct, m.fiveHour.remainingPct);
		const value = (m) => kind === 'budgets' ? remaining(m) : S.usageSort.models === 'requests' ? m.requests : S.usageSort.models === 'cached' ? m.tokensCached || 0 : m.tokensIn + m.tokensOut;
		return items.sort((a, b) => {
			if (S.usageSort[kind] === 'name') return name(a).localeCompare(name(b));
			if (kind === 'models' && S.usageSort.models === 'cost') {
				const priced = (m) => ['estimated', 'free'].includes(usageCostKind(m));
				return Number(priced(b)) - Number(priced(a)) || b.cost - a.cost || name(a).localeCompare(name(b));
			}
			return (kind === 'budgets' && S.usageSort.budgets === 'usage' ? value(a) - value(b) : value(b) - value(a)) || name(a).localeCompare(name(b));
		});
	}
	function usageListToolbar(kind) {
		const options = kind === 'models' ? [['tokens', 'Most tokens'], ['requests', 'Most requests'], ['cost', 'Highest cost'], ['cached', 'Most cached tokens'], ['name', 'Model A–Z']] : [['usage', 'Highest usage'], ['remaining', 'Most remaining'], ['name', 'Provider A–Z']];
		return '<div class="usage-list-toolbar"><label class="usage-search">' + I('search') + '<input id="usage-' + kind + '-query" data-usage-query="' + kind + '" value="' + esc(S.usageQuery[kind]) + '" placeholder="' + (kind === 'models' ? 'Search model or provider…' : 'Search providers…') + '" aria-label="' + (kind === 'models' ? 'Search models and providers' : 'Search budget providers') + '"></label>' + (S.usageQuery[kind] ? '<button class="btn btn-ghost btn-sm" data-act="usage-clear" data-list="' + kind + '">Clear</button>' : '') + '<label class="usage-sort">Sort by<select id="usage-' + kind + '-sort" class="select" data-usage-sort="' + kind + '">' + options.map(([v, label]) => '<option value="' + v + '"' + (S.usageSort[kind] === v ? ' selected' : '') + '>' + label + '</option>').join('') + '</select></label></div>';
	}
	function requestUsageDetail(m, focusId) {
		S.usageDetail = { row: m, focusId, requestId: ++usageDetailSequence, data: null };
		S.usagePages.related = 1;
		post({ type: 'getUsageModel', days: S.usageDays, providerId: m.providerId, model: m.model, requestId: S.usageDetail.requestId });
	}
	function activateUsageTab(tab) {
		if (!['overview', 'models', 'budgets'].includes(tab)) return;
		S.usageTab = tab;
		persist();
		renderPage();
		$('s-page').scrollTop = 0;
		$('usage-tab-' + tab)?.focus({ preventScroll: true });
	}
	function usageRangeButtons() {
		return [[1, '24 hours'], [7, '7 days'], [30, '30 days'], [90, '90 days']].map(([d, label]) => '<button id="usage-range-' + d + '" data-act="usage-range" data-days="' + d + '" aria-pressed="' + (S.usageDays === d) + '" class="' + (S.usageDays === d ? 'active' : '') + '">' + label + '</button>').join('');
	}
	function usageModelDetail() {
		const detail = S.usageDetail;
		const m = detail.row;
		const d = detail.data;
		const section = h('section', 'usage-model-detail', '<button id="usage-detail-back" class="btn btn-ghost btn-sm usage-detail-back" data-act="usage-detail-back"><span class="usage-page-prev">' + I('chevronRight') + '</span>All models</button><div class="usage-detail-heading"><div class="usage-card-eyebrow">Model detail</div><h2>' + esc(m.model) + '</h2><p>' + esc(m.provider) + ' · ' + S.usageDays + '-day period</p></div><div class="usage-detail-stats">' + [[fmtTokens(m.tokensIn), 'Input tokens'], [fmtTokens(m.tokensOut), 'Output tokens'], [fmtTokens(m.tokensCached || 0), 'Cached input'], [m.requests.toLocaleString(), 'Requests']].map(([v, label]) => '<div class="usage-detail-stat"><span class="usage-detail-label">' + label + '</span><b>' + v + '</b></div>').join('') + '</div><div class="usage-detail-cost">' + usageCostCell(m) + '<span>Cached input is included in input tokens.</span></div>');
		if (!d) section.appendChild(h('div', 'card chart-empty', '<span class="spinner"></span><span class="usage-loading-label">Loading model details…</span>'));
		else if (d.error) section.appendChild(h('div', 'card usage-empty', '<b>Could not load model details</b><p>' + esc(d.error) + '</p><button class="btn btn-outline btn-sm" data-act="usage-detail-retry">Try again</button>'));
		else {
			const daily = d.daily || [];
			const max = Math.max(1, ...daily.map((r) => r.input + r.output));
			const W = 700, H = 180, left = 42, bottom = 25, height = H - bottom - 10;
			const band = (W - left - 8) / Math.max(1, daily.length);
			let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Daily input, output, and cached tokens">';
			for (let i = 0; i <= 4; i++) {
				const y = H - bottom - height * i / 4;
				svg += '<line class="grid" x1="' + left + '" x2="' + W + '" y1="' + y + '" y2="' + y + '"/><text class="axis-label" text-anchor="end" x="' + (left - 6) + '" y="' + (y + 3) + '">' + fmtTokens(Math.round(max * i / 4)) + '</text>';
			}
			daily.forEach((r, i) => {
				const x = left + band * (i + 0.19), bw = band * 0.62;
				let y = H - bottom;
				svg += '<g><title>' + esc(r.day + ': ' + r.input.toLocaleString() + ' input · ' + r.output.toLocaleString() + ' output · ' + r.cached.toLocaleString() + ' cached') + '</title>';
				const stack = [[Math.max(0, r.input - r.cached), 'detail-input'], [Math.min(r.input, r.cached), 'detail-cached'], [r.output, 'detail-output']].filter(([n]) => n > 0);
				stack.forEach(([n, cls], j) => {
					const bh = (n / max) * height;
					y -= bh;
					const top = y;
					const hh = Math.max(0.6, bh - (j > 0 ? Math.min(1.6, bh * 0.3) : 0));
					if (j === stack.length - 1) {
						const rad = Math.min(4.5, hh / 2, bw / 2);
						svg += '<path class="' + cls + '" d="M' + x + ',' + (top + hh) + 'V' + (top + rad) + 'Q' + x + ',' + top + ' ' + (x + rad) + ',' + top + 'H' + (x + bw - rad) + 'Q' + (x + bw) + ',' + top + ' ' + (x + bw) + ',' + (top + rad) + 'V' + (top + hh) + 'Z"/>';
					} else svg += '<rect class="' + cls + '" x="' + x + '" y="' + top + '" width="' + bw + '" height="' + hh + '"/>';
				});
				svg += '</g>';
				if (i === daily.length - 1 || i % Math.max(1, Math.ceil(daily.length / 6)) === 0) svg += '<text class="axis-label" text-anchor="middle" x="' + (x + bw / 2) + '" y="' + (H - 7) + '">' + esc(new Date(r.day + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })) + '</text>';
			});
			svg += '</svg>';
			section.appendChild(h('section', 'card chart-card usage-chart', '<div class="usage-chart-head"><div class="usage-chart-copy"><div class="usage-card-eyebrow">Breakdown</div><div class="chart-title">Daily usage</div><p>Uncached input, cached input and output per day.</p></div></div><div class="legend"><span><i class="swatch detail-input"></i>Uncached input</span><span><i class="swatch detail-cached"></i>Cached input</span><span><i class="swatch detail-output"></i>Output</span></div><div class="chart usage-detail-chart">' + svg + '</div>'));
			const chats = usageSlice('related', d.related || []);
			section.appendChild(h('section', 'card usage-section usage-related', usageSectionHead('usage-related-title', 'chat', 'Related chats', 'Chats that used this model and provider in the selected period.', chats.total) + (chats.total ? '<div class="usage-related-list">' + chats.items.map((s) => '<button class="usage-related-chat" data-act="usage-open-chat" data-id="' + esc(s.id) + '">' + I('chat') + '<span><b>' + esc(s.title) + '</b><small>' + s.turns + ' matching turn' + (s.turns === 1 ? '' : 's') + ' · ' + esc(new Date(s.updatedAt).toLocaleDateString()) + '</small></span>' + I('chevronRight') + '</button>').join('') + '</div>' : usageEmpty('chat', 'No related chats found', 'Some older usage samples may not have a saved chat.')) + usagePager(chats, 'chats')));
			if (d.relatedTruncated) section.appendChild(h('p', 'usage-budget-note', 'Related chats cover the 300 most recently updated chats in this period.'));
		}
		return section;
	}
	function usageSeries() {
		const totals = {};
		for (const d of S.usage.daily) for (const [m, v] of Object.entries(d.byModel)) totals[m] = (totals[m] || 0) + v;
		const top = Object.entries(totals).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
		const keys = top.slice(0, 4);
		return { keys, hasOther: top.length > keys.length, cls: (m) => (keys.indexOf(m) >= 0 ? SERIES[keys.indexOf(m)] : 'other') };
	}

	function usagePage() {
		const page = h('div', 'page usage-page');
		const windowLabel = S.usageDays === 1 ? '24H' : S.usageDays + 'D';
		const bins = S.usage?.daily?.length || 0;
		page.appendChild(h('header', 'usage-header', '<div class="usage-eyebrow"><span class="usage-mark">' + I('chart') + '</span><span class="usage-eyebrow-text">Analytics</span><span class="usage-window"><span><b>Window</b>' + windowLabel + '</span><i></i><span><b>Bins</b>' + (bins || '—') + '</span><span class="usage-pulse"></span></span></div><div class="usage-heading"><div><h1 class="page-title">Usage stats</h1><p class="page-desc">A clear view of your consumption, costs, and agent activity.</p></div><div class="segmented" role="group" aria-label="Usage period">' + usageRangeButtons() + '</div></div><p class="usage-disclaimer">' + I('info') + '<span>New requests preserve provider-reported usage and recorded rates. Missing usage stays unknown; older samples use current rates. Subscriptions, local models and unknown costs are excluded from API cost totals.</span></p>'));
		page.appendChild(h('div', 'usage-tabbar', '<div class="usage-tabs" role="tablist" aria-label="Usage views">' + [['overview', 'Overview'], ['models', 'By model'], ['budgets', 'Budgets']].map(([id, label]) => '<button id="usage-tab-' + id + '" role="tab" aria-selected="' + (S.usageTab === id) + '" aria-controls="usage-tabpanel" tabindex="' + (S.usageTab === id ? 0 : -1) + '" data-act="usage-tab" data-tab="' + id + '">' + label + '</button>').join('') + '</div><button id="usage-export" class="btn btn-outline btn-sm" data-act="usage-export" title="Export all models for the selected period"' + (S.usageExporting ? ' disabled' : '') + '>' + I('arrowDown') + (S.usageExporting ? 'Exporting…' : 'Export CSV') + '</button>'));
		const requestExport = h('button', 'btn btn-outline btn-sm', I('arrowDown') + 'Export requests');
		requestExport.id = 'usage-export-requests';
		requestExport.dataset.act = 'usage-export-requests';
		requestExport.disabled = S.usageExporting;
		requestExport.title = 'Export individual request usage, timing and context-change diagnostics';
		page.querySelector('.usage-tabbar').appendChild(requestExport);
		const root = h('div', 'usage-panel');
		root.id = 'usage-tabpanel';
		root.setAttribute('role', 'tabpanel');
		root.setAttribute('aria-labelledby', 'usage-tab-' + S.usageTab);
		page.appendChild(root);
		const u = S.usage;
		if (!u || u.days !== S.usageDays) {
			root.appendChild(h('div', 'card chart-empty', '<span class="spinner"></span>'));
			return page;
		}
		const t = u.totals;
		const w = u.workflow || { turns: 0, topTools: [] };
		const money = usageMoney;
		const coverage = t.costCoverage || { estimated: t.cost ? 1 : 0, unknown: t.cost ? 0 : u.models.length };
		const priced = (coverage.estimated || 0) + (coverage.free || 0);
		const costValue = priced ? money(t.cost) : coverage.unknown ? 'Unknown' : coverage.subscription && !coverage.local ? 'Included' : coverage.local && !coverage.subscription ? 'Local' : u.models.length ? '—' : '$0.00';
		const costNote = coverage.unknown ? coverage.unknown.toLocaleString() + ' calls with unknown cost or usage excluded' : coverage.subscription ? 'Subscription fees excluded' : coverage.local ? 'Local models have no API bill' : t.saved ? money(t.saved) + ' saved by the prompt cache' : 'vs ' + (S.usageDays === 1 ? 'the previous 24 hours' : 'the previous period');
		const delta = (now, before) => {
			if (!before) return now ? '<span class="delta new">new</span>' : '';
			const p = Math.round(((now - before) / before) * 100);
			return '<span class="delta ' + (p > 0 ? 'up' : p < 0 ? 'down' : '') + '">' + (p > 0 ? '▲ ' : p < 0 ? '▼ ' : '') + Math.abs(p) + '%</span>';
		};
		const dur = (ms) => (ms >= 3600e3 ? (ms / 3600e3).toFixed(1) + ' h' : ms >= 60e3 ? Math.round(ms / 60e3) + ' min' : Math.round(ms / 1000) + ' s');
		const range = S.usageDays === 1 ? 'the previous 24 hours' : 'the ' + S.usageDays + ' days before';
		if (S.usageTab === 'overview') {
		root.appendChild(
			h(
				'div',
				'usage-kpis',
				[
					['zap', t.tokensLabel, 'Tokens', delta(t.tokens, t.prevTokens), 'vs ' + range],
					['chart', costValue, 'Est. API cost', priced && !coverage.unknown ? delta(t.cost, t.prevCost) : '', costNote],
					['refresh', usageCacheLabel(t), 'Cache hits', '', fmtTokens(t.cached || 0) + ' input tokens reused' + (t.cacheUsageKnown != null ? ' · reported for ' + t.cacheUsageKnown + '/' + t.requests + ' requests' : '')],
					['agent', String(w.turns || 0), 'Agent turns', '', w.turns ? 'avg ' + dur(w.avgTurnMs) + ' · ' + t.requests.toLocaleString() + ' model calls' : t.requests.toLocaleString() + ' model calls'],
					['pencil', '+' + (w.added || 0).toLocaleString(), 'Lines written', '', '−' + (w.removed || 0).toLocaleString() + ' removed · ' + (w.files || 0) + ' files'],
					['activity', dur(w.agentMs || 0), 'Agent time', '', t.activeDays + ' active day' + (t.activeDays === 1 ? '' : 's')]
				]
					.map(([icon, v, l, d, sub]) => '<div class="kpi"><div class="kpi-top"><span class="kpi-icon">' + I(icon) + '</span><span class="kpi-label">' + esc(l) + '</span>' + (d ? '<span class="kpi-delta">' + d + '</span>' : '') + '</div><div class="kpi-value">' + esc(v) + '</div><div class="kpi-sub">' + esc(sub) + '</div></div>')
					.join('')
			)
		);
		// Insights: plain-language tips from the numbers.
		const tips = [];
		if (t.cacheUsageKnown !== 0 && t.requests > 20 && (t.cacheRate || 0) < 0.3) tips.push(['alert', 'Only ' + usageCacheLabel(t) + ' of reported input comes from the prompt cache. Keep <b>Exact history</b> on and avoid switching models mid-chat. Cache prices depend on your provider.']);
		if (t.cacheUsageKnown !== 0 && (t.cacheRate || 0) >= 0.6) tips.push(['check', 'Prompt cache is working well: ' + usageCacheLabel(t) + ' of reported input was reused.']);
		const top = u.models[0];
		if (top && t.cost && top.cost / t.cost > 0.7 && u.models.length > 1) tips.push(['info', '<b>' + esc(top.model) + '</b> is ' + Math.round((top.cost / t.cost) * 100) + '% of the cost. A cheaper model for subagents or as a fallback could cut the bill.']);
		if (w.toolCalls > 20 && w.toolErrors / w.toolCalls > 0.15) tips.push(['alert', Math.round((w.toolErrors / w.toolCalls) * 100) + '% of tool calls failed. Check the verify command and allowlist in Settings → Agent.']);
		if (w.rejected > 3 && w.rejected > w.approved) tips.push(['info', 'You rejected more changes than you approved — try <b>Plan mode</b> first so the agent agrees on the approach before editing.']);
		if (tips.length) root.appendChild(h('div', 'usage-tips', tips.map(([icon, text]) => '<div class="usage-tip usage-tip-' + icon + '">' + I(icon) + '<span>' + text + '</span></div>').join('')));
		const chartCard = h('section', 'card chart-card usage-chart', '<div class="usage-chart-head"><div class="usage-chart-copy"><div class="usage-card-eyebrow">Consumption</div><div class="chart-title">Daily tokens by model</div><p>Each line is one model; hover a day to read the split.</p></div><div class="usage-chart-total"><b>' + esc(t.tokensLabel) + '</b><small>tokens</small></div></div>');
		if (!u.totals.tokens) chartCard.insertAdjacentHTML('beforeend', '<div class="chart-empty usage-chart-empty"><span class="usage-empty-ring"></span><span>No usage in this period yet.</span></div>');
		else {
			const { keys, hasOther } = usageSeries();
			chartCard.insertAdjacentHTML('beforeend', '<div class="legend">' + keys.map((k, i) => '<span><span class="swatch bg-' + SERIES[i] + '"></span>' + esc(k) + '</span>').join('') + (hasOther ? '<span><span class="swatch bg-other"></span>Other</span>' : '') + '</div><div class="chart" id="chart"></div>');
		}
		root.appendChild(chartCard);
		// Workflow: when you work with the agent, and what it does.
		if (u.heat) {
			const max = Math.max(1, ...u.heat.flat());
			const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
			const busiest = u.busiest ? DAYS[u.busiest.day] + ' around ' + String(u.busiest.hour).padStart(2, '0') + ':00' : '';
			const heat =
				'<div class="heat">' +
				u.heat.map((row, d) => '<span class="heat-day">' + DAYS[d] + '</span>' + row.map((v, hr) => '<i class="lv' + (v ? Math.min(4, 1 + Math.floor((v / max) * 4)) : 0) + '" title="' + DAYS[d] + ' ' + hr + ':00 · ' + fmtTokens(v) + ' tokens"></i>').join('')).join('') +
				'<span></span>' + [0, 6, 12, 18].map((hr) => '<span class="heat-hour c' + hr + '">' + String(hr).padStart(2, '0') + '</span>').join('') +
				'</div>';
			const tools = w.topTools || [];
			const tmax = Math.max(1, ...tools.map((x) => x[1]));
			const decided = (w.approved || 0) + (w.rejected || 0);
			root.appendChild(h('div', 'section-label usage-section-label', 'Workflow'));
			root.appendChild(
				h(
					'div',
					'usage-flow',
					'<div class="card flow-card"><div class="usage-card-eyebrow">Rhythm</div><div class="chart-title">When you work</div><p class="usage-card-sub">' + (busiest ? 'Busiest ' + esc(busiest) : 'The hours you spend with the agent') + '</p>' + heat + '</div>' +
						'<div class="card flow-card"><div class="usage-card-eyebrow">Agent</div><div class="chart-title">What the agent does</div><p class="usage-card-sub">' + (w.toolCalls || 0).toLocaleString() + ' tool calls in ' + (w.chats || 0) + ' chat' + (w.chats === 1 ? '' : 's') + '</p>' +
						(tools.length ? '<div class="tool-bars">' + tools.map(([name, n]) => '<div class="tool-bar"><code>' + esc(name) + '</code><span class="tb-track"><span class="tb-fill" data-width="' + Math.round((n / tmax) * 100) + '"></span></span><b>' + n + '</b></div>').join('') + '</div>' : '<div class="chart-empty">No agent activity yet.</div>') +
						'<div class="flow-facts"><span><b>' + (decided ? Math.round(((w.approved || 0) / decided) * 100) + '%' : '—') + '</b> approved</span><span><b>' + (w.auto || 0) + '</b> auto-approved</span><span><b>' + (w.toolCalls ? Math.round(((w.toolErrors || 0) / w.toolCalls) * 100) : 0) + '%</b> tool errors</span><span><b>' + (w.medianTurnMs ? dur(w.medianTurnMs) : '—') + '</b> median turn</span></div></div>'
				)
			);
		}
		}
		if (S.usageTab === 'models' && S.usageDetail) {
			root.appendChild(usageModelDetail());
			return page;
		}
		if (S.usageTab === 'models') {
		const { cls } = usageSeries();
		const models = usageSlice('models', usageItems('models'));
		const keysLine = (m) =>
			m.keys && m.keys.length
				? '<span class="usage-model-keys">Keys: ' + m.keys.map((k) => '#' + (k.index + 1) + ' <code>' + esc(k.hint) + '</code> (' + k.requests.toLocaleString() + ' req' + (k.requests === 1 ? '' : 's') + ')').join(' · ') + (m.keyless ? ' · <em>' + m.keyless.toLocaleString() + ' not recorded</em>' : '') + '</span>'
				: '';
		const modelRows = models.items.map((m) => {
			const share = t.tokens ? Math.max(0, Math.min(100, ((m.tokensIn + m.tokensOut) / t.tokens) * 100)) : 0;
			const index = u.models.indexOf(m);
			return '<tr><td><div class="usage-model-cell"><span class="swatch bg-' + cls(m.model) + '"></span><div><b><button id="usage-model-open-' + index + '" class="usage-model-open" data-act="usage-model-open" data-index="' + index + '" title="View details for ' + esc(m.model) + '">' + esc(m.model) + '</button></b><span class="usage-model-provider">' + esc(m.provider) + '</span><span class="usage-model-share"><span class="usage-share-track"><span class="usage-share-fill bg-' + cls(m.model) + '" data-width="' + share.toFixed(2) + '"></span></span><span>' + share.toFixed(1) + '% of tokens</span></span>' + keysLine(m) + '</div></div></td><td>' + m.requests.toLocaleString() + '</td><td>' + fmtTokens(m.tokensIn) + '</td><td>' + fmtTokens(m.tokensOut) + '</td><td class="usage-model-cost">' + usageCostCell(m) + '</td></tr>';
		}).join('');
		const modelCard = h('section', 'card usage-section usage-models', usageSectionHead('usage-models-title', 'cube', 'By model', 'Select a model to explore its daily usage and related chats.', u.models.length) + usageListToolbar('models') +
			(models.total ? '<div class="usage-table-scroll" data-scroll="usage-models"><table class="data-table usage-model-table" aria-labelledby="usage-models-title"><thead><tr><th scope="col">Model / provider</th><th scope="col">Requests</th><th scope="col">Input tokens</th><th scope="col">Output tokens</th><th scope="col">Cost / billing</th></tr></thead><tbody>' + modelRows + '</tbody></table></div>' : usageEmpty('cube', u.models.length ? 'No matching models' : 'No model usage yet', u.models.length ? 'Try a different model or provider name.' : 'Models will appear here after your first request in this period.')) + usagePager(models, 'models'));
		modelCard.setAttribute('aria-labelledby', 'usage-models-title');
		root.appendChild(modelCard);
		}
		if (S.usageTab === 'budgets') {
		root.appendChild(h('div', 'usage-alert-setting', '<div><label for="s-usageBudgetAlerts">Budget alerts</label><p>Notify at 75%, 90%, and 100% of each rolling token budget.</p></div><label class="switch"><input type="checkbox" id="s-usageBudgetAlerts" data-setting="usageBudgetAlerts" aria-label="Enable budget alerts"' + (S.settings.usageBudgetAlerts ? ' checked' : '') + '><span class="track"></span></label>'));
		const budgets = usageSlice('budgets', usageItems('budgets'));
		const budgetCard = h('section', 'card usage-section usage-budgets', usageSectionHead('usage-budgets-title', 'shield', 'Budgets', 'Rolling token budgets for your enabled providers.', u.limits.length) + usageListToolbar('budgets') +
			(budgets.total ? '<div class="usage-budget-grid">' + budgets.items.map(usageBudgetCard).join('') + '</div>' : usageEmpty('shield', u.limits.length ? 'No matching providers' : 'No provider budgets yet', u.limits.length ? 'Try a different provider name.' : 'Enable a provider in Providers & models to track its token budgets.')) + usagePager(budgets, 'providers'));
		budgetCard.setAttribute('aria-labelledby', 'usage-budgets-title');
		root.appendChild(budgetCard);
		root.appendChild(h('p', 'usage-budget-note', I('info') + '<span>Budgets are soft limits. Adjust them in each provider’s advanced settings. Rolling windows are independent of the period selected above.</span>'));
		}
		return page;
	}

	function usageBudgetCard(l) {
		const remaining = Math.max(0, Math.min(100, Math.min(l.weekly.remainingPct, l.fiveHour.remainingPct)));
		const status = remaining === 0 ? 'bad' : remaining < 20 ? 'warn' : 'good';
		return '<article class="usage-budget-card"><div class="usage-budget-head"><span class="usage-budget-avatar">' + esc(l.name.slice(0, 2).toUpperCase()) + '</span><h3 title="' + esc(l.name) + '">' + esc(l.name) + '</h3><span class="usage-budget-status ' + status + '">' + (status === 'bad' ? 'Exhausted' : status === 'warn' ? 'Running low' : 'On track') + '</span></div>' + budgetWindow('Weekly', l.weekly, l.name) + budgetWindow('5 hours', l.fiveHour, l.name) + '</article>';
	}
	function budgetWindow(label, w, provider) {
		const remaining = Math.max(0, Math.min(100, w.remainingPct));
		const usedPct = 100 - remaining;
		const status = remaining < 5 ? 'bad' : remaining < 20 ? 'warn' : 'good';
		const minutes = Math.max(0, Math.ceil(w.resetsInMs / 60e3));
		const hours = Math.floor(minutes / 60);
		const resets = hours >= 24 ? Math.floor(hours / 24) + 'd ' + (hours % 24) + 'h' : hours ? hours + 'h ' + (minutes % 60) + 'm' : minutes + 'm';
		const pctLabel = remaining > 0 && remaining < 1 ? '<1' : String(Math.round(remaining));
		return '<div class="usage-budget-window"><div class="usage-budget-label"><b>' + label + '</b><span class="' + status + '">' + pctLabel + '% left</span></div><div class="budget-meter" role="progressbar" aria-label="' + esc(provider + ' ' + label + ' token budget used') + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + usedPct.toFixed(1) + '" aria-valuetext="' + w.used.toLocaleString() + ' of ' + w.limit.toLocaleString() + ' tokens used"><span class="budget-fill ' + status + '" data-width="' + usedPct.toFixed(2) + '"></span></div><div class="usage-budget-meta"><span><b>' + fmtTokens(w.used) + '</b> / ' + fmtTokens(w.limit) + ' tokens</span><span>' + I('history') + 'Resets in ' + resets + '</span></div></div>';
	}

	function niceMax(v) {
		if (v <= 0) return 1;
		const p = Math.pow(10, Math.floor(Math.log10(v)));
		for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
		return 10 * p;
	}

	/** Catmull-Rom through the samples, clamped so a curve never dives under the baseline. */
	function usageSmooth(points, top, floor) {
		if (!points.length) return '';
		if (points.length === 1) return 'M' + points[0][0].toFixed(2) + ',' + points[0][1].toFixed(2);
		const clamp = (v) => Math.max(top, Math.min(floor, v));
		let d = 'M' + points[0][0].toFixed(2) + ',' + points[0][1].toFixed(2);
		for (let i = 0; i < points.length - 1; i++) {
			const p0 = points[i - 1] || points[i], p1 = points[i], p2 = points[i + 1], p3 = points[i + 2] || p2;
			const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = clamp(p1[1] + (p2[1] - p0[1]) / 6);
			const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = clamp(p2[1] - (p3[1] - p1[1]) / 6);
			d += 'C' + c1x.toFixed(2) + ',' + c1y.toFixed(2) + ' ' + c2x.toFixed(2) + ',' + c2y.toFixed(2) + ' ' + p2[0].toFixed(2) + ',' + p2[1].toFixed(2);
		}
		return d;
	}

	function drawChart() {
		const host = document.getElementById('chart');
		if (!host || !S.usage) return;
		const { keys, cls } = usageSeries();
		const W = Math.max(280, Math.round(host.clientWidth || 640));
		const H = 216;
		const pad = { l: 46, r: 14, t: 14, b: 26 };
		const plotW = W - pad.l - pad.r;
		const plotH = H - pad.t - pad.b;
		const days = S.usage.daily.map((d) => {
			const segs = {};
			for (const [m, v] of Object.entries(d.byModel)) segs[cls(m)] = (segs[cls(m)] || 0) + v;
			return { day: d.day, segs };
		});
		const order = SERIES.slice(0, keys.length);
		if (days.some((d) => d.segs.other)) order.push('other');
		if (!order.length) order.push('other');
		const n = Math.max(1, days.length);
		const band = plotW / Math.max(1, n - 1);
		const peak = Math.max(1, ...days.flatMap((d) => order.map((k) => d.segs[k] || 0)));
		const max = niceMax(peak);
		const base = pad.t + plotH;
		const x = (i) => pad.l + (n <= 1 ? plotW / 2 : (plotW * i) / (n - 1));
		const y = (v) => base - (v / max) * plotH;
		const every = n > 45 ? 14 : n > 21 ? 7 : n > 10 ? 5 : 1;
		let grid = '', areas = '', glows = '', lines = '', dots = '', hits = '';
		for (let i = 0; i <= 4; i++) {
			const v = (max / 4) * i;
			grid += '<line class="grid" x1="' + pad.l + '" x2="' + (W - pad.r) + '" y1="' + y(v).toFixed(2) + '" y2="' + y(v).toFixed(2) + '"/>';
			grid += '<text class="axis-label axis-y" x="' + (pad.l - 9) + '" y="' + (y(v) + 3).toFixed(2) + '" text-anchor="end">' + fmtTokens(v) + '</text>';
		}
		grid += '<line class="grid grid-base" x1="' + pad.l + '" x2="' + (W - pad.r) + '" y1="' + base + '" y2="' + base + '"/>';
		days.forEach((d, i) => {
			if (n === 1 || i === n - 1 || (n - 1 - i) % every === 0) {
				grid += '<line class="grid grid-v" x1="' + x(i).toFixed(2) + '" x2="' + x(i).toFixed(2) + '" y1="' + pad.t + '" y2="' + base + '"/>';
				const dt = new Date(d.day + 'T00:00:00');
				grid += '<text class="axis-label axis-x" x="' + x(i).toFixed(2) + '" y="' + (H - 7) + '" text-anchor="middle">' + esc(n > 10 ? dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : dt.toLocaleDateString(undefined, { weekday: 'short' })) + '</text>';
			}
			const left = Math.max(pad.l, x(i) - band / 2), right = Math.min(W - pad.r, x(i) + band / 2);
			hits += '<rect class="hit" data-i="' + i + '" x="' + left.toFixed(2) + '" y="' + pad.t + '" width="' + Math.max(1, right - left).toFixed(2) + '" height="' + plotH + '"/>';
		});
		order.forEach((k, si) => {
			const seriesClass = 's-' + k;
			// One bin has no shape to draw: show each series as a level across the plot.
			const value = days[0] ? days[0].segs[k] || 0 : 0;
			const pts = n === 1 ? [[pad.l, y(value)], [W - pad.r, y(value)]] : days.map((d, i) => [x(i), y(d.segs[k] || 0)]);
			const line = usageSmooth(pts, pad.t, base);
			const area = line ? line + 'L' + pts[pts.length - 1][0].toFixed(2) + ',' + base + 'L' + pts[0][0].toFixed(2) + ',' + base + 'Z' : '';
			areas += '<path class="u-area ' + seriesClass + '" d="' + area + '" data-i="' + si + '"/>';
			glows += '<path class="u-glow ' + seriesClass + '" d="' + line + '" data-i="' + si + '"/>';
			lines += '<path class="u-line ' + seriesClass + '" d="' + line + '" pathLength="1" data-i="' + si + '"/>';
			if (n === 1 || si !== order.length - 1) days.forEach((d, i) => {
				if (d.segs[k]) dots += '<circle class="u-dot ' + seriesClass + '" cx="' + x(i).toFixed(2) + '" cy="' + y(d.segs[k]).toFixed(2) + '" r="1.35" data-i="' + si + '"/>';
			});
		});
		const cross = '<g class="u-cross" aria-hidden="true"><line class="u-crossline" x1="0" x2="0" y1="' + pad.t + '" y2="' + base + '"/>' + order.map((k) => '<circle class="u-crossdot s-' + k + '" data-k="' + k + '" r="3.4" cx="0" cy="0"/>').join('') + '</g>';
		const animate = host.dataset.ready ? '' : ' u-animate';
		host.dataset.ready = '1';
		host.innerHTML = '<svg class="' + animate.trim() + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Daily tokens by model">' + grid + '<g class="u-areas">' + areas + '</g><g class="u-glows">' + glows + '</g><g class="u-lines">' + lines + '</g><g class="u-dots">' + dots + '</g>' + cross + '<g class="u-hits">' + hits + '</g></svg><div class="chart-tip popover hidden"></div>';
		const svg = host.querySelector('svg');
		// The series index is a custom property for the staggered draw: the page's CSP allows
		// no inline style attributes, so it is set from the markup's data attribute.
		for (const el of svg.querySelectorAll('[data-i]')) el.style.setProperty('--i', el.getAttribute('data-i'));
		const tip = host.querySelector('.chart-tip');
		const crossEl = host.querySelector('.u-cross');
		const crossLine = crossEl.querySelector('.u-crossline');
		const crossDots = [...crossEl.querySelectorAll('.u-crossdot')];
		const names = { other: 'Other' };
		keys.forEach((k, i) => (names[SERIES[i]] = k));
		const hide = () => { tip.classList.add('hidden'); crossEl.classList.remove('on'); };
		svg.addEventListener('mousemove', (event) => {
			const rect = svg.getBoundingClientRect();
			const px = ((event.clientX - rect.left) / rect.width) * W;
			const i = Math.max(0, Math.min(days.length - 1, Math.round(((px - pad.l) / plotW) * (n - 1))));
			const d = days[i];
			const total = order.reduce((sum, k) => sum + (d.segs[k] || 0), 0);
			tip.innerHTML =
				'<div class="tip-day">' + new Date(d.day + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + '</div>' +
				(total ? order.filter((k) => d.segs[k]).reverse().map((k) => '<div class="tip-row"><i class="swatch bg-' + k + '"></i><span>' + esc(names[k]) + '</span><b>' + fmtTokens(d.segs[k]) + '</b></div>').join('') + '<div class="tip-row tip-total">Total<b>' + fmtTokens(total) + '</b></div>' : '<div class="tip-row">No usage</div>');
			crossLine.setAttribute('x1', x(i).toFixed(2));
			crossLine.setAttribute('x2', x(i).toFixed(2));
			for (const dot of crossDots) {
				const v = d.segs[dot.dataset.k] || 0;
				dot.setAttribute('cx', x(i).toFixed(2));
				dot.setAttribute('cy', y(v).toFixed(2));
				dot.style.opacity = v ? '1' : '0';
			}
			crossEl.classList.add('on');
			tip.classList.remove('hidden');
			const left = (x(i) / W) * rect.width;
			const flip = left > rect.width * 0.62;
			const tipLeft = flip ? left - tip.offsetWidth - 14 : left + 14;
			tip.style.left = Math.max(4, Math.min(rect.width - tip.offsetWidth - 4, tipLeft)) + 'px';
			tip.style.top = '6px';
			tip.style.transform = 'none';
		});
		svg.addEventListener('mouseleave', hide);
	}
	window.addEventListener('resize', () => S.open && S.section === 'usage' && drawChart());


return { usageSlice, usagePager, usageSectionHead, usageEmpty, usageCostCell, usageCacheLabel, usageItems, usageListToolbar, requestUsageDetail, activateUsageTab, usageRangeButtons, usageModelDetail, usageSeries, usagePage, usageBudgetCard, budgetWindow, niceMax, usageSmooth, drawChart };
	} };
})();
