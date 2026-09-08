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

test('runTask contains foreground spawn failures without terminating the panel', async () => {
  const originalPath = process.env.PATH;
  const logPath = path.join(config.paths.logsDir, 'runtime-spawn-error.log');
  process.env.PATH = '';
  try {
    const result = await runTask({
      id: 9103,
      name: 'runtime spawn error test',
      type: 'php',
      script_path: path.join(config.paths.tasksDir, 'missing.php'),
      use_browser: 0,
      timeout_sec: 30,
    }, { logPath });

    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'script_error');
    assert.match(result.errorText, /spawn php ENOENT/);
    assert.match(fs.readFileSync(logPath, 'utf8'), /spawn php ENOENT/);
  } finally {
    process.env.PATH = originalPath;
  }
});

test('runTask falls back to system python when the virtual environment is absent', async () => {
  const scriptPath = path.join(config.paths.tasksDir, 'runtime-python-fallback.py');
  const logPath = path.join(config.paths.logsDir, 'runtime-python-fallback.log');
  fs.writeFileSync(scriptPath, 'print("python-fallback-ok")\n');

  const result = await runTask({
    id: 9104,
    name: 'runtime python fallback test',
    type: 'python',
    script_path: scriptPath,
    use_browser: 0,
    timeout_sec: 30,
  }, { logPath });

  assert.equal(result.status, 'success');
  assert.equal(result.exitCode, 0);
  assert.match(fs.readFileSync(logPath, 'utf8'), /python-fallback-ok/);
});

test('runTask bounds captured request output while preserving the full log', async () => {
  const scriptPath = path.join(config.paths.tasksDir, 'runtime-large-output-test.sh');
  const logPath = path.join(config.paths.logsDir, 'runtime-large-output-test.log');
  fs.writeFileSync(scriptPath, '#!/bin/sh\nyes x | head -c 2097152\nprintf "request-complete\\n"\n');

  const result = await runTask({
    id: 9104,
    name: 'runtime large output test',
    type: 'shell',
    script_path: scriptPath,
    use_browser: 0,
    timeout_sec: 30,
  }, { logPath });

  assert.equal(result.status, 'success');
  assert.ok(fs.statSync(logPath).size > 2 * 1024 * 1024);
  assert.match(fs.readFileSync(logPath, 'utf8'), /request-complete/);
});
