// Host contract checks with literal NUL Git records and a real temporary filesystem.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript-classic');
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/host/workspaceHost.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function setup(t) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-details-'));
 t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
 let status = '', numstat = '', error, original = 'old\n', fileCalls = 0;
 const root = { scheme: 'file', fsPath: dir }, posts = [], calls = [];
 const module = { exports: {} };
 vm.runInNewContext(code, { module, exports: module.exports, Buffer, TextDecoder, process, setTimeout: () => ({ unref() {} }), require: name => ({
  fs, path, vscode: { Uri: { file: fsPath => ({ fsPath }) }, workspace: { fs: { readFile: uri => fs.promises.readFile(uri.fsPath) }, findFiles: async () => { fileCalls++; return [{ fsPath: path.join(dir, 'file') }]; }, asRelativePath: () => 'file' }, RelativePattern: class {} },
  child_process: { execFile: (_file, args, options, callback) => { calls.push(args); if (error && args[0] === 'status') callback(new Error(error), '', error); else callback(null, args[0] === 'status' ? status : args[0] === 'diff' ? numstat : args[0] === 'show' ? original : 'main\n', ''); } },
  '../tools/agentTools': { workspaceRoot: () => root, resolveInWorkspace: p => ({ fsPath: path.resolve(dir, p) }) }, '../providerStore': { newId: () => 'id' }, './mentions': {}
 }[name]) });
 const host = new module.exports.WorkspaceHost({}, new Map());
 return { dir, host, calls, posts, surface: { post: msg => posts.push(msg) }, setStatus: x => status = x, setNumbers: x => numstat = x, setError: x => error = x, setOriginal: x => original = x, fileCalls: () => fileCalls };
}
test('NUL status/numstat preserve Unicode, spaces, quotes, tabs, newline and rename destinations', async t => {
 const f = setup(t), names = [' spaced ', 'quote".txt', 'tab\tfile', 'line\nfile', '中文 -> literal'];
 f.setStatus(names.map(n => ' M ' + n + '\0').join('') + 'R  renamed\0old\0');
 f.setNumbers(names.map(n => '2\t1\t' + n + '\0').join('') + '3\t4\t\0old\0renamed\0');
 await f.host.handle(f.surface, { type: 'getGitStatus' });
 const msg = f.posts[0];
 assert.deepEqual(Array.from(msg.changes, c => c.path), [...names, 'renamed']);
 assert.equal(msg.changes.at(-1).originalPath, 'old'); assert.equal(msg.added, 13); assert.equal(msg.removed, 9);
 assert.ok(f.calls.some(args => args.includes('-z')));
});
test('non-Git failure is explicit, not an empty clean tree', async t => {
 const f = setup(t); f.setError('fatal: not a git repository');
 await f.host.handle(f.surface, { type: 'getGitStatus' });
 assert.match(f.posts[0].error, /not a git repository/); assert.equal(f.posts[0].changes.length, 0);
});
test('in-page diff handles modified, untracked, deleted, rename and no native editor', async t => {
 const f = setup(t); fs.writeFileSync(path.join(f.dir, 'file.txt'), '<script>new</script>');
 for (const [status, expected] of [[' M file.txt\0', 'old\n'], ['?? file.txt\0', ''], ['R  file.txt\0before.txt\0', 'old\n']]) {
  f.setStatus(status); await f.host.handle(f.surface, { type: 'gitOpenDiff', path: 'file.txt', inPage: true });
  assert.equal(f.posts.at(-1).original, expected); assert.equal(f.posts.at(-1).modified, '<script>new</script>');
 }
 assert.ok(f.calls.some(a => a[0] === 'show' && a[1] === 'HEAD:before.txt'));
 fs.unlinkSync(path.join(f.dir, 'file.txt')); f.setStatus(' D file.txt\0');
 await f.host.handle(f.surface, { type: 'gitOpenDiff', path: 'file.txt', inPage: true }); assert.equal(f.posts.at(-1).modified, '', JSON.stringify(f.posts.at(-1)));
});
test('diff rejects arbitrary/traversal paths, binary and oversized content', async t => {
 const f = setup(t); f.setStatus('?? file.txt\0');
 await f.host.handle(f.surface, { type: 'gitOpenDiff', path: '../secret', inPage: true }); assert.match(f.posts.at(-1).error, /change list/);
 f.setStatus('?? ../secret\0'); await f.host.handle(f.surface, { type: 'gitOpenDiff', path: '../secret', inPage: true }); assert.match(f.posts.at(-1).error, /inside the workspace/);
 f.setStatus('?? file.txt\0'); fs.writeFileSync(path.join(f.dir, 'file.txt'), Buffer.from([0, 1]));
 await f.host.handle(f.surface, { type: 'gitOpenDiff', path: 'file.txt', inPage: true }); assert.match(f.posts.at(-1).error, /Binary/);
 fs.writeFileSync(path.join(f.dir, 'file.txt'), 'x'.repeat(256 * 1024 + 1));
 await f.host.handle(f.surface, { type: 'gitOpenDiff', path: 'file.txt', inPage: true }); assert.match(f.posts.at(-1).error, /too large/);
});
test('Explorer force refresh bypasses a populated workspace file cache', async t => {
 const f = setup(t); await f.host.workspaceFiles(); await f.host.workspaceFiles(); assert.equal(f.fileCalls(), 1);
 await f.host.handle(f.surface, { type: 'getFiles', refresh: true }); assert.equal(f.fileCalls(), 2);
});

test('file preview rejects sibling-prefix paths and escaping junctions while retaining in-project links', async t => {
 const f = setup(t), outside = f.dir + '-neighbor';
 fs.mkdirSync(outside); t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
 fs.writeFileSync(path.join(outside, 'private.txt'), 'private-neighbor-content');
 fs.mkdirSync(path.join(f.dir, 'inside')); fs.writeFileSync(path.join(f.dir, 'inside', 'ok.txt'), 'workspace-content');
 fs.symlinkSync(outside, path.join(f.dir, 'escape'), 'junction');
 fs.symlinkSync(path.join(f.dir, 'inside'), path.join(f.dir, 'linked'), 'junction');
 for (const name of [path.join(outside, 'private.txt'), path.join(f.dir, 'escape', 'private.txt'), '../' + path.basename(outside) + '/private.txt']) {
  await f.host.handle(f.surface, { type: 'previewFile', path: name });
  assert.match(f.posts.at(-1).error, /inside the workspace/); assert.equal(f.posts.at(-1).content, undefined);
 }
 for (const name of ['inside/ok.txt', path.join(f.dir, 'inside', 'ok.txt'), 'linked/ok.txt']) {
  await f.host.handle(f.surface, { type: 'previewFile', path: name });
  assert.equal(f.posts.at(-1).content, 'workspace-content');
 }
});
