/* Workflow recording is a separate UI module; all capture and model calls live in the host. */
(function () {
	'use strict';
	const B = window.Bridge;
	const I = window.Icons.svg;
	const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	let options, dialog, info, recording, review, draft;
	let target = 'skill', view = 'intro', starting = false, saving = false;
	let selected = new Set(), notes = '', modelKey = '', scope = 'user', enlargedFrame = 0;
	let intro = { name: '', goal: '', display: 0, voice: false };
	const time = (ms) => Math.floor(ms / 60000) + ':' + String(Math.floor(ms / 1000) % 60).padStart(2, '0');
	const post = (type, rest) => B.post({ type, id: recording && recording.id, ...rest });
	const visionModels = () => (options.providers || []).filter((p) => p.enabled && p.apiFormat !== 'acp').flatMap((p) => p.models.filter((m) => m.enabled && m.vision).map((m) => ({ key: p.id + '::' + m.id, label: p.name + ' · ' + (m.name || m.id) })));
	function open(nextTarget, opts) {
		options = opts;
		if (!recording) target = nextTarget === 'plugin' ? 'plugin' : 'skill';
		if (dialog) dialog.close();
		dialog = options.openDialog({ title: recording ? 'Your recorded workflow' : 'Record a ' + target, onClose: () => { dialog = null; paintPill(); } });
		dialog.dlg.classList.add('record-dialog');
		view = draft ? 'draft' : review ? 'review' : recording ? 'active' : 'intro';
		paint();
		B.post({ type: 'skillRecorderInfo' });
	}
	/** While a recording runs with its dialog closed, a floating pill keeps it in view and reopens it. */
	let pill = null;
	function paintPill() {
		const show = !!recording && !dialog;
		if (!show) { if (pill) { pill.remove(); pill = null; } return; }
		if (!pill) {
			pill = document.createElement('button');
			pill.type = 'button';
			pill.className = 'rec-pill';
			pill.addEventListener('click', () => open(target, options));
			document.body.appendChild(pill);
		}
		const quiet = recording.state === 'paused' || recording.state === 'review' || recording.state === 'generating';
		const label = recording.state === 'review' ? 'Ready to review' : recording.state === 'generating' ? 'Creating draft…' : recording.state === 'paused' ? 'Paused · ' + time(recording.elapsedMs) : recording.state === 'starting' ? 'Starting…' : 'Recording · ' + time(recording.elapsedMs);
		pill.classList.toggle('quiet', quiet);
		pill.setAttribute('aria-label', label + '. Open the recorder');
		pill.innerHTML = '<span class="rec-pill-dot" aria-hidden="true"></span><span>' + esc(label) + '</span><span class="rec-pill-open" aria-hidden="true">Open</span>';
	}
	function paint() {
		paintPill();
		if (!dialog) return;
		if (view === 'intro') paintIntro();
		else if (view === 'draft') paintDraft();
		else if (view === 'review') paintReview();
		else paintActive();
	}
	function paintIntro() {
		dialog.body.innerHTML = '<div class="record-intro"><span class="record-hero-icon">' + I('record') + '</span><h2>Demonstrate a workflow</h2><p>Show the steps once, then turn them into an editable ' + (target === 'plugin' ? 'plugin with a reusable skill' : 'skill') + '.</p></div>' +
			'<div class="record-steps"><span><b>1</b> Record</span><span><b>2</b> Review</span><span><b>3</b> Save</span></div>' +
			'<div class="field"><label class="field-label" for="rec-goal">What should this workflow achieve?</label><textarea id="rec-goal" class="textarea" rows="2" placeholder="For example: export this week’s report and check the totals">' + esc(intro.goal) + '</textarea></div>' +
			'<div class="grid-2"><div class="field"><label class="field-label" for="rec-name">Name</label><input id="rec-name" class="input" placeholder="weekly-report" value="' + esc(intro.name) + '"></div><div class="field"><label class="field-label" for="rec-display">Display to record</label><select id="rec-display" class="select">' + ((info && info.displays.length ? info.displays : [{ index: 0, primary: true }]).map((d) => '<option value="' + d.index + '"' + (intro.display === d.index ? ' selected' : '') + '>Display ' + (d.index + 1) + (d.primary ? ' · Primary' : '') + (d.width ? ' · ' + d.width + '×' + d.height : '') + '</option>').join('')) + '</select></div></div>' +
			'<div class="check-row"><span>Voice narration <span class="badge">Optional</span><div class="desc">Explain your steps with Windows offline dictation. Raw audio is not saved.</div></span><label class="switch"><input id="rec-voice" type="checkbox" aria-label="Voice narration"' + (intro.voice ? ' checked' : '') + '><span class="track"></span></label></div>' +
			'<div class="record-privacy">' + I('shield') + '<div><b>Record only what you want to share</b><p>Screen frames can contain sensitive information. Avoid passwords and private conversations. Captures stay local until you choose reviewed frames to send to your model. Typed characters and clipboard contents are not logged.</p></div></div>' +
			'<p class="record-platform muted">' + esc(info ? info.error || (info.supported ? 'Local Windows recording · one frame per second · up to 5 minutes. A floating toolbar lets you pause or finish.' : 'Native recording requires local Windows VS Code. You can still create skills with New skill.') : 'Checking screen recording availability…') + '</p>';
		dialog.body.querySelector('#rec-goal').addEventListener('input', (e) => { intro.goal = e.target.value; });
		dialog.body.querySelector('#rec-name').addEventListener('input', (e) => { intro.name = e.target.value; });
		dialog.body.querySelector('#rec-display').addEventListener('change', (e) => { intro.display = Number(e.target.value); });
		dialog.body.querySelector('#rec-voice').addEventListener('change', (e) => { intro.voice = e.target.checked; });
		dialog.foot.innerHTML = '<span class="spacer"></span><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" data-start' + (!info || !info.supported || info.error || starting ? ' disabled' : '') + '>' + (starting ? '<span class="spinner"></span> Starting…' : I('record') + 'Start recording') + '</button>';
		dialog.foot.querySelector('[data-cancel]').addEventListener('click', dialog.close);
		dialog.foot.querySelector('[data-start]').addEventListener('click', () => {
			if (!intro.goal.trim()) return options.toast('Describe the workflow first.', 'error');
			starting = true;
			post('skillRecordStart', { ...intro, target });
			paintIntro();
		});
	}
	function paintActive() {
		if (!recording) return;
		const paused = recording.state === 'paused';
		const preparing = recording.state === 'starting';
		dialog.body.innerHTML = '<div class="record-active"><span class="record-hero-icon">' + (preparing ? '<span class="spinner"></span>' : '<span class="record-dot' + (paused ? ' quiet' : '') + '"></span>') + '</span><h2>' + (preparing ? 'Starting your recorder…' : paused ? 'Recording paused' : 'Recording your workflow') + '</h2><p>You can switch to another application now. Use the floating toolbar to pause, finish, or discard.</p><div class="record-counters"><b id="rec-duration">' + time(recording.elapsedMs) + '</b><span id="rec-counts">' + recording.frames + ' frames · ' + recording.events + ' actions</span></div><p class="muted">' + esc(recording.goal) + '</p></div>';
		dialog.foot.innerHTML = '<button class="link-btn danger" data-discard>Discard recording</button><span class="spacer"></span><button class="btn btn-secondary" data-pause' + (preparing ? ' disabled' : '') + '>' + I(paused ? 'record' : 'pause') + (paused ? 'Resume' : 'Pause') + '</button><button class="btn btn-primary" data-finish' + (preparing ? ' disabled' : '') + '>' + I('check') + 'Finish & review</button>';
		dialog.foot.querySelector('[data-discard]').addEventListener('click', discard);
		dialog.foot.querySelector('[data-pause]').addEventListener('click', () => post('skillRecordPause', { paused: !paused }));
		dialog.foot.querySelector('[data-finish]').addEventListener('click', () => { post('skillRecordStop'); dialog.foot.querySelector('[data-finish]').disabled = true; });
	}
	function paintReview() {
		if (!review) return;
		const models = visionModels();
		const busy = recording && recording.state === 'generating';
		const preview = review.frames.find((f) => f.index === enlargedFrame);
		dialog.body.innerHTML = '<div class="record-review-head"><h2>Review before creating a draft</h2><p>Select up to 12 frames. Only selected frames, your notes, and the action timeline are sent when you choose an AI model.</p></div>' +
			(recording && recording.error ? '<p class="record-privacy">' + esc(recording.error) + '</p>' : '') +
			'<div class="record-review-meta"><span>' + review.frames.length + ' preview frames from ' + (recording ? recording.frames : review.frames.length) + ' captures</span><b id="rec-selected-count">' + selected.size + ' selected</b></div>' +
			(preview ? '<div class="record-enlarged"><div><b>Frame ' + preview.index + ' · ' + time(preview.at) + '</b><button class="btn btn-ghost btn-sm" data-preview-close>Close preview</button></div><img src="' + preview.image + '" alt="Enlarged recorded screen at ' + time(preview.at) + '"></div>' : '') +
			'<div class="record-frame-grid">' + review.frames.map((f) => '<div class="record-frame' + (selected.has(f.index) ? ' selected' : '') + '"><button class="record-frame-preview" data-preview="' + f.index + '" aria-label="Enlarge frame ' + f.index + ' at ' + time(f.at) + '"><img src="' + f.image + '" alt="Recorded screen at ' + time(f.at) + '" loading="lazy"></button><label><input type="checkbox" data-frame="' + f.index + '"' + (selected.has(f.index) ? ' checked' : '') + (busy ? ' disabled' : '') + '><b>' + time(f.at) + '</b><small>Frame ' + f.index + '</small></label></div>').join('') + '</div>' +
			'<details class="advanced"><summary>' + I('chevronRight') + 'Recorded actions <span class="badge">' + review.events.length + '</span></summary><div class="record-event-list">' + review.events.map((e) => '<div><time>' + time(e.at) + '</time><span>' + esc(e.app || '') + '</span><b>' + esc(e.action + (e.shortcut ? ' · ' + e.shortcut : '') + (e.text ? ' · ' + e.text : '')) + '</b></div>').join('') + '</div></details>' +
			'<div class="field"><label class="field-label" for="rec-notes">Notes and missing steps</label><textarea id="rec-notes" class="textarea" rows="3" placeholder="Describe the important steps, inputs, and how to verify the result."' + (busy ? ' disabled' : '') + '>' + esc(notes) + '</textarea></div>' +
			'<div class="field"><label class="field-label" for="rec-model">Create draft with</label><select id="rec-model" class="select"' + (busy ? ' disabled' : '') + '><option value="">My notes · no model upload</option>' + models.map((m) => '<option value="' + esc(m.key) + '"' + (modelKey === m.key ? ' selected' : '') + '>' + esc(m.label) + '</option>').join('') + '</select><p class="field-hint" id="rec-send-hint">' + esc(sendHint()) + '</p></div>';
		dialog.body.querySelector('#rec-notes').addEventListener('input', (e) => { notes = e.target.value; });
		dialog.body.querySelector('#rec-model').addEventListener('change', (e) => { modelKey = e.target.value; dialog.body.querySelector('#rec-send-hint').textContent = sendHint(); });
		dialog.body.querySelectorAll('[data-preview]').forEach((button) => button.addEventListener('click', () => {
			enlargedFrame = Number(button.dataset.preview); paintReview();
			dialog.body.querySelector('[data-preview-close]').focus();
		}));
		const previewClose = dialog.body.querySelector('[data-preview-close]');
		if (preview && previewClose) previewClose.addEventListener('click', () => {
			const index = enlargedFrame; enlargedFrame = 0; paintReview();
			const button = dialog.body.querySelector('[data-preview="' + index + '"]'); if (button) button.focus();
		});
		dialog.body.querySelectorAll('[data-frame]').forEach((input) => input.addEventListener('change', () => {
			const index = Number(input.dataset.frame);
			if (input.checked && selected.size >= 12) { input.checked = false; return options.toast('Choose at most 12 frames.', 'error'); }
			input.checked ? selected.add(index) : selected.delete(index);
			input.closest('.record-frame').classList.toggle('selected', input.checked);
			dialog.body.querySelector('#rec-selected-count').textContent = selected.size + ' selected';
			dialog.body.querySelector('#rec-send-hint').textContent = sendHint();
		}));
		dialog.foot.innerHTML = '<button class="link-btn danger" data-discard>Discard recording</button><span class="spacer"></span><button class="btn btn-primary" data-generate' + (busy ? ' disabled' : '') + '>' + (busy ? '<span class="spinner"></span> Creating draft…' : I('sparkle') + 'Create draft') + '</button>';
		dialog.foot.querySelector('[data-discard]').addEventListener('click', discard);
		dialog.foot.querySelector('[data-generate]').addEventListener('click', () => {
			if (modelKey && !selected.size) return options.toast('Choose at least one frame to send.', 'error');
			post('skillRecordGenerate', { modelKey, frames: [...selected], notes });
			dialog.foot.querySelector('[data-generate]').disabled = true;
		});
	}
	function sendHint() {
		const models = visionModels();
		const model = models.find((m) => m.key === modelKey);
		return model ? 'Send ' + selected.size + ' selected frames, notes, and actions to ' + model.label + '. Provider costs may apply.' : 'Build an editable template from your notes and observed shortcuts. Nothing is uploaded.';
	}
	function paintDraft() {
		if (!draft) return;
		dialog.body.innerHTML = '<div class="record-review-head"><h2>Make this workflow reusable</h2><p>Review every step, replace example values with inputs, and define what success looks like. ' + (target === 'plugin' ? 'The plugin will contain this skill; it adds no executable hooks or MCP servers.' : 'You can use the saved skill by mentioning its name in chat.') + '</p></div>' +
			'<div class="grid-2"><div class="field"><label class="field-label" for="rec-draft-name">Name</label><input id="rec-draft-name" class="input" value="' + esc(draft.name) + '"></div><div class="field"><label class="field-label" for="rec-scope">Save to</label><select id="rec-scope" class="select"><option value="user">All my workspaces</option><option value="workspace">This workspace</option></select></div></div>' +
			'<div class="field"><label class="field-label" for="rec-draft-desc">When should the agent use it?</label><input id="rec-draft-desc" class="input" value="' + esc(draft.description) + '"></div>' +
			'<div class="field"><label class="field-label" for="rec-draft-body">Instructions</label><textarea id="rec-draft-body" class="textarea mono tall">' + esc(draft.body) + '</textarea></div><p class="field-hint">The draft has not been tested. Original screen captures are deleted when you save or discard.</p>';
		for (const [id, field] of [['rec-draft-name', 'name'], ['rec-draft-desc', 'description'], ['rec-draft-body', 'body']]) dialog.body.querySelector('#' + id).addEventListener('input', (e) => { draft[field] = e.target.value; });
		dialog.body.querySelector('#rec-scope').value = scope;
		dialog.body.querySelector('#rec-scope').addEventListener('change', (e) => { scope = e.target.value; });
		dialog.foot.innerHTML = '<button class="link-btn" data-back>Back to frames</button><span class="spacer"></span><button class="btn btn-ghost" data-discard>Discard</button><button class="btn btn-primary" data-save' + (saving ? ' disabled' : '') + '>' + (saving ? '<span class="spinner"></span> Saving…' : I('check') + 'Save ' + target) + '</button>';
		dialog.foot.querySelector('[data-back]').addEventListener('click', () => { view = 'review'; paint(); });
		dialog.foot.querySelector('[data-discard]').addEventListener('click', discard);
		dialog.foot.querySelector('[data-save]').addEventListener('click', () => {
			if (!draft.name.trim() || !draft.description.trim() || !draft.body.trim()) return options.toast('Complete the name, description, and instructions.', 'error');
			saving = true;
			post('skillRecordSave', { ...draft, scope: dialog.body.querySelector('#rec-scope').value });
			dialog.foot.querySelector('[data-save]').disabled = true;
		});
	}
	function discard() {
		post('skillRecordDiscard');
		reset();
		if (dialog) dialog.close();
	}
	function reset() { recording = review = draft = null; starting = saving = false; selected.clear(); notes = ''; modelKey = ''; scope = 'user'; enlargedFrame = 0; view = 'intro'; }
	window.addEventListener('message', (event) => {
		if (event.source && event.source !== window) return;
		const m = event.data;
		if (!m || !options) return;
		if (m.type === 'skillRecorderInfo') { info = { ...m, displays: m.displays || [] }; if (view === 'intro') paint(); }
		if (m.type === 'skillRecording') {
			const previousState = recording && recording.state;
			recording = m.recording;
			options.onState(recording);
			starting = false;
			if (!recording) { const ended = !!previousState || view !== 'intro'; reset(); paintPill(); if (ended && dialog) dialog.close(); return; }
			paintPill();
			target = recording.target;
			if (view === 'intro') { view = 'active'; paint(); }
			else if (view === 'active' && previousState !== recording.state) paint();
			else if (view === 'review') paintReview();
			if (dialog && view === 'active') {
				const elapsed = dialog.body.querySelector('#rec-duration'), counts = dialog.body.querySelector('#rec-counts');
				if (elapsed) elapsed.textContent = time(recording.elapsedMs);
				if (counts) counts.textContent = recording.frames + ' frames · ' + recording.events + ' actions';
			}
		}
		if (m.type === 'skillRecordingReview' && recording && m.id === recording.id) {
			review = m;
			if (!selected.size) selected = new Set(m.frames.slice(0, 12).map((f) => f.index));
			if (view !== 'draft') { view = 'review'; paint(); }
		}
		if (m.type === 'skillRecordingDraft' && recording && m.id === recording.id) { draft = { ...m.draft }; view = 'draft'; paint(); }
		if (m.type === 'skillRecordingNotice') { starting = saving = false; options.toast(m.text, 'error'); paint(); }
		if (m.type === 'skillRecordingSaved') { reset(); paintPill(); options.onState(null); if (dialog) dialog.close(); options.onSaved(m); }
	});
	window.SkillRecorder = { open };
})();
