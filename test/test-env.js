// The environment test suites run in (test/run.js, engine/test/run.js): the developer's own, minus
// credentials. A provider key, token or password in the shell must never reach a test, a mock agent
// or a real CLI a test starts (Pi's test.sh). Suites that need a key set their own fixture value.
'use strict';

const CREDENTIAL = /(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIALS?|ACCESS_KEY(_ID)?|SESSION_KEY|PAT|AUTH)(_|$)/i;
// Names that look like credentials but are platform settings the suites need.
const KEEP = new Set(['PATHEXT']);

function testEnv(env = process.env) {
	const out = {};
	for (const [name, value] of Object.entries(env)) {
		// Git reads GIT_CONFIG_COUNT and its KEY_n/VALUE_n pairs together; a dropped KEY_n breaks every git command.
		if (/^(?:WIN_)?CSC_LINK$/i.test(name) || /(^|_)AUTHORIZATION(_|$)/i.test(name) || /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/i.test(name)) continue;
		if (KEEP.has(name.toUpperCase()) || !CREDENTIAL.test(name)) out[name] = value;
	}
	return out;
}

module.exports = { testEnv };
