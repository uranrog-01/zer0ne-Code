'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const OUT = process.env.ZER0NE_TEST_ENGINE_OUT || path.resolve(__dirname, '../out');
const { agentDocChain } = require(path.join(OUT, 'host/agentDocs'));

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-agent-docs-')));
const repo = path.join(base, 'repo');
const packages = path.join(repo, 'packages');
const app = path.join(packages, 'app');
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
fs.mkdirSync(app, { recursive: true });
fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# root\n');
fs.writeFileSync(path.join(packages, 'AGENTS.md'), '# packages\n');
fs.writeFileSync(path.join(app, 'AGENTS.md'), '# app\n');

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test('agent docs run from the repository root down to the workspace', () => {
	assert.deepEqual(agentDocChain(repo), [path.join(repo, 'AGENTS.md')]);
	assert.deepEqual(agentDocChain(packages), [path.join(repo, 'AGENTS.md'), path.join(packages, 'AGENTS.md')]);
	assert.deepEqual(agentDocChain(app), [path.join(repo, 'AGENTS.md'), path.join(packages, 'AGENTS.md'), path.join(app, 'AGENTS.md')]);
});

test('AGENTS.override.md replaces AGENTS.md in its own directory only', () => {
	const override = path.join(app, 'AGENTS.override.md');
	fs.writeFileSync(override, '# app local\n');
	try {
		assert.deepEqual(agentDocChain(app), [path.join(repo, 'AGENTS.md'), path.join(packages, 'AGENTS.md'), override]);
		assert.deepEqual(agentDocChain(packages), [path.join(repo, 'AGENTS.md'), path.join(packages, 'AGENTS.md')]);
	} finally {
		fs.rmSync(override, { force: true });
	}
});

test('outside a repository only the workspace directory counts', () => {
	const solo = path.join(base, 'solo');
	fs.mkdirSync(solo, { recursive: true });
	fs.writeFileSync(path.join(solo, 'AGENTS.md'), '# solo\n');
	assert.deepEqual(agentDocChain(solo), [path.join(solo, 'AGENTS.md')]);
});

test('a worktree .git file still marks the repository root', () => {
	const worktree = path.join(base, 'worktree');
	fs.mkdirSync(path.join(worktree, 'pkg'), { recursive: true });
	fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: ../repo/.git/worktrees/wt\n');
	fs.writeFileSync(path.join(worktree, 'AGENTS.md'), '# worktree\n');
	assert.deepEqual(agentDocChain(path.join(worktree, 'pkg')), [path.join(worktree, 'AGENTS.md')]);
});
