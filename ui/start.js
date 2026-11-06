// Start page: a spinner while the engine starts; the shell puts #error=<message> in the URL when it fails.
(function () {
	'use strict';
	const invoke = (cmd) => (window.__zcShell ? window.__zcShell.invoke(cmd).catch(() => undefined) : Promise.resolve());
	function render() {
		const m = /error=([^&]*)/.exec(location.hash);
		const failed = !!m;
		document.body.classList.toggle('failed', failed);
		document.getElementById('error').hidden = !failed;
		if (failed) document.getElementById('error-text').textContent = decodeURIComponent(m[1].replace(/\+/g, ' '));
	}
	window.addEventListener('hashchange', render);
	render();
	document.getElementById('retry').onclick = () => {
		history.replaceState(null, '', location.pathname);
		render();
		invoke('restart_engine');
	};
	document.getElementById('folder').onclick = () => window.__zcCreateProject();
	document.getElementById('logs').onclick = () => invoke('open_logs');
})();
