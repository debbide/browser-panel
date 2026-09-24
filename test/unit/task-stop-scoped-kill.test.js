const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const test = require('node:test');

const { killChildTree } = require('../../server/runtime/browser-launcher');

const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test('killChildTree terminates only the recorded pid, spares same-name siblings', async (t) => {
  if (process.platform === 'win32') t.skip('POSIX-only behavioral check');
  const victim = spawn('sleep', ['30'], { stdio: 'ignore', detached: true });
  const bystander = spawn('sleep', ['30'], { stdio: 'ignore', detached: true });
  victim.unref(); bystander.unref();
  t.after(() => { try { victim.kill('SIGKILL'); } catch {} try { bystander.kill('SIGKILL'); } catch {} });
  assert.ok(isAlive(victim.pid) && isAlive(bystander.pid));

  assert.equal(killChildTree(victim.pid, true), true);
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(isAlive(victim.pid), false, 'recorded pid must be dead');
  assert.equal(isAlive(bystander.pid), true, 'same-name sibling must survive');
});

test('killChildTree returns false for bogus pids without throwing', () => {
  if (process.platform === 'win32') return;
  assert.equal(killChildTree(0, false), false);
  assert.equal(killChildTree(-1, true), false);
  assert.equal(killChildTree(99999999, true), false);
});
