(function () {
	'use strict';
	window.SettingsGeneral = { create({ I, S, desktopHost, esc, h, header, healthPanel, segmented, selectRow, sw, switchRow, tr }) {
function notchCard() {
		const st = S.settings;
		const presence = ['background', 'activity', 'always'].includes(st.notchPresence) ? st.notchPresence : 'background';
		const presenceDesc = {
			background: 'A small resting pill while zer0ne is in the background; it steps aside when a zer0ne window is in front, unless another project needs your approval.',
			activity: 'Appears only while a run is working, needs you, or has unread results; steps aside when a zer0ne window is in front, unless another project needs your approval.',
			always: 'Always on screen, also over zer0ne, including the project you are looking at.'
		}[presence];
		const phases = [
			['notchThinking', 'Thinking', 'thinking'],
			['notchWriting', 'Writing', 'writing'],
			['notchTools', 'Working', 'tool'],
			['notchWaiting', 'Approvals', 'waiting'],
			['notchFinished', 'Results', 'done']
		];
		const chip = ([key, name, phase], on) => '<button type="button" class="notch-chip' + (on ? ' active' : '') + '" data-act="notch-phase" data-key="' + key + '" data-phase="' + phase + '" aria-pressed="' + on + '"><i></i>' + name + '</button>';
		const chips = phases.map((p) => chip(p, st[p[0]] !== false)).join('');
		// Windows activity starts off: each one is opt-in.
		const activity = [['notchBattery', 'Low battery', 'battery'], ['notchNetwork', 'Network', 'offline'], ['notchMic', 'Microphone', 'mic']].map((p) => chip(p, st[p[0]] === true)).join('');
		const insights = [['notchStuck', 'Looks stuck', 'stuck'], ['notchResults', 'What changed', 'done'], ['notchAgents', 'Workers & cloud', 'cloud'], ['notchCost', 'Cost meter', 'budget'], ['notchHealth', 'Live health', 'tool'], ['notchNext', 'Next steps', 'done']].map((p) => chip(p, st[p[0]] !== false)).join('');
		const acting = [['notchActions', 'Approve & answer', 'waiting'], ['notchSteer', 'Stop & reply', 'tool'], ['notchDrop', 'Drop & ask', 'writing'], ['notchKeys', 'Pin & keyboard', 'thinking']].map((p) => chip(p, st[p[0]] !== false)).join('');
		const card = h('div', 'card notch-card' + (st.notch === false ? ' is-off' : ''),
			'<div class="notch-hero"><div class="notch-stage" aria-hidden="true"><div class="notch-mock"><span class="nm-glyph"></span><span class="nm-label">Thinking…</span><span class="nm-meta">zer0ne · 0:12</span></div></div>' +
			'<div class="notch-hero-text"><div class="name">AI Dock</div><div class="desc">A Dynamic Island for your agents: what each project is thinking, writing or running, when it needs your approval and when it is done. Hover it for every project and your recent notifications; click one to open its chat.</div>' +
			'<div class="notch-hero-actions"><button class="btn btn-secondary btn-sm" data-act="notch-preview">' + I('sparkle') + 'Preview on screen</button></div></div>' +
			'<div class="control">' + sw('notch') + '</div></div>' +
			'<div class="setting-row notch-sub"><div class="text"><div class="name">Show</div><div class="desc">' + esc(presenceDesc) + '</div></div><div class="control">' + segmented('notchPresence', [['background', 'When zer0ne is away'], ['activity', 'Only for activity'], ['always', 'Always']]) + '</div></div>' +
			'<div class="setting-row notch-sub"><div class="text"><div class="name">Over other windows</div><div class="desc">When an app window sits under the notch, it can shrink to a thin line: work runs along it in colour, and approvals and results still pop out. Touch the line to open the notch.</div></div><div class="control">' + segmented('notchCovered', [['line', 'Thin line'], ['pill', 'Small pill']]) + '</div></div>' +
			'<div class="setting-row notch-sub"><div class="text"><div class="name">Step aside for full-screen apps</div><div class="desc">Games, videos and presentations keep the screen; only an approval shows, as an amber line.</div></div><div class="control">' + sw('notchFullscreen') + '</div></div>' +
			'<div class="setting-row stacked notch-sub"><div class="text"><div class="name">Phases</div><div class="desc">Choose what the notch tells you about. An approval opens the notch by itself.</div></div><div class="notch-chips">' + chips + '</div></div>' +
			'<div class="setting-row stacked notch-sub"><div class="text"><div class="name">Run insights</div><div class="desc">What a run is worth your attention for: <b>Looks stuck</b> when the same step fails or repeats, or nothing moves for 5 minutes; <b>What changed</b> when it ends: files, lines, and whether its checks passed, with Open changes; <b>Workers &amp; cloud</b> for a Workflow\'s workers and the project\'s cloud tasks on GitHub; the <b>Cost meter</b> against the task budget (Settings → Agent), with a warning at 80%; <b>Live health</b> while it works: checks passing or failing, files changed, how full the context is; <b>Next steps</b> when it ends: Review changes, Check it, Undo, Continue.</div></div><div class="notch-chips">' + insights + '</div></div>' +
			'<div class="setting-row stacked notch-sub"><div class="text"><div class="name">Act from the notch</div><div class="desc"><b>Approve &amp; answer</b>: the exact command, whether it runs in the sandbox, then Approve, Reject or Never run it (which adds a deny rule); an agent\'s question with its answers. <b>Stop &amp; reply</b>: stop a run or tell it something without opening the chat. <b>Drop &amp; ask</b>: drop files, images or text on the pinned notch, or use what you copied, and ask about it. <b>Pin &amp; keyboard</b>: the pin keeps the notch open; ↑ ↓ choose a run, A approves, R rejects, S stops, Enter opens, Esc unpins.</div></div><div class="notch-chips">' + acting + '</div></div>' +
			'<div class="setting-row notch-sub"><div class="text"><div class="name">Discreet while presenting</div><div class="desc">While Windows reports a presentation (a slide show, or presentation settings on), the notch shows only what kind of thing happens — no project names, commands or files — and leaves screen captures.</div></div><div class="control">' + sw('notchDiscreet') + '</div></div>' +
			'<div class="setting-row notch-sub"><div class="text"><div class="name">Show on</div><div class="desc">The display the notch sits on. It moves to the display you use while you are not in it.</div></div><div class="control">' + segmented('notchDisplay', [['active', 'The display you use'], ['primary', 'Primary display']]) + '</div></div>' +
			'<div class="setting-row notch-sub"><div class="text"><div class="name">Sound</div><div class="desc">A soft chime when an approval or question waits, or a run fails. Nothing for routine progress.</div></div><div class="control">' + sw('notchSound') + '</div></div>' +
			'<div class="setting-row notch-sub"><div class="text"><div class="name">Shortcut Ctrl+Alt+Z</div><div class="desc">Opens the notch from any app; press it again to jump to what needs you (an approval, a stuck run, a failure). If another app already uses the key, it stays with that app.</div></div><div class="control">' + sw('notchShortcut') + '</div></div>' +
			'<div class="setting-row notch-sub"><div class="text"><div class="name">Hide from screen sharing</div><div class="desc">The notch stays on your screen but is left out of screenshots, recordings and shared screens, so project names and commands are not shown to others.</div></div><div class="control">' + sw('notchPrivate') + '</div></div>' +
			'<div class="setting-row notch-sub"><div class="text"><div class="name">Alerts</div><div class="desc">Where approvals and finished runs are announced. Notifications read on the notch are read on the bell too, and muting the bell quiets results on the notch.</div></div><div class="control">' + segmented('notchAlerts', [['both', 'Notch and Windows'], ['notch', 'Notch only']]) + '</div></div>' +
			'<div class="setting-row stacked notch-sub"><div class="text"><div class="name">Windows activity</div><div class="desc">Only what affects your agents: a low battery (20% and 10%) or a lost connection while they run, and the microphone while you dictate.</div></div><div class="notch-chips">' + activity + '</div></div>' +
			'<div class="setting-row notch-sub"><div class="text"><div class="name">Welcome-back briefing</div><div class="desc">After 5 minutes away, or when you unlock or wake the computer, a short summary of what finished, failed, still runs or needs you.</div></div><div class="control">' + sw('notchWelcome') + '</div></div>' +
			'<div class="setting-row"><div class="text"><div class="name">Keep awake while agents run</div><div class="desc">Your computer won\'t go to sleep while any agent is working; the screen can still turn off. Works with the notch off too.</div></div><div class="control">' + sw('notchKeepAwake') + '</div></div>'
		);
		return card;
	}

function generalPages() {
		return [
			['language', 'Language', 'globe', 'Choose the language for the interface and agent replies.'],
			['interaction', 'Interaction', 'sliders', 'Choose how follow-ups and unanswered questions are handled.'],
			['stream', 'Message stream', 'chat', 'Choose what appears while the agent works.'],
			['dictation', 'Dictation', 'mic', 'Turn your voice into a message with your preferred speech engine.'],
			['notifications', 'Notifications', 'bell', 'Choose how the app gets your attention.'],
			...(desktopHost() ? [['notch', 'AI Dock', 'panelRight', 'Keep track of agent activity from the desktop dock.']] : []),
			['diagnostics', 'Diagnostics', 'activity', 'Check your setup and prepare a problem report.']
		];
	}

function generalPage() {
		const page = h('div', 'page general-settings');
		page.appendChild(header('General', 'Everyday preferences for working with your agent.'));
		const pages = generalPages();
		const selected = pages.find(([id]) => id === S.generalPage) || pages[0];
		S.generalPage = selected[0];
		const navigation = h('nav', 'general-pages', pages.map(([id, label, icon]) => '<button type="button" id="general-nav-' + id + '" data-general-page="' + id + '"' + (id === S.generalPage ? ' aria-current="page"' : '') + '>' + I(icon) + '<span>' + esc(label) + '</span></button>').join(''));
		navigation.setAttribute('aria-label', 'General settings pages');
		page.appendChild(navigation);
		const root = h('section', 'general-content');
		root.setAttribute('aria-labelledby', 'general-page-title');
		root.appendChild(h('div', 'general-page-heading', '<h2 id="general-page-title" tabindex="-1">' + esc(selected[1]) + '</h2><p>' + esc(selected[3]) + '</p>'));
		page.appendChild(root);
		if (S.generalPage === 'language') {
			const langs = (window.I18N && window.I18N.languages) || [['en', 'English']];
			root.appendChild(
				h(
					'div',
					'card',
					selectRow(tr('uiLanguage'), 'Menus, buttons and labels. Model output is controlled by the reply language.', 'language', langs) +
						selectRow(tr('replyLanguage'), 'The agent answers in this language regardless of the language you write in.', 'replyLanguage', [['auto', tr('replyAuto')], ...langs])
				)
			);
		}
		if (S.generalPage === 'interaction') {
			root.appendChild(
				h(
					'div',
					'card',
					selectRow('Follow-ups while running', 'What happens to a message you send while the agent is still working.', 'followUp', [
						['queue', 'Queue — run after the current task'],
						['steer', 'Steer — deliver at the next tool step'],
						['interrupt', 'Interrupt — stop and send now']
					]) + switchRow('Automatically continue questions', 'When the agent asks a question, continue with its best judgment after 5 minutes without an answer.', 'autoContinueQuestions') +
						selectRow('Settings view', 'Simple shows the settings most people need: General, Appearance, Models, Agent, Memory, Mobile remote and Usage. Pro adds local models, browser, hooks, features, plugins, MCP servers and tasks. Search still finds every setting.', 'uiMode', [['pro', 'Pro — everything'], ['simple', 'Simple — the essentials']])
				)
			);
		}
		if (S.generalPage === 'stream') {
			root.appendChild(
				h(
					'div',
					'card',
					switchRow('Show reasoning', 'Show the model\'s thinking as a collapsible block.', 'showReasoning') +
						switchRow('Show todos', 'Show the agent\'s plan checklist cards in the stream.', 'showTodos') +
						switchRow('Group exploration tools', 'Collapse consecutive reads and searches into one “Explored” row.', 'groupExploration') +
						switchRow('Group terminal commands', 'Collapse consecutive finished commands into one “Ran N commands” row.', 'groupTerminal') +
						switchRow('Group file changes', 'Collapse consecutive applied edits into one “Changed N files” row.', 'groupChanges')
				)
			);
		}
		if (S.generalPage === 'dictation') {
			const whisperProviders = (S.providers || []).filter((p) => p.apiFormat === 'openai');
			root.appendChild(
				h(
					'div',
					'card',
					selectRow('Speech engine', 'System uses the offline Windows recognizer. Whisper records on this computer and transcribes with a provider — far more accurate and works in any language.', 'dictationEngine', [
						['system', 'System (Windows, offline)'],
						['whisper', 'Whisper (via a provider)']
					]) +
						(S.settings.dictationEngine === 'whisper'
							? selectRow('Whisper provider', 'An OpenAI-format provider with a transcription endpoint: OpenAI, Groq, or a local whisper server.', 'whisperProvider', [['', 'Auto (OpenAI or Groq)'], ...whisperProviders.map((p) => [p.id, p.name])]) +
								'<div class="setting-row"><div class="text"><div class="name">Whisper model</div><div class="desc">OpenAI: <code>whisper-1</code> or <code>gpt-4o-transcribe</code> · Groq: <code>whisper-large-v3</code></div></div><div class="control"><input id="s-whisperModel" class="input mono" data-setting="whisperModel" spellcheck="false" value="' + esc(S.settings.whisperModel || 'whisper-1') + '"></div></div>'
							: '')
				)
			);
		}
		if (S.generalPage === 'notifications') {
			if (!desktopHost()) {
				root.appendChild(
					h(
						'div',
						'card',
						switchRow('Task notifications', 'Notify when a task fails or needs approval while the chat is not visible.', 'notifications') +
							switchRow('Notification sound', 'Play a soft chime when the agent finishes or needs you.', 'notificationSound')
					)
				);
			} else {
				root.appendChild(h('div', 'callout', 'Use the bell in the project sidebar to control app notifications.'));
				root.appendChild(h('div', 'card', switchRow('Notification sound', 'Play a soft chime when the agent finishes or needs you.', 'notificationSound')));
			}
		}
		if (S.generalPage === 'notch') root.appendChild(notchCard());
		if (S.generalPage === 'diagnostics') {
			if (desktopHost() && !S.isRemote) root.appendChild(h('div', 'card', '<div class="setting-row stacked"><div class="text"><div class="name">Profile backup & restore</div><div class="desc">Save chats, settings, memories and checkpoints. Project files, local models and caches stay outside the backup. Saved sign-ins are optional and remain tied to their OS account. The app restarts to finish; stop active work first.</div></div><div class="control"><button class="btn btn-secondary btn-sm" data-act="profile-backup">Back up profile…</button> <button class="btn btn-secondary btn-sm" data-act="profile-restore">Restore profile…</button></div></div>'));
			root.appendChild(healthPanel());
			root.appendChild(h('div', 'card', '<div class="setting-row"><div class="text"><div class="name">Report a problem</div><div class="desc">Opens a report you can copy or save: version, system, providers (never keys), the setup check, zer0ne Engine state and this session\'s errors. You review it first — nothing is sent by itself.</div></div><div class="control"><button class="btn btn-secondary btn-sm" data-act="report-problem">' + I('alert') + 'Report a problem</button></div></div>'));
			root.appendChild(h('div', 'card', '<div class="setting-row"><div class="text"><div class="name">OpenTelemetry traces</div><div class="desc">Send each turn as a trace to your own collector, such as Jaeger or an OpenTelemetry Collector: model requests, tools, timings and token counts. Prompts, replies and file contents are never included. Leave empty to turn it off.</div></div><div class="control"><input id="s-otelEndpoint" class="input mono" data-setting="otelEndpoint" placeholder="http://localhost:4318/v1/traces" spellcheck="false" value="' + esc(S.settings.otelEndpoint || '') + '"></div></div>'));
		}
		return page;
	}
return { generalPages, generalPage };
	} };
})();
