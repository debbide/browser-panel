const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const launcherPath = path.resolve(__dirname, '../../server/runtime/browser-launcher.js');
const source = fs.readFileSync(launcherPath, 'utf8');

test('stop never kills browsers by UNGATED global process-name match', () => {
  // The old killAllFirefoxProcesses() sledgehammer is gone. A firefox
  // name-based kill exists again because detached firefoxes (ruyipage,
  // playwright-firefox) defeat every scoped signal — but it is gated:
  // never the panel-known manual browser, never while another browser
  // task is active.
  assert.doesNotMatch(source, /function killAllFirefoxProcesses\(\)/);
  assert.doesNotMatch(source, /killAllFirefoxProcesses\(\)/);
  assert.doesNotMatch(source, /pkill.*-f.*firefox/);
  assert.doesNotMatch(source, /taskkill\.exe.*\/IM/);
  assert.doesNotMatch(source, /commands\.push\('pkill -KILL -f firefox/);
  assert.doesNotMatch(source, /hasOtherRuyiRun/);
  assert.doesNotMatch(source, /_forceRuyiBinaryCleanup/);
  // The name-based firefox kill must exist and must carry both gates.
  assert.match(source, /kill_task_firefox\(\) \{/);
  assert.match(source, /_allowBroadFirefoxKill/);
  assert.match(
    source,
    /kill_task_firefox\(\) \{[\s\S]*?is_manual_excluded "\$p" "\$cmd" && continue/
  );
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

test('every run-end path gates the broad firefox kill on sibling tasks', () => {
  // c94deae regression: the sibling gate lived only in stopBrowserTask, so a
  // naturally-ending run fired kill_task_firefox and murdered a concurrent
  // sibling's firefox. The gate helper must exist and every run-end path
  // (natural close, timeout/grace kill, launch error) must use it.
  assert.match(source, /function allowBroadFirefoxKillFor\(taskId\)/);
  const uses = source.match(/_allowBroadFirefoxKill: allowBroadFirefoxKillFor\(task\.id\)/g) || [];
  assert.ok(uses.length >= 3, `expected >=3 gated run-end paths, found ${uses.length}`);
  // stopBrowserTask itself uses the shared helper (one algorithm, not two).
  assert.match(source, /const allowBroadFirefoxKill = allowBroadFirefoxKillFor\(taskId\);/);
  // Delayed cleanup re-checks siblings at fire time: a task starting between
  // schedule and fire must not get its firefox killed.
  assert.match(source, /const fireSnapshot = allowBroadFirefoxKillFor\(taskId\)/);
});
