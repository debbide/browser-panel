const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-runner-'));
process.env.PANEL_RUNTIME_ROOT = runtimeRoot;

const config = require('../../config');
const { runTask, stopTask } = require('../../server/task-runner');

test.after(() => {
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
});

test('runTask executes a foreground shell task and captures its output', async () => {
  const scriptPath = path.join(config.paths.tasksDir, 'runtime-shell-test.sh');
  const logPath = path.join(config.paths.logsDir, 'runtime-shell-test.log');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, '#!/bin/sh\nprintf "runtime-ok\\n"\n');

  const result = await runTask({
    id: 9101,
    name: 'runtime shell test',
    type: 'shell',
    script_path: scriptPath,
    use_browser: 0,
    timeout_sec: 30,
  }, { logPath });

  assert.equal(result.status, 'success');
  assert.equal(result.exitCode, 0);
  assert.match(fs.readFileSync(logPath, 'utf8'), /runtime-ok/);
});

test('stopTask interrupts an active foreground process', async () => {
  const taskId = 9102;
  const scriptPath = path.join(config.paths.tasksDir, 'runtime-interrupt-test.sh');
  const logPath = path.join(config.paths.logsDir, 'runtime-interrupt-test.log');
  fs.writeFileSync(scriptPath, '#!/bin/sh\nexec sleep 30\n');
  const running = runTask({
    id: taskId,
    name: 'runtime interrupt test',
    type: 'shell',
    script_path: scriptPath,
    use_browser: 0,
    timeout_sec: 30,
  }, { logPath });
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(stopTask(taskId), true);
  const result = await running;
  assert.equal(result.status, 'failed');
  assert.notEqual(result.exitCode, 0);
  assert.equal(stopTask(taskId), false);
});
