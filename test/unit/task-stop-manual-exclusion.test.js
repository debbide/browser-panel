const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');

const launcher = require('../../server/runtime/browser-launcher');
const {
  buildOrphanSbChromeCleanupCommands,
  buildTerminateCommandsByTask,
  collectProcessTreePids,
  getManualBrowserExclusion,
} = launcher;

const BROWSER_PATH = require.resolve('../../server/browser');

function stubManualBrowser(status) {
  require.cache[BROWSER_PATH] = {
    id: BROWSER_PATH,
    filename: BROWSER_PATH,
    loaded: true,
    exports: { getManualBrowserStatus: () => status },
  };
}

function unstubManualBrowser() {
  delete require.cache[BROWSER_PATH];
}

// Extract a generated bash function block by name (trimmed match on braces).
function extractFn(script, name) {
  const lines = script.split('\n');
  const start = lines.findIndex((l) => l.trim() === `${name}() {`);
  assert.ok(start >= 0, `${name} not found in generated script`);
  let end = start + 1;
  while (end < lines.length && lines[end].trim() !== '}') end++;
  assert.ok(end < lines.length, `${name} has no closing brace`);
  return lines.slice(start, end + 1).join('\n');
}

function runBashHarness(preludeLines, invoke) {
  const harness = ['#!/usr/bin/env bash', ...preludeLines, invoke, ''].join('\n');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bap-excl-test-')), 'h.sh');
  fs.writeFileSync(file, harness, { mode: 0o700 });
  try {
    const result = spawnSync('/bin/bash', [file], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, `bash harness failed: ${result.stderr}`);
    return result.stdout;
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

test('collectProcessTreePids finds a real spawned tree', () => {
  // Build a real tree: bash -> sleep x2. collectProcessTreePids must see both.
  const child = spawn('/bin/bash', ['-c', 'sleep 60 & sleep 61 & wait'], { detached: true });
  try {
    const tree = collectProcessTreePids(child.pid);
    assert.ok(tree.includes(child.pid), 'tree must include the root pid');
    assert.ok(tree.length >= 3, `tree should include both sleeps, got ${tree}`);
    for (const p of tree) {
      assert.ok(Number.isInteger(p) && p > 0, `pid must be a positive int, got ${p}`);
    }
  } finally {
    for (const p of collectProcessTreePids(child.pid)) {
      try { process.kill(p, 'SIGKILL'); } catch { /* already gone */ }
    }
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }
});

test('collectProcessTreePids on a dead pid returns just that pid', () => {
  const tree = collectProcessTreePids(42424242);
  assert.deepEqual(tree, [42424242]);
});

test('getManualBrowserExclusion returns null when manual browser is closed', () => {
  stubManualBrowser({ open: false, pid: 0, userDataDir: '' });
  try {
    assert.equal(getManualBrowserExclusion(), null);
  } finally {
    unstubManualBrowser();
  }
});

test('getManualBrowserExclusion returns null when browser module is missing', () => {
  stubManualBrowser(null);
  // getManualBrowserStatus returns null -> treated as closed
  try {
    assert.equal(getManualBrowserExclusion(), null);
  } finally {
    unstubManualBrowser();
  }
});

test('orphan sweep: manual tree pid is excluded, task chrome is not', () => {
  stubManualBrowser({ open: true, pid: 42424242, userDataDir: '' });
  let script;
  try {
    const commands = buildOrphanSbChromeCleanupCommands({ aggressive: true, extraUserDataDirs: [] });
    script = commands.join('\n');
  } finally {
    unstubManualBrowser();
  }
  // The (dead) manual pid is baked into the exclusion list, space-padded.
  assert.ok(script.includes("manual_excluded_pids=' 42424242 '"), 'manual pid must be baked into exclusion list');
  const fn = extractFn(script, 'is_manual_excluded');
  const out = runBashHarness(
    ["manual_excluded_pids=' 42424242 '", "manual_excluded_udir=''", fn],
    'is_manual_excluded 42424242 "chrome --user-data-dir=/tmp/tmpXYZ"; echo "excluded=$?"; ' +
    'is_manual_excluded 777 "chrome --user-data-dir=/tmp/tmpXYZ"; echo "other=$?"'
  );
  assert.ok(out.includes('excluded=0'), `manual pid must be excluded:\n${out}`);
  assert.ok(out.includes('other=1'), `unrelated pid must not be excluded:\n${out}`);
});

test('orphan sweep: manual user-data-dir is excluded even when detached', () => {
  stubManualBrowser({ open: true, pid: 0, userDataDir: '/manual/persistent' });
  let script;
  try {
    const commands = buildOrphanSbChromeCleanupCommands({ aggressive: true, extraUserDataDirs: [] });
    script = commands.join('\n');
  } finally {
    unstubManualBrowser();
  }
  assert.ok(script.includes("manual_excluded_udir='/manual/persistent'"));
  const fn = extractFn(script, 'is_manual_excluded');
  const out = runBashHarness(
    ["manual_excluded_pids=' '", "manual_excluded_udir='/manual/persistent'", fn],
    'is_manual_excluded 111 "chrome --user-data-dir=/manual/persistent --x"; echo "manual=$?"; ' +
    'is_manual_excluded 222 "chrome --user-data-dir=/tmp/tmpABC --x"; echo "task=$?"'
  );
  assert.ok(out.includes('manual=0'), `manual udir must be excluded:\n${out}`);
  assert.ok(out.includes('task=1'), `task udir must not be excluded:\n${out}`);
});

test('orphan sweep: no manual browser -> empty exclusion, nothing skipped', () => {
  stubManualBrowser({ open: false, pid: 0, userDataDir: '' });
  let script;
  try {
    const commands = buildOrphanSbChromeCleanupCommands({ aggressive: true, extraUserDataDirs: [] });
    script = commands.join('\n');
  } finally {
    unstubManualBrowser();
  }
  assert.ok(script.includes("manual_excluded_pids=' '"), 'empty exclusion list expected');
  const fn = extractFn(script, 'is_manual_excluded');
  const out = runBashHarness(
    ["manual_excluded_pids=' '", "manual_excluded_udir=''", fn],
    'is_manual_excluded 999 "chrome --user-data-dir=/tmp/tmpABC"; echo "rc=$?"'
  );
  assert.ok(out.includes('rc=1'), `nothing may be excluded when manual browser is closed:\n${out}`);
});

test('task-firefox kill: emitted for any stack, not just ruyipage', () => {
  stubManualBrowser({ open: false, pid: 0, userDataDir: '' });
  let script;
  try {
    const task = {
      id: 7,
      _runId: 'run-9',
      _runtimeStack: 'playwright',
      _profile: null,
      _effectiveUserDataDir: '/tmp/profiles/task-7',
      _launcherPid: 0,
    };
    script = buildTerminateCommandsByTask(task).join('\n');
  } finally {
    unstubManualBrowser();
  }
  assert.ok(
    script.includes('kill_task_firefox TERM || true'),
    'firefox name-kill must run for non-ruyipage stacks too'
  );
  assert.ok(
    script.includes('kill_task_firefox KILL || true'),
    'firefox name-kill KILL pass must run for non-ruyipage stacks too'
  );
});

test('task-firefox kill: name match kills detached firefox even without profile/binary on cmdline', () => {
  stubManualBrowser({ open: false, pid: 0, userDataDir: '' });
  let script;
  try {
    const task = {
      id: 7,
      _runId: 'run-9',
      _runtimeStack: 'playwright',
      _profile: null,
      _effectiveUserDataDir: '/tmp/profiles/task-7',
      _launcherPid: 0,
    };
    script = buildTerminateCommandsByTask(task).join('\n');
  } finally {
    unstubManualBrowser();
  }
  const fn = extractFn(script, 'kill_task_firefox');
  const stubs = [
    'pgrep() {',
    // $1 = task firefox detached into its own session, env scrubbed, and the
    //      cmdline carries NEITHER the task profile dir NOR the ruyi binary path
    //      (the exact case the old profile/binary matching missed).
    // $2 = geckodriver of the same run (must die too).
    '  printf "%s\\n" "1234 /usr/local/bin/firefox-bin --headless --marionette" "2345 /usr/bin/geckodriver --port 4444";',
    '}',
    'owner_ok() { return 0; }',
    'is_manual_excluded() { return 1; }',
    'kill_tree() { echo "TREE_TERM $1"; }',
    'kill_tree_kill() { echo "TREE_KILL $1"; }',
  ];
  const out = runBashHarness([...stubs, fn], 'kill_task_firefox TERM');
  assert.ok(out.includes('TREE_TERM 1234'), `detached task firefox must be tree-killed:\n${out}`);
  assert.ok(out.includes('TREE_TERM 2345'), `geckodriver must be tree-killed:\n${out}`);
  assert.ok(
    out.includes('[terminate] task-firefox pid=1234 signal=TERM'),
    `kill must be logged for diagnostics:\n${out}`
  );
});

test('task-firefox kill: manual browser firefox is excluded', () => {
  stubManualBrowser({ open: true, pid: 42424242, userDataDir: '' });
  let script;
  try {
    const task = {
      id: 7,
      _runId: 'run-9',
      _profile: null,
      _effectiveUserDataDir: '/tmp/profiles/task-7',
      _launcherPid: 0,
    };
    script = buildTerminateCommandsByTask(task).join('\n');
  } finally {
    unstubManualBrowser();
  }
  const fn = extractFn(script, 'kill_task_firefox');
  const stubs = [
    'pgrep() { printf "%s\\n" "42424242 /opt/ruyipage-firefox/firefox --marionette"; }',
    'owner_ok() { return 0; }',
    // Manual session pid itself is excluded -> whole tree is protected.
    'is_manual_excluded() { [ "$1" = "42424242" ] && return 0; return 1; }',
    'kill_tree() { echo "TREE_TERM $1"; }',
    'kill_tree_kill() { echo "TREE_KILL $1"; }',
  ];
  const out = runBashHarness([...stubs, fn], 'kill_task_firefox TERM; echo done');
  assert.ok(!out.includes('TREE_TERM'), `manual firefox must be spared:\n${out}`);
});

test('task-firefox kill: skipped while another browser task is active', () => {
  stubManualBrowser({ open: false, pid: 0, userDataDir: '' });
  let script;
  try {
    const task = {
      id: 7,
      _runId: 'run-9',
      _profile: null,
      _effectiveUserDataDir: '/tmp/profiles/task-7',
      _launcherPid: 0,
      _allowBroadFirefoxKill: false,
    };
    script = buildTerminateCommandsByTask(task).join('\n');
  } finally {
    unstubManualBrowser();
  }
  assert.ok(
    !script.includes('kill_task_firefox TERM'),
    'name-based firefox kill must be skipped when a sibling browser task is active'
  );
  assert.ok(
    !script.includes('kill_task_firefox KILL'),
    'name-based firefox KILL must be skipped when a sibling browser task is active'
  );
});
