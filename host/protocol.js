// The stdio protocol between the app (app/engines.js) and the engine host (host/main.js).
// Raise PROTOCOL whenever a message changes shape: the app refuses a host that speaks another
// version, rather than leaving requests it does not understand unanswered.
'use strict';

const PROTOCOL = 3;

// How long the host waits for the app to answer a request. Ops that wait on the user (a native
// dialog, a folder picker) get the long limit; everything else answers at once or not at all.
const RPC_TIMEOUT_MS = 30_000;
const RPC_INTERACTIVE_TIMEOUT_MS = 30 * 60_000;
const INTERACTIVE_OPS = new Set(['message', 'openDialog', 'saveDialog', 'openFolder']);

module.exports = { PROTOCOL, RPC_TIMEOUT_MS, RPC_INTERACTIVE_TIMEOUT_MS, INTERACTIVE_OPS };
