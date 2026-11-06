'use strict';
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../out/localEngine');
const { hfFetch, hfRetryDelay, HfRateLimitError } = require('../out/hfTransport');
const { hfCached } = require('../out/hfCache');
const tests = [], test = (name, fn) => tests.push([name, fn]);
async function withServer(handler, fn) {
 const server = http.createServer(handler); server.keepAliveTimeout = 0;
 await new Promise(r => server.listen(0, '127.0.0.1', r));
 const base = `http://127.0.0.1:${server.address().port}`;
 try { await fn(base); } finally { await new Promise(r => server.close(r)); }
}
test('parses server reset and Retry-After seconds/date without retrying early', () => {
 assert.equal(hfRetryDelay(new Headers({ 'RateLimit': '"api";r=0;t=42' })), 42000);
 assert.equal(hfRetryDelay(new Headers({ 'Retry-After': '7', 'RateLimit': '"api";r=0;t=12' })), 12000);
 assert.equal(hfRetryDelay(new Headers({ 'Retry-After': new Date(15000).toUTCString() }), 5000), 10000);
 assert.equal(hfRetryDelay(new Headers({ 'Retry-After': 'garbage' })), 60000);
});
test('429 suppresses later requests, has correct authenticated guidance and isolates resolver budget', async () => {
 let calls = 0;
 await withServer((req, res) => { calls++; if (req.url.includes('/resolve/')) res.end('file'); else res.writeHead(429, { RateLimit: '"api";r=0;t=42' }).end(); }, async base => {
  const url = base + '/api/models';
  await assert.rejects(hfFetch(url), e => e instanceof HfRateLimitError && /42 seconds/.test(e.message) && /free Read token/.test(e.message));
  await assert.rejects(hfFetch(url), HfRateLimitError); assert.equal(calls, 1);
  await assert.rejects(hfFetch(url, { headers: { Authorization: 'Bearer fixture' } }), e => /token was sent/.test(e.message) && !/Connect a free/.test(e.message)); assert.equal(calls, 2);
  await (await hfFetch(base + '/Qwen/Tiny/resolve/main/model.gguf')).text(); assert.equal(calls, 3);
 });
});
test('request starts are paced and aborted queued requests never reach the server', async () => {
 const times = [];
 await withServer((req, res) => { times.push(Date.now()); res.end('{}'); }, async base => {
  const a = hfFetch(base + '/api/a'); const ctl = new AbortController();
  const aborted = assert.rejects(hfFetch(base + '/api/abort', { signal: ctl.signal }), /cancelled/);
  ctl.abort(new Error('cancelled')); const b = hfFetch(base + '/api/b');
  await Promise.all([(await a).text(), (await b).text(), aborted]);
  assert.equal(times.length, 2); assert(times[1] - times[0] >= 220);
 });
});
test('requests resume after the server cooldown expires', async () => {
 let calls = 0;
 await withServer((req, res) => { calls++; if (calls === 1) res.writeHead(429, { 'Retry-After': '1' }).end(); else res.end('ready'); }, async base => {
  await assert.rejects(hfFetch(base + '/api/models'), HfRateLimitError);
  await assert.rejects(hfFetch(base + '/api/models'), HfRateLimitError); assert.equal(calls, 1);
  await new Promise(r => setTimeout(r, 1100));
  assert.equal(await (await hfFetch(base + '/api/models')).text(), 'ready'); assert.equal(calls, 2);
 });
});
test('a successful last-quota response still prevents the following request until reset', async () => {
 let calls = 0;
 await withServer((req, res) => { calls++; res.writeHead(200, { RateLimit: '"api";r=0;t=40' }).end('{}'); }, async base => {
  await (await hfFetch(base + '/api/a')).json(); await assert.rejects(hfFetch(base + '/api/b'), HfRateLimitError); assert.equal(calls, 1);
 });
});
test('token checks distinguish quota/server failures from invalid credentials', async () => {
 const prior = process.env.HF_ENDPOINT;
 try {
  await withServer((req, res) => res.writeHead(429, { 'Retry-After': '1' }).end(), async base => {
   process.env.HF_ENDPOINT = base; await assert.rejects(E.hfWhoAmI('hf_fixture'), HfRateLimitError);
  });
  await withServer((req, res) => res.writeHead(503).end(), async base => {
   process.env.HF_ENDPOINT = base; await assert.rejects(E.hfWhoAmI('hf_fixture'), /HTTP 503/);
  });
  await withServer((req, res) => res.writeHead(401).end(), async base => {
   process.env.HF_ENDPOINT = base; assert.equal(await E.hfWhoAmI('hf_fixture'), null);
  });
 } finally { if (prior === undefined) delete process.env.HF_ENDPOINT; else process.env.HF_ENDPOINT = prior; }
});
test('search, metadata, paginated files and downloads all use the connected token', async () => {
 const prior = process.env.HF_ENDPOINT, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-hf-auth-')); const seen = [];
 try {
  await withServer((req, res) => {
   seen.push([req.url, req.headers.authorization]); res.setHeader('Content-Type', 'application/json');
   if (req.url.includes('/resolve/')) res.end('model');
   else if (req.url.includes('/tree/')) res.end('[]');
   else if (req.url.startsWith('/api/models?')) res.end('[]');
   else res.end(JSON.stringify({ id: 'Qwen/Tiny', gguf: { total: 1e9 } }));
  }, async base => {
   process.env.HF_ENDPOINT = base; E.setHfToken('hf_fixture');
   await E.searchHfPage('tiny'); await E.hfInfo('Qwen/Tiny'); await E.hfFiles('Qwen/Tiny');
   await E.download(base + '/Qwen/Tiny/resolve/main/model.gguf', path.join(dir, 'model.gguf'), () => {}, new AbortController().signal);
   assert.equal(seen.length, 4); assert(seen.every(([, auth]) => auth === 'Bearer hf_fixture'));
  });
 } finally { E.setHfToken(undefined); if (prior === undefined) delete process.env.HF_ENDPOINT; else process.env.HF_ENDPOINT = prior; fs.rmSync(dir, { recursive: true, force: true }); }
});
test('cache deduplicates search work, serves stale data during throttling, and preserves uncached 429', async () => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-hf-cache-')); let calls = 0;
 try {
  const fetcher = async () => { calls++; await new Promise(r => setTimeout(r, 20)); return [{ id: 'Qwen/Tiny' }]; };
  await Promise.all([hfCached(dir, 'same', fetcher, 120000, true), hfCached(dir, 'same', fetcher, 120000, true)]); assert.equal(calls, 1);
  await hfCached(dir, 'same', fetcher, 120000, true); assert.equal(calls, 1);
  const limited = new HfRateLimitError(Date.now() + 42000, false);
  const cached = await hfCached(dir, 'same', async () => { throw limited; }, 0, true);
  assert.equal(cached.value[0].id, 'Qwen/Tiny'); assert.equal(cached.offline, true); assert(cached.cachedAt);
  await assert.rejects(hfCached(dir, 'uncached', async () => { throw limited; }, 0, true), e => e === limited && !/offline/.test(e.message));
  await assert.rejects(hfCached(dir, 'same', async () => { throw new Error('HTTP 401'); }, 0, true), /HTTP 401/);
 } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
(async () => { let failed = 0; for (const [name, fn] of tests) { try { await fn(); console.log('ok ' + name); } catch (e) { failed++; console.error('FAIL ' + name, e); } } process.exitCode = failed ? 1 : 0; })();
