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

test('terminate kills firefox precisely by profile dir', () => {
  // Precise per-run kill: the panel-assigned profile dir appears verbatim in
  // the firefox cmdline as --profile <dir>. This mirrors ruyipage's own
  // process identification, which prefers the profile dir over the debug port
  // ("more reliable than port lookup": ports collide and get auto-rewritten,
  // profile dirs are unique per instance). Unlike the name-based fallback it
  // can never touch a sibling task's firefox, so it must NOT be gated on
  // sibling activity.
  // (BAP_RUN_ID environ matching would be equally precise, but firefox's
  // environ is unreadable even for root on hardened hosts.)
  assert.match(source, /kill_firefox_by_profile\(\) \{/);
  assert.doesNotMatch(source, /kill_firefox_by_port\(\) \{/);
  assert.doesNotMatch(source, /resolveFirefoxDebugPort\(task\)/);
  // Content processes carry no --profile flag; skip them explicitly like
  // ruyipage does (they die with the main process tree anyway).
  assert.match(source, /\*-contentproc\*\) continue/);
  assert.match(source, /kill_firefox_by_profile TERM/);
  assert.match(source, /kill_firefox_by_profile KILL/);
  // The name-based fallback stays, still gated, for scripts that use a
  // custom user_dir instead of the panel profile dir.
  assert.match(source, /kill_task_firefox TERM \|\| true/);
});

test('firefox profile pattern matches only the exact dir', () => {
  const { buildTerminateCommandsByTask } = require('../../server/runtime/browser-launcher');
  const dir = '/tmp/fake-profiles/task-7-run-9-tmp';
  const cmds = buildTerminateCommandsByTask({
    id: 7,
    _runId: 'run-9',
    _effectiveUserDataDir: dir,
    _allowBroadFirefoxKill: true,
  });
  const line = cmds.find((c) => c.startsWith('kill_firefox_by_profile TERM '));
  assert.ok(line, 'expected a profile-based TERM command');
  const pat = line.match(/'([^']+)'/)[1];
  const re = new RegExp(pat);
  // Exact dir matches (space- and equals-form).
  assert.ok(re.test(`firefox --remote-debugging-port=20363 --profile ${dir} --marionette`));
  assert.ok(re.test(`firefox --profile=${dir}`));
  // Sibling run dir sharing a prefix must NOT match (boundary guard).
  assert.ok(!re.test(`firefox --profile /tmp/fake-profiles/task-7-run-90-tmp --marionette`));
  assert.ok(!re.test(`firefox --profile /tmp/fake-profiles/task-7-run-9-tmp-extra --marionette`));
  // A different task's dir must not match.
  assert.ok(!re.test('firefox --profile /tmp/fake-profiles/task-8-run-1-tmp --marionette'));
});
