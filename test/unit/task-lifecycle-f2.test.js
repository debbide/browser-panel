const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-f2-'));
process.env.PANEL_RUNTIME_ROOT = runtimeRoot;

const config = require('../../config');
const db = require('../../server/db');
const { runTask, stopAllTasks, getActiveTaskIds } = require('../../server/task-runner');

test.after(() => {
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
});

test('interruptStaleTaskRuns heals runs orphaned by a previous process', () => {
  const now = new Date().toISOString();
  const mkTask = (name) => db.db.prepare(
    'INSERT INTO tasks (name, script_path) VALUES (?, ?)',
  ).run(name, 'x.sh').lastInsertRowid;
  const t1 = mkTask('f2 stale owner');
  const t2 = mkTask('f2 finished owner');
  const base = {
    started_at: now, ended_at: null, exit_code: null,
    log_path: null, screenshot_path: null, error_text: null,
  };
  const stale = db.createRun(t1, { ...base, status: 'running' });
  const finished = db.createRun(t2, { ...base, status: 'success', ended_at: now });

  const healed = db.interruptStaleTaskRuns();
  assert.equal(healed, 1);

  const after = db.getRun(stale.id);
  assert.equal(after.status, 'interrupted');
  assert.ok(after.ended_at, 'ended_at must be set');
  assert.equal(after.error_code, 'interrupted');
  assert.match(after.error_text || '', /restarted/i);

  const untouched = db.getRun(finished.id);
  assert.equal(untouched.status, 'success');
  assert.equal(untouched.ended_at, now);

  // Idempotent: second call heals nothing.
  assert.equal(db.interruptStaleTaskRuns(), 0);
});

test('stopAllTasks stops running foreground tasks and drains the registry', async () => {
  const taskId = 9903;
  const scriptPath = path.join(config.paths.tasksDir, 'f2-stopall-test.sh');
  const logPath = path.join(config.paths.logsDir, 'f2-stopall-test.log');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, '#!/bin/sh\nexec sleep 30\n');

  const running = runTask({
    id: taskId,
    name: 'f2 stop-all test',
    type: 'shell',
    script_path: scriptPath,
    use_browser: 0,
    timeout_sec: 60,
  }, { logPath });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(getActiveTaskIds(), [taskId]);

  const stopped = await stopAllTasks({ timeoutMs: 15000 });
  assert.equal(stopped, 1);
  assert.deepEqual(getActiveTaskIds(), [], 'registry must drain after stop-all');

  const result = await running;
  assert.equal(result.status, 'failed');
});

test('F2: no new task starts while shutting down (503, no run row)', async () => {
  const app = require('../../server/application');
  const scriptPath = path.join(config.paths.tasksDir, 'f2-shutdown-guard.sh');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, '#!/bin/sh\necho ok\n');
  const taskId = db.db.prepare('INSERT INTO tasks (name, script_path) VALUES (?, ?)').run('f2 shutdown guard', 'f2-shutdown-guard.sh').lastInsertRowid;
  const runsBefore = db.db.prepare("SELECT COUNT(*) AS n FROM task_runs WHERE task_id = ?").get(taskId).n;
  app.__setShuttingDown(true);
  try {
    const res = await app.triggerTaskExecution(taskId);
    assert.equal(res.ok, false);
    assert.equal(res.status, 503);
    assert.equal(res.payload.code, 'shutting_down');
    const runsAfter = db.db.prepare("SELECT COUNT(*) AS n FROM task_runs WHERE task_id = ?").get(taskId).n;
    assert.equal(runsAfter, runsBefore, 'no run row may be created while shutting down');
    await assert.rejects(app.executeTask(taskId), /shutting down/);
  } finally {
    app.__setShuttingDown(false);
  }
  // Guard off again: a normal trigger is accepted (202, run row created).
  const res2 = await app.triggerTaskExecution(taskId);
  assert.equal(res2.ok, true);
  assert.equal(res2.status, 202);
});
