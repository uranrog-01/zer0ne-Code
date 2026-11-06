'use strict';
const assert = require('assert/strict'), fs = require('fs'), os = require('os'), path = require('path'), { spawnSync } = require('child_process');
const { acquire } = require('./gui-lock');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-validation-'));
const lock = path.join(tmp, 'desktop.lock');
try {
	const release = acquire(lock);
	const contender = spawnSync(process.execPath, ['-e', `try { require(process.argv[1]).acquire(process.argv[2]); process.exit(2); } catch(e) { if (!/sequentially/.test(e.message)) throw e; }`, path.resolve(__dirname, 'gui-lock.js'), lock], { encoding: 'utf8', env: { ...process.env, ZER0NE_TEST_LOCK: '' } });
	assert.equal(contender.status, 0, contender.stderr);
	const nested = acquire(lock); nested(); assert(fs.existsSync(lock)); release(); assert(!fs.existsSync(lock));
	const abandoned = spawnSync(process.execPath, ['-e', `require('fs').writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,token:'abandoned'}))`, lock]); assert.equal(abandoned.status, 0);
	const recovered = acquire(lock); assert.equal(JSON.parse(fs.readFileSync(lock)).pid, process.pid); recovered();
	fs.writeFileSync(lock, ''); fs.utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
	const incomplete = acquire(lock); incomplete(); assert(!fs.existsSync(lock));
	console.log('ok  concurrent desktop runs are refused; sequential child suites share the lease; dead owners recover');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
{
	// Suites start without the developer's credentials (test/test-env.js).
	const { testEnv } = require('./test-env');
	assert.deepEqual(testEnv({ CSC_LINK:'private-pfx', WIN_CSC_LINK:'private-pfx', CSC_KEY_PASSWORD:'private-password', AUTHORIZATION:'private-header' }), {});
	const env = testEnv({ PATH: 'p', PATHEXT: '.EXE', ComSpec: 'cmd', OPENAI_API_KEY: 'sk', ANTHROPIC_AUTH_TOKEN: 't', GITHUB_TOKEN: 'g', AWS_SECRET_ACCESS_KEY: 's', AWS_ACCESS_KEY_ID: 'a', DB_PASSWORD: 'p', HF_TOKEN: 'h', TOKENIZERS_PARALLELISM: 'false', ZER0NE_APP_EXE: 'z' });
	assert.deepEqual(Object.keys(env).sort(), ['ComSpec', 'PATH', 'PATHEXT', 'TOKENIZERS_PARALLELISM', 'ZER0NE_APP_EXE']);
	const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.env.FIXTURE_API_KEY))'], { encoding: 'utf8', env: testEnv({ ...process.env, FIXTURE_API_KEY: 'leaked' }) });
	assert.equal(child.stdout, 'undefined');
	console.log('ok  test suites start without API keys, tokens or passwords in the environment');
}
