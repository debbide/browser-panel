// Must be set before config is first required (fresh process per test file).
process.env.PANEL_RUNTIME_ROOT = require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'browser-panel-s2-')
);

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const config = require('../../config');
const { resolveTaskScriptForRuntime } = require('../../server/runtime/browser-launcher');

const tasksDir = config.paths.tasksDir;
fs.mkdirSync(path.join(tasksDir, 'sub'), { recursive: true });
fs.writeFileSync(path.join(tasksDir, 'legit.js'), 'console.log(1);\n');
fs.writeFileSync(path.join(tasksDir, 'sub', 'deep.py'), 'print(1)\n');
const outsideSecret = path.join(path.dirname(tasksDir), 'outside-secret.txt');
fs.writeFileSync(outsideSecret, 'top-secret\n');
try { fs.unlinkSync(path.join(tasksDir, 'evil-link')); } catch { /* ignore */ }
fs.symlinkSync(outsideSecret, path.join(tasksDir, 'evil-link'));

test('S2: legitimate task scripts resolve inside tasks/', () => {
  const r = resolveTaskScriptForRuntime('tasks/legit.js');
  assert.equal(r.baseName, 'legit.js');
  assert.ok(r.absPath.startsWith(tasksDir + path.sep));
  const nested = resolveTaskScriptForRuntime('tasks/sub/deep.py');
  assert.equal(nested.baseName, 'deep.py');
});

test('S2: absolute paths are rejected', () => {
  assert.throws(() => resolveTaskScriptForRuntime('/root/.ssh/id_rsa'), /必须位于 tasks\/ 下/);
  assert.throws(() => resolveTaskScriptForRuntime('/etc/passwd'), /必须位于 tasks\/ 下/);
});

test('S2: dot-dot escapes are rejected', () => {
  assert.throws(() => resolveTaskScriptForRuntime('tasks/../../etc/passwd'), /不合法|越界/);
  assert.throws(() => resolveTaskScriptForRuntime('tasks/sub/../../../x'), /不合法|越界/);
});

test('S2: symlink escapes are rejected', () => {
  assert.throws(() => resolveTaskScriptForRuntime('tasks/evil-link'), /symlink/);
});

test('S2: empty and blank paths are rejected', () => {
  assert.throws(() => resolveTaskScriptForRuntime(''), /不能为空/);
  assert.throws(() => resolveTaskScriptForRuntime('tasks/'), /不合法/);
});

test('S2: missing scripts fail closed instead of staging something else', () => {
  assert.throws(() => resolveTaskScriptForRuntime('tasks/no-such-file.js'), /不存在/);
});
