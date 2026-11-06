/**
 * Where an API key may safely be sent. Pure (no vscode import); tested in units.test.js.
 */

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i;

/** Loopback base URL: no key needed, nothing leaves this machine. */
export function isLoopbackUrl(url: string | undefined): boolean {
	return LOOPBACK.test(url ?? '');
}

/**
 * http:// to a public host: an API key sent there travels unencrypted. LAN
 * addresses, .local / .lan / Tailscale names, single-label hosts and loopback
 * are fine.
 */
export function insecureRemote(url: string): boolean {
	try {
		const u = new URL(url);
		const host = u.hostname.replace(/^\[|\]$/g, '');
		if (u.protocol !== 'http:' || isLoopbackUrl(url) || (!host.includes('.') && !host.includes(':'))) return false;
		const privateV4 = /^(10\.|192\.168\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host);
		const privateV6 = /^(fc|fd|fe80)/i.test(host);
		const privateName = /\.(local|lan|internal|home|ts\.net|localdomain)$/i.test(host);
		return !(privateV4 || privateV6 || privateName);
	} catch {
		return false;
	}
}
