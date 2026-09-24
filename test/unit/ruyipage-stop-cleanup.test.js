const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const launcherPath = path.resolve(__dirname, '../../server/runtime/browser-launcher.js');
const source = fs.readFileSync(launcherPath, 'utf8');

test('stop never kills browsers by global process-name match', () => {
  // The old killAllFirefoxProcesses() sledgehammer is gone: stopping one task
  // must not murder every Firefox on the machine (other tasks, manual browser,
  // the user's own browser).
  assert.doesNotMatch(source, /function killAllFirefoxProcesses\(\)/);
  assert.doesNotMatch(source, /killAllFirefoxProcesses\(\)/);
  assert.doesNotMatch(source, /pkill.*-f.*firefox/);
  assert.doesNotMatch(source, /taskkill\.exe.*\/IM/);
  assert.doesNotMatch(source, /commands\.push\('pkill -KILL -f firefox/);
  assert.doesNotMatch(source, /hasOtherRuyiRun/);
  assert.doesNotMatch(source, /_forceRuyiBinaryCleanup/);
});

test('stop uses the recorded child pid for a scoped tree kill', () => {
  assert.match(source, /function killChildTree\(pid, force\)/);
  // Windows: tree kill by pid, never by image name.
  assert.match(source, /\['\/PID', String\(id\), '\/T'\]/);
  assert.match(source, /windowsHide: true/);
  // POSIX: negative-pid group kill on the recorded pid only.
  assert.match(source, /process\.kill\(-id, force \? 'SIGKILL' : 'SIGTERM'\)/);
  assert.match(source, /signalTree\(false\)/);
  assert.match(source, /setTimeout\(\(\) => signalTree\(true\), 1500\)/);
});
