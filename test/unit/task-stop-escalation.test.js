const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const test = require('node:test');

const { terminateChild, taskKillGraceMs } = require('../../server/task-runner');

test('taskKillGraceMs defaults to 10s', () => {
  assert.equal(taskKillGraceMs(), 10000);
});

test('terminateChild escalates to SIGKILL when SIGTERM is ignored', async () => {
  // Child traps SIGTERM and never exits on its own. It prints "ready" only
  // after the trap is installed, so the test never races process startup.
  const child = spawn(process.execPath, ['-e', `
    process.on('SIGTERM', () => { /* ignore */ });
    console.log('ready');
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'ignore'] });
  let exited = false;
  child.once('exit', () => { exited = true; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child never became ready')), 5000);
    child.stdout.on('data', (buf) => {
      if (buf.toString().includes('ready')) { clearTimeout(timer); resolve(); }
    });
  });

  terminateChild(child, 300);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(exited, false, 'still alive during grace period');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(exited, true, 'SIGKILL must have ended the SIGTERM-ignoring child');
  assert.equal(child.signalCode, 'SIGKILL');
});

test('terminateChild on an exited child does not throw', () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  return new Promise((resolve) => {
    child.once('exit', () => {
      assert.doesNotThrow(() => terminateChild(child, 10));
      resolve();
    });
  });
});
