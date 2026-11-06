(function () {
	'use strict';
	window.SettingsRemote = {
		create({ S, h, header, esc, I, post, desktopHost }) {
			
			function remotePage() {
					const root = h('div', 'page remote-hub');
					root.appendChild(header('Mobile remote', 'Use this project from your phone over Wi-Fi, a secure link, or your own SSH tunnel.'));
					root.appendChild(h('div', 'callout', esc(S.remote.project || 'This project') + (S.capabilities?.optionalServiceOwner === false ? '<p>Another live host owns this project’s Remote. Use that window, or close it and reopen this project here.</p>' : '<p>Each project has its own link and port. While Remote is on, this project stays available when you switch projects. Turn it off to let an idle project close.</p>')));
					phonePanel(root);
					if (S.capabilities?.optionalServiceOwner === false) root.querySelectorAll('button,input,select,textarea').forEach(control => { control.disabled = true; });
					return root;
				}

			

			

			function phonePanel(root) {
				const r = S.remote || {};
				const access = S.settings.remoteAccess || 'lan';
				const t = r.tunnel || { state: 'off' };
				const devices = Array.isArray(r.devices) ? r.devices : [];
				const modes = { lan: 'Same Wi-Fi', anywhere: 'Anywhere', tailscale: 'Tailscale', ssh: 'Own tunnel' };
				const seen = (at) => {
					const s = Math.max(0, Math.round((Date.now() - Number(at || 0)) / 1000));
					if (s < 60) return 'active now';
					if (s < 3600) return Math.round(s / 60) + ' min ago';
					if (s < 86400) return Math.round(s / 3600) + ' h ago';
					return Math.round(s / 86400) + ' d ago';
				};
				const deviceMark = (name) => I(/iPad|Mac|Windows|Linux/i.test(name) ? 'monitor' : 'phone');

				// One glance: is it on, where does it listen, and the switch that owns it.
				root.appendChild(
					h('section', 'card rh-hero' + (r.running ? ' on' : ''),
						'<span class="rh-hero-orb">' + I('phone') + '</span>' +
							'<div class="rh-hero-text"><div class="rh-hero-title">' + (r.error ? 'Remote could not start' : r.running ? 'Remote is on' : 'Remote is off') +
								'<span class="state-pill ' + (r.running ? 'live' : 'off') + '"><span class="dot ' + (r.running ? 'green' : '') + '"></span>' + (r.running ? 'Live' : 'Off') + '</span></div>' +
								'<p>' + (r.error ? esc(r.error) : r.running
									? 'Port ' + r.port + ' · ' + esc(modes[access] || 'Same Wi-Fi') + ' · ' + (r.clients || 0) + ' live connection' + (r.clients === 1 ? '' : 's') + (devices.length ? ' · ' + devices.length + ' paired phone' + (devices.length === 1 ? '' : 's') : '') + (Number(r.approvalWaiting || 0) + Number(r.questionWaiting || 0) ? ' · ' + (Number(r.approvalWaiting || 0) + Number(r.questionWaiting || 0)) + ' waiting for you' : '')
									: 'Turn it on, then scan the code with your phone’s camera. No app to install.') + '</p></div>' +
							'<label class="switch"><input type="checkbox" id="s-remoteEnabled" data-setting="remoteEnabled" aria-label="Enable mobile remote"' + (S.settings.remoteEnabled ? ' checked' : '') + '><span class="track"></span></label>')
				);

				// The code itself, with steps that change with the chosen connection.
				if (r.running && r.urls && r.urls.length) {
					const step1 = access === 'anywhere' ? (t.state === 'on' ? 'Nothing to set up — the link works on mobile data and any Wi-Fi.' : 'The secure link is not ready. These local links work on the same Wi-Fi.') : access === 'tailscale' ? (r.tailscale ? 'Open the Tailscale app on your phone and connect.' : 'Tailscale is not connected. These local links work on the same Wi-Fi.') : access === 'ssh' ? (r.ssh?.state === 'on' ? 'Your tunnel does the travel — any network works.' : 'Your tunnel is not ready. These local links work on the same Wi-Fi.') : 'Connect your phone to the same Wi-Fi.';
					const pair = h('section', 'card pair-card rh-pair');
					pair.innerHTML =
						'<div class="qr-box" id="qr-box"></div><div class="pair-info"><div class="rh-eyebrow">Connect a phone</div>' +
						'<div class="pair-title">' + I('qr') + 'Scan with your camera</div>' +
						'<ol class="pair-steps"><li>' + step1 + '</li><li>Point the <b>camera</b> at the code and tap the link. <b>No app to install.</b></li><li>Make it feel like an app: <b>iPhone</b> Share → <i>Add to Home Screen</i> · <b>Android</b> ⋮ → <i>Add to Home screen</i>.</li></ol>' +
						'<div class="rh-links">' + r.urls.slice(0, 3).map((u, i) => '<div class="url-row' + (i === 0 ? ' main' : '') + '"><code>' + esc(u.replace(/\?t=.*/, '?t=•••')) + '</code><button class="btn btn-ghost btn-sm" data-act="copy-url" data-url="' + esc(u) + '">' + I('copy') + 'Copy</button></div>').join('') + '</div>' +
						'<div class="pair-code">' + (r.pairCode ? '<span class="pc-label">Pairing code</span><b class="pc-digits">' + esc(r.pairCode.slice(0, 3) + ' ' + r.pairCode.slice(3)) + '</b><span class="muted">one use · 10 min · type it at <code>' + esc((r.home || '').replace(/^https?:\/\//, '')) + '</code></span>' : '<span class="muted">Lost the code, or no camera? Type a code instead.</span><button class="btn btn-secondary btn-sm" data-act="remote-code">' + I('key') + 'Show pairing code</button>') + '</div>' +
						'<div class="pair-foot"><span class="dot green"></span>' + (r.clients || 0) + ' live connection' + (r.clients === 1 ? '' : 's') + '<span class="spacer"></span><button class="btn btn-ghost btn-sm" data-act="remote-regenerate">' + I('refresh') + 'New link</button></div></div>';
					// The QR SVG is generated by the extension itself (not user content).
					pair.querySelector('#qr-box').innerHTML = r.qr || '';
					root.appendChild(pair);
				} else if (S.settings.remoteEnabled && !r.error) {
					root.appendChild(h('div', 'card chart-empty', '<span class="spinner"></span>'));
				}

				// Who is paired right now, and how to sign one phone out.
				if (r.running) {
					root.appendChild(
						h('section', 'card rh-devices',
							'<div class="rh-card-head"><div><div class="rh-eyebrow">Paired phones</div><b>' + (devices.length ? devices.length + ' signed in' : 'No phone yet') + '</b></div><span class="rh-secure">' + (r.secure ? I('lock') + 'Encrypted link' : I('shield') + 'Local network only') + '</span></div>' +
							(devices.length
								? devices.map((d) => '<div class="rh-device"><span class="rh-device-mark">' + deviceMark(d.name) + '</span><div class="rh-device-text"><b>' + esc(d.name) + '</b><span>' + esc(d.ip) + ' · ' + seen(d.seen) + '</span></div><button class="btn btn-ghost btn-sm" data-act="remote-revoke" data-id="' + esc(d.id) + '">Sign out</button></div>').join('')
								: '<p class="rh-empty">Scan the code above to pair this phone. Each phone gets its own sign-in you can revoke here.</p>'))
					);
				}

				// Where phones connect through.
				root.appendChild(
					h('section', 'card rh-modes',
						'<div class="rh-card-head"><div><div class="rh-eyebrow">Connection</div><b>How your phone reaches this computer</b></div></div>' +
							'<div class="access-row">' +
							[['lan', 'wifi', 'Same Wi-Fi', 'Phone and computer on one network'], ['anywhere', 'globe', 'Anywhere', 'Secure private link — no account, no app, works on mobile data'], ['tailscale', 'shield', 'Tailscale', 'Private network between your devices'], ['ssh', 'key', 'Own tunnel', 'Through your own SSH tunnel server — no third party, one stable URL']]
								.filter(([id]) => id !== 'tailscale' || r.tailscale || access === 'tailscale')
								.map(([id, icon, name, desc]) => '<button class="access-card' + (access === id ? ' active' : '') + '" data-seg="remoteAccess" data-value="' + id + '"><span class="ac-icon">' + I(icon === 'wifi' ? 'phone' : icon) + '</span><b>' + name + (id === 'anywhere' ? ' <span class="theme-badge">recommended</span>' : id === 'tailscale' ? ' <span class="muted">detected</span>' : '') + '</b><span>' + desc + '</span></button>').join('') +
							'</div>' +
							'<div class="setting-row"><div class="text"><div class="name">Port</div><div class="desc">Change it if the port is taken. Windows may ask to allow network access the first time.</div></div><div class="control"><input id="s-remotePort" class="input mono" type="number" min="1024" max="65535" data-setting="remotePort" value="' + (S.settings.remotePort || 7654) + '"></div></div>')
				);
				if (r.error) root.appendChild(h('div', 'callout warn-callout', I('alert') + '<div>' + esc(r.error) + '</div>'));
				// The secure-link helper (cloudflared): one click to download and install it, with progress.
				const hp = r.helper || {};
				if (access === 'anywhere') {
					const busy = hp.installing || (t.state === 'starting' && t.pct != null);
					root.appendChild(
						h(
							'div',
							'card helper-card' + (hp.installed ? ' ready' : ''),
							'<span class="hc-icon">' + I(hp.installed ? 'check' : 'shield') + '</span><div class="grow"><b>Secure link helper</b><span>' +
								(hp.installed ? 'Installed and ready' + (hp.path ? ' · <code>' + esc(hp.path) + '</code>' : '') : busy ? esc(t.text || 'Downloading…') : 'cloudflared by Cloudflare (free, Apache-2.0), about 55 MB — downloaded once from Cloudflare\'s official GitHub releases.') +
								'</span>' + (busy && t.pct != null ? '<div class="pull-bar hc-bar"><span data-width="' + t.pct + '"></span></div>' : '') + '</div>' +
								(hp.installed ? '<span class="state-pill live"><span class="dot green"></span>Ready</span>' : busy ? '<span class="spinner"></span>' : '<button class="btn btn-primary btn-sm" data-act="remote-install-helper">' + I('arrowDown') + 'Download & install</button>')
						)
					);
				}
				if (S.settings.remoteEnabled && access === 'anywhere' && t.state !== 'on' && !(t.state === 'starting' && t.pct != null)) {
					root.appendChild(h('div', 'callout' + (t.state === 'error' ? ' warn-callout' : ''), (t.state === 'error' ? I('alert') : '<span class="spinner"></span>') + '<div>' + esc(t.state === 'error' ? t.error : t.text || 'Opening a secure link…') + (t.state === 'error' ? ' <button class="link-btn" data-act="remote-retry">Try again</button>' : '') + '</div>'));
				}
				if (S.settings.remoteEnabled && access === 'tailscale' && !r.tailscale) {
					root.appendChild(h('div', 'callout warn-callout', I('alert') + '<div>Tailscale is not running on this computer. <button class="link-btn" data-act="open-url" data-url="https://tailscale.com/download">Install Tailscale</button> here and on your phone, sign in to the same account, then pick Tailscale again.</div>'));
				}
				if (access === 'ssh') {
					const sh = r.ssh || { state: 'off' };
					root.appendChild(h('div', 'card',
						'<div class="setting-row stacked"><div class="text"><div class="name">SSH target</div><div class="desc">Who runs your tunnel: <code>stable@proxy.your-domain.com</code> pins one URL to your SSH key (tunnl.gg style — same address every session), or a single host like <code>serveo.net</code>. Your SSH key does the login.</div></div><div class="control"><input class="input mono" data-setting="remoteSshTarget" spellcheck="false" autocomplete="off" placeholder="stable@proxy.your-domain.com" value="' + esc(S.settings.remoteSshTarget || '') + '"></div></div>' +
							'<div class="setting-row"><div class="text"><div class="name">Remote port</div><div class="desc">The port the host maps to https — 80 for tunnl.gg and serveo.</div></div><div class="control"><input id="s-remoteSshRemotePort" class="input mono" type="number" min="1" max="65535" data-setting="remoteSshRemotePort" value="' + (S.settings.remoteSshRemotePort || 80) + '"></div></div>' +
							'<button class="link-btn" data-act="open-url" data-url="https://github.com/klipitkas/tunnl.gg">' + I('link') + 'Self-host a tunnel server (tunnl.gg, MIT) ↗</button>'
					));
					const wantLink = S.settings.remoteEnabled && r.running && sh.state !== 'on';
					if (wantLink && sh.state === 'error') root.appendChild(h('div', 'callout warn-callout', I('alert') + '<div>' + esc(sh.error) + (S.settings.remoteSshTarget ? ' <button class="link-btn" data-act="remote-retry-ssh">Try again</button>' : '') + '</div></div>'));
					else if (wantLink) root.appendChild(h('div', 'callout', '<span class="spinner"></span><div>' + (!S.settings.remoteSshTarget ? 'Enter an SSH target above — the tunnel opens on its own once it is saved.' : 'Opening your tunnel…') + '</div></div>'));
				}
				root.appendChild(
					h(
						'div',
						'callout',
						I('shield') +
							'<div>' +
							(access === 'ssh'
								? 'This is your tunnel, on your server: no third party in the middle, and with tunnl.gg stable@ the URL is the same every time. Every phone signs in on its own and can be revoked above.'
								: access === 'anywhere'
								? 'The secure link is a Cloudflare quick tunnel: encrypted (https), outbound only — no router or firewall changes — and it changes each time it starts. Pairing codes and lockouts still protect every request. Turn Mobile remote off to close it.'
								: access === 'tailscale'
									? 'Tailscale connects only your own signed-in devices, end-to-end encrypted. Nothing is public.'
									: 'The link contains a secret token — share it only with your own devices. Traffic stays on your local network. For use away from home pick <b>Anywhere</b> or <b>Tailscale</b> — never forward the port on your router.') +
							'</div>'
					)
				);
				if (desktopHost() && S.capabilities?.optionalServiceOwner === false) root.querySelectorAll('input, button').forEach(control => { control.disabled = true; });
				return root;
			}

			return { remotePage };
		}
	};
})();
