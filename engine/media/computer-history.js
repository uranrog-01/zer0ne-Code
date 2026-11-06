(function () {
	'use strict';
	window.ComputerHistory = { create() {
		let messages = [], session, dialog, origin;
		function close() { if (!dialog) return; dialog.remove(); dialog = null; origin?.focus(); }
		function paint() {
			if (!dialog) return;
			const list = dialog.querySelector('.cu-history-list'); list.replaceChildren();
			let action = 'Initial observation'; const shots = [];
			for (const message of messages) {
				if (message.tool?.name !== 'computer') continue;
				const tool = message.tool;
				if (tool.image && /^data:image\/(jpeg|png);base64,/.test(tool.image)) shots.push({image:tool.image,action});
				else if (tool.status === 'done' && tool.summary && !/screenshot|allowed apps/.test(tool.summary)) action = tool.summary;
			}
			for (const [index, shot] of shots.slice(-8).entries()) {
				const figure = document.createElement('figure'), caption = document.createElement('figcaption'), image = document.createElement('img');
				caption.textContent = (index + 1) + ' · ' + shot.action; image.src = shot.image; image.alt = 'App screenshot after ' + shot.action; image.loading = 'lazy';
				figure.append(caption, image); list.appendChild(figure);
			}
			if (!shots.length) { const empty = document.createElement('p'); empty.className = 'cu-empty'; empty.textContent = 'No saved screenshots in this chat. Enable screenshot history before the agent uses the computer.'; list.appendChild(empty); }
		}
		window.addEventListener('message', event => {
			const m = event.data; if (m?.type !== 'state') return;
			if (session !== m.currentSessionId) { session = m.currentSessionId; messages = []; close(); }
			if (Array.isArray(m.messages)) messages = m.messages;
			paint();
		});
		return { open() {
			if (dialog) { dialog.focus(); return; }
			origin = document.activeElement; dialog = document.createElement('dialog'); dialog.className = 'cu-dialog cu-history'; dialog.setAttribute('aria-labelledby', 'cu-history-title');
			dialog.innerHTML = '<header class="cu-header"><div><h2 id="cu-history-title">Computer Use history</h2><p>The latest eight saved observations in this chat.</p></div><button type="button" class="btn btn-secondary btn-sm">Close</button></header><div class="cu-history-list"></div>';
			dialog.querySelector('button').onclick = close;
			dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
			document.body.appendChild(dialog); paint(); dialog.showModal();
		} };
	} };
})();
