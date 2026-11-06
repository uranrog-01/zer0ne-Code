/*
 * First-run setup: a local model that fits this PC (no API key), or a
 * provider key. Opened from the welcome screen and, on a first run with no
 * project folder, by itself. Host messages arrive as window "message" events
 * (bridge.js), so chat.js's message switch stays untouched.
 */
(function () {
	'use strict';

	/** The first task teaches the loop: a real edit, a diff, and Undo. */
	const FIRST_TASK = 'Read README.md. If it does not exist, create it. Add one short sentence describing what this project does, and change nothing else.';
	const KEY_PRESETS = [
		{ id: 'openai', name: 'OpenAI' },
		{ id: 'anthropic', name: 'Anthropic' },
		{ id: 'gemini', name: 'Google Gemini' },
		{ id: 'openrouter', name: 'OpenRouter' }
	];

	window.ChatSetup = {
		create({ post, t, state, startTask, sendTask, openSettings, remote }) {
			const tr = (key, vars) => (t ? t(key, vars) : key);
			let root = null, panel = null;
			let step = 'start', picks = [], machine = null, planError = '';
			let selected = '', job = null, engineJob = null, keyError = '', keyDraft = '', keyPreset = 'openai';
			let busy = false, asked = false, finished = false, waitingStatus = false, viaKey = false, downloadError = '', cancelled = false;

			const remotePage = () => remote === true || !!window.Bridge?.remote;
			const configured = () => {
				const s = state ? state() : null;
				return !!s && s.providers.some((p) => p.enabled && p.models.some((m) => m.enabled));
			};
			const hasWorkspace = () => (state ? state().hasWorkspace !== false : true);
			const el = (tag, cls, text) => {
				const node = document.createElement(tag);
				if (cls) node.className = cls;
				if (text !== undefined) node.textContent = text;
				return node;
			};
			const button = (cls, label, onClick) => {
				const node = el('button', cls, label);
				node.type = 'button';
				if (onClick) node.addEventListener('click', onClick);
				return node;
			};
			const pick = () => picks.find((p) => p.id === selected);
			const modelName = () => pick()?.name || tr('setupThisModel');

			// ------------------------------------------------------------ rendering

			function head(title, note) {
				const box = el('div', 'setup-head');
				box.append(el('h2', 'setup-title', title));
				if (note) box.append(el('p', 'setup-note', note));
				return box;
			}

			function verdictLabel(verdict) {
				return tr({ perfect: 'setupFitPerfect', good: 'setupFitGood', marginal: 'setupFitTight', slow: 'setupFitSlow', no: 'setupFitNo' }[verdict] || 'setupFitGood');
			}

			function reasonLabel(preset) {
				return tr({ fast: 'setupReasonFast', balanced: 'setupReasonBalanced', quality: 'setupReasonQuality' }[preset] || 'setupReasonBalanced');
			}

			function machineLabel() {
				if (!machine) return tr('setupChecking');
				const gpu = machine.gpuName ? machine.gpuName + (machine.gpuGb ? ' · ' + machine.gpuGb + ' GB' : '') : tr('setupCpuOnly');
				return tr('setupThisPC', { ram: machine.ramGb, gpu });
			}

			function pickCard(item) {
				const card = button('setup-pick' + (item.id === selected ? ' is-selected' : ''), '', () => {
					selected = item.id;
					render();
				});
				card.setAttribute('aria-pressed', item.id === selected ? 'true' : 'false');
				const top = el('span', 'setup-pick-top');
				top.append(el('span', 'setup-pick-name', item.name));
				top.append(el('span', 'setup-badge setup-badge-' + item.verdict, verdictLabel(item.verdict)));
				const meta = [item.quant, item.context ? Math.round(item.context / 1024) + 'K' : '', item.sizeGb ? item.sizeGb + ' GB' : ''].filter(Boolean).join(' · ');
				card.append(top);
				if (meta) card.append(el('span', 'setup-pick-meta', meta));
				card.append(el('span', 'setup-pick-why', reasonLabel(item.preset)));
				if (item.installedModelId) card.append(el('span', 'setup-pick-installed', tr('setupAlreadyHere')));
				return card;
			}

			function startStep() {
				const box = el('div', 'setup-step');
				box.append(head(tr('setupTitle'), tr('setupIntro')));
				box.append(el('p', 'setup-machine', machineLabel()));
				if (machine && machine.fastGb) box.append(el('p', 'setup-note setup-faint', tr('setupFastMemory', { gb: machine.fastGb })));
				if (planError) box.append(el('p', 'setup-error', planError));
				else if (!picks.length && machine) box.append(el('p', 'setup-error', tr('setupNoPicks')));
				const list = el('div', 'setup-picks');
				for (const item of picks) list.append(pickCard(item));
				box.append(list);
				const primary = button('setup-primary', pick()?.installedModelId ? tr('setupUse') : tr('setupDownload'), install);
				primary.disabled = !pick() || busy;
				const key = button('setup-secondary', tr('setupUseKey'), () => {
					step = 'key';
					keyError = '';
					render();
				});
				const row = el('div', 'setup-actions');
				row.append(primary, key);
				box.append(row);
				return box;
			}

			function downloadingStep() {
				const box = el('div', 'setup-step');
				const header = head(tr('setupDownloading', { model: modelName() }), job?.stage || tr('setupStarting'));
				if (header.lastElementChild) header.lastElementChild.classList.add('setup-stage');
				box.append(header);
				const track = el('div', 'setup-progress');
				const fill = el('div', 'setup-progress-fill');
				fill.style.width = percent() + '%';
				track.append(fill);
				box.append(track);
				box.append(el('p', 'setup-note setup-faint setup-progress-text', progressText(job)));
				if (engineJob) box.append(el('p', 'setup-note setup-faint', tr('setupPreparing')));
				const row = el('div', 'setup-actions');
				row.append(button('setup-secondary', tr('setupCancel'), cancel));
				box.append(row);
				return box;
			}

			function keyStep() {
				const box = el('div', 'setup-step');
				box.append(head(tr('setupKeyTitle'), tr('setupKeyNote')));
				const tabs = el('div', 'setup-providers');
				for (const provider of KEY_PRESETS) {
					const tab = button('setup-provider' + (provider.id === keyPreset ? ' is-selected' : ''), provider.name, () => {
						keyPreset = provider.id;
						keyError = '';
						render();
					});
					tabs.append(tab);
				}
				box.append(tabs);
				const input = el('input', 'setup-input');
				input.type = 'password';
				input.autocomplete = 'off';
				input.spellcheck = false;
				input.placeholder = tr('setupKeyPlaceholder');
				input.value = keyDraft;
				input.addEventListener('input', () => { keyDraft = input.value; });
				input.addEventListener('keydown', (event) => { if (event.key === 'Enter') submitKey(input.value); });
				box.append(input);
				if (keyError) box.append(el('p', 'setup-error', keyError));
				const row = el('div', 'setup-actions');
				const check = button('setup-primary', busy ? tr('setupKeyChecking') : tr('setupKeyCheck'), () => submitKey(input.value));
				check.disabled = busy;
				row.append(check);
				row.append(button('setup-secondary', tr('setupBack'), () => {
					step = 'start';
					keyError = '';
					render();
				}));
				box.append(row);
				return box;
			}

			function folderStep() {
				const box = el('div', 'setup-step');
				box.append(head(tr('setupFolderTitle'), tr('setupFolderDesc')));
				if (typeof window.__zcCreateProject === 'function') {
					const row = el('div', 'setup-actions');
					row.append(button('setup-primary', tr('setupChooseFolder'), chooseFolder));
					box.append(row);
				} else {
					box.append(el('p', 'setup-note', tr('setupFolderManual')));
				}
				return box;
			}

			function readyStep() {
				const box = el('div', 'setup-step');
				box.append(viaKey
					? head(tr('setupKeyReadyTitle'), tr('setupKeyReadyDesc'))
					: head(tr('setupReadyTitle'), tr('setupReadyDesc', { model: modelName() })));
				const task = el('div', 'setup-task');
				task.append(el('div', 'setup-task-label', tr('setupFirstTask')));
				task.append(el('div', 'setup-task-text', FIRST_TASK));
				box.append(task);
				if (!hasWorkspace() && typeof window.__zcCreateProject !== 'function') box.append(el('p', 'setup-note', tr('setupFolderManual')));
				const row = el('div', 'setup-actions');
				if (hasWorkspace() || typeof window.__zcCreateProject !== 'function') {
					row.append(button('setup-primary', tr('setupRunTask'), () => runTask(true)));
					row.append(button('setup-secondary', tr('setupNotNow'), () => runTask(false)));
				} else {
					row.append(button('setup-primary', tr('setupChooseFolder'), chooseFolder));
				}
				box.append(row);
				return box;
			}

			function footer() {
				const foot = el('div', 'setup-foot');
				if (step !== 'downloading') foot.append(button('setup-link', tr('setupSkip'), skip));
				foot.append(button('setup-link', tr('setupAllProviders'), () => {
					close();
					if (openSettings) openSettings('models');
				}));
				return foot;
			}

			function render() {
				if (!root || !panel) return;
				panel.replaceChildren(
					step === 'start' ? startStep()
						: step === 'downloading' ? downloadingStep()
							: step === 'key' ? keyStep()
								: step === 'folder' ? folderStep()
									: readyStep(),
					footer()
				);
				const focus = panel.querySelector(step === 'key' ? '.setup-input' : '.setup-primary');
				if (focus && step !== 'downloading') focus.focus({ preventScroll: true });
			}

			function paintProgress() {
				if (!root) return;
				const fill = root.querySelector('.setup-progress-fill');
				if (fill) fill.style.width = percent() + '%';
				const text = root.querySelector('.setup-progress-text');
				if (text) text.textContent = progressText(job);
				const stage = root.querySelector('.setup-stage');
				if (stage) stage.textContent = job?.stage || tr('setupStarting');
			}

			function percent() {
				return job && job.total ? Math.max(0, Math.min(100, (job.received / job.total) * 100)).toFixed(1) : '0';
			}

			function progressText(value) {
				if (!value) return '';
				const gb = (bytes) => (bytes / 1e9).toFixed(bytes >= 1e9 ? 1 : 2) + ' GB';
				const rate = value.rate ? ' · ' + (value.rate / 1e6).toFixed(1) + ' MB/s' : '';
				return value.total ? gb(value.received) + ' / ' + gb(value.total) + rate : gb(value.received || 0) + rate;
			}

			// ------------------------------------------------------------ actions

			function install() {
				const item = pick();
				if (!item || busy) return;
				busy = true;
				step = 'downloading';
				job = null;
				engineJob = null;
				planError = '';
				downloadError = '';
				viaKey = false;
				cancelled = false;
				post({ type: 'setupInstall', id: item.id });
				render();
			}

			function cancel() {
				cancelled = true;
				if (job?.key) post({ type: 'jobCancel', key: job.key });
			}

			function submitKey(value) {
				if (busy) return;
				keyDraft = String(value || '');
				if (!keyDraft.trim()) {
					keyError = tr('setupKeyEmpty');
					render();
					return;
				}
				busy = true;
				keyError = '';
				post({ type: 'setupKey', presetId: keyPreset, apiKey: keyDraft.trim() });
				render();
			}

			function chooseFolder() {
				post({ type: 'setupDone', firstTask: FIRST_TASK });
				finished = true;
				close();
				if (typeof window.__zcCreateProject === 'function') window.__zcCreateProject();
			}

			function runTask(send) {
				post({ type: 'setupDone' });
				finished = true;
				close();
				if (send && sendTask) sendTask(FIRST_TASK);
			}

			function skip() {
				post({ type: 'setupDone' });
				finished = true;
				close();
			}

			// ------------------------------------------------------------ lifecycle

			function mount() {
				if (root) return;
				root = el('div', 'setup-overlay');
				root.setAttribute('role', 'dialog');
				root.setAttribute('aria-modal', 'true');
				root.setAttribute('aria-label', tr('setupTitle'));
				panel = el('div', 'setup-card');
				root.append(panel);
				document.body.append(root);
				document.addEventListener('keydown', onKey);
			}

			function close() {
				if (!root) return;
				document.removeEventListener('keydown', onKey);
				root.remove();
				root = null;
				panel = null;
			}

			function onKey(event) {
				if (event.key === 'Escape') close();
			}

			/** Open on an explicit click (the welcome screen's button). */
			function open(where) {
				step = where === 'key' ? 'key' : 'start';
				keyError = '';
				planError = '';
				viaKey = false;
				mount();
				render();
				post({ type: 'setupPlan' });
			}

			/**
			 * Once per page: read the stored setup state. A stored first task is
			 * prefilled (that is how it survives the folder change); the overlay
			 * opens by itself only on a real first run with no folder.
			 */
			function maybeOpen() {
				if (asked || finished || remotePage()) return;
				asked = true;
				waitingStatus = true;
				post({ type: 'setupStatus' });
			}

			window.addEventListener('message', (event) => {
				const msg = event.data;
				if (!msg || typeof msg.type !== 'string') return;
				switch (msg.type) {
					case 'setupStatus':
						if (typeof msg.firstTask === 'string' && msg.firstTask && !root) {
							if (startTask) startTask(msg.firstTask);
							post({ type: 'setupConsumed' });
						}
						if (msg.done === true) finished = true;
						if (waitingStatus) {
							waitingStatus = false;
							if (msg.done !== true && !msg.firstTask && !configured() && !hasWorkspace()) open('start');
						}
						break;
					case 'setupPlan':
						picks = Array.isArray(msg.picks) ? msg.picks : [];
						machine = msg.machine && typeof msg.machine === 'object' ? msg.machine : machine;
						planError = typeof msg.error === 'string' ? msg.error : '';
						if (!selected || !picks.some((p) => p.id === selected)) selected = picks[0]?.id || '';
						if (root && step === 'start') render();
						break;
					case 'setupInstalling':
						busy = true;
						step = 'downloading';
						if (root) render();
						break;
					case 'setupInstalled':
						busy = false;
						job = null;
						engineJob = null;
						downloadError = '';
						viaKey = false;
						step = hasWorkspace() ? 'ready' : 'folder';
						if (root) render();
						break;
					case 'setupFailed':
						busy = false;
						job = null;
						engineJob = null;
						planError = cancelled ? tr('setupCancelled') : (downloadError || (typeof msg.error === 'string' ? msg.error : tr('setupDownloadFailed')));
						downloadError = '';
						cancelled = false;
						step = 'start';
						if (root) render();
						break;
					case 'setupKeyResult':
						busy = false;
						if (msg.ok === true) {
							keyError = '';
							viaKey = true;
							step = hasWorkspace() ? 'ready' : 'folder';
						} else {
							keyError = typeof msg.error === 'string' ? msg.error : tr('setupKeyFailed');
							step = 'key';
						}
						if (root) render();
						break;
					case 'localJob': {
						const update = msg.job;
						if (!update || typeof update.key !== 'string') break;
						if (update.key.startsWith('hf:')) job = update.done ? { ...job, ...update, received: job?.total || update.received, total: job?.total || update.total } : { ...job, ...update };
						else if (update.key === 'engine') engineJob = update.done ? null : update;
						else break;
						if (root && step === 'downloading') paintProgress();
						break;
					}
					case 'hfDownloadError':
						if (step !== 'downloading') break;
						busy = false;
						downloadError = typeof msg.error === 'string' ? msg.error : '';
						planError = downloadError || tr('setupDownloadFailed');
						step = 'start';
						if (root) render();
						break;
				}
			});

			return { open, close, maybeOpen };
		}
	};
})();
