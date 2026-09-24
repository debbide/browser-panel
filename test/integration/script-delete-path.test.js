const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { createTaskStorageRouter } = require('../../server/routes/task-storage-routes');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-f11-'));
const tasksDir = path.join(tmp, 'tasks');
fs.mkdirSync(path.join(tasksDir, 'sub'), { recursive: true });
// Decoy: the file the old basename() logic would have wrongly deleted.
fs.writeFileSync(path.join(tasksDir, 'a.js'), 'console.log("root decoy");\n');
fs.writeFileSync(path.join(tasksDir, 'sub', 'a.js'), 'console.log("real target");\n');
fs.writeFileSync(path.join(tasksDir, 'sub', 'note.txt'), 'not a script\n');
const outsideSecret = path.join(tmp, 'outside-secret.txt');
fs.writeFileSync(outsideSecret, 'top-secret\n');
fs.symlinkSync(outsideSecret, path.join(tasksDir, 'link.js'));

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Tasks bound to script paths; mutable per test.
let boundTasks = [];
const app = express();
app.use(express.json());
app.use('/api', createTaskStorageRouter({ fs, path, tasksDir, listTasks: () => boundTasks }));

let server;
let base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
});

async function del(p) {
  const res = await fetch(`${base}/scripts?path=${encodeURIComponent(p)}`, { method: 'DELETE' });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

test('F11: deleting tasks/sub/a.js removes the nested file, not the root decoy', async () => {
  boundTasks = [];
  const { status, body } = await del('tasks/sub/a.js');
  assert.equal(status, 200);
  assert.equal(body.data.path, 'tasks/sub/a.js');
  assert.ok(!fs.existsSync(path.join(tasksDir, 'sub', 'a.js')), 'nested file must be gone');
  assert.ok(fs.existsSync(path.join(tasksDir, 'a.js')), 'root decoy must survive');
});

test('F11: bound script is rejected with 409 and nothing is deleted', async () => {
  fs.writeFileSync(path.join(tasksDir, 'sub', 'b.js'), 'console.log(1);\n');
  boundTasks = [{ id: 7, name: 'uses-b', script_path: 'tasks/sub/b.js' }];
  const { status } = await del('sub/b.js');
  assert.equal(status, 409);
  assert.ok(fs.existsSync(path.join(tasksDir, 'sub', 'b.js')), 'bound file must survive');
  boundTasks = [];
});

test('F11: path traversal is rejected', async () => {
  const { status } = await del('tasks/sub/../../outside-secret.txt');
  assert.equal(status, 400);
  assert.ok(fs.existsSync(outsideSecret), 'outside file must survive');
});

test('F11: symlink escaping tasks/ is rejected', async () => {
  const { status } = await del('tasks/link.js');
  assert.equal(status, 400);
  assert.ok(fs.existsSync(outsideSecret), 'symlink target must survive');
  assert.ok(fs.existsSync(path.join(tasksDir, 'link.js')), 'symlink itself must survive');
});

test('F11: missing script is 404, wrong extension is 400', async () => {
  assert.equal((await del('tasks/sub/nope.js')).status, 404);
  assert.equal((await del('tasks/sub/note.txt')).status, 400);
  assert.ok(fs.existsSync(path.join(tasksDir, 'sub', 'note.txt')), 'txt file must survive');
});
