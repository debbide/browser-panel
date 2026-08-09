const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const config = require('../../config');
const db = require('../db');
const {
  parseTaskParams,
  resolveUseTempProfile,
  resolveEffectiveProxyContract,
  resolveEffectiveLocale,
  resolveEffectiveTimezone,
  buildBrowserUserEnvPairs,
  summarizeEnvPairs,
  applyProxyAliases,
  PROXY_ALIAS_KEYS,
} = require('./env-builder');
const { evaluateLogSuccess, resolveHeuristicsForTask } = require('./success-heuristics');
const activeBrowserRuns = new Map();
/** Delayed terminate timers keyed by taskId — cancelled when a newer run starts. */
const pendingTerminateTimers = new Map();

function getRuntimeDataDir() {
  return path.join(config.paths.root, 'runtime-data');
}

function getTempProfileDir(task, runId = null) {
  // Per-run dir so "临时" is truly disposable (not a sticky task-N-tmp-profile).
  const id = task && task.id != null ? task.id : 'x';
  const run = runId != null && String(runId).trim()
    ? String(runId).trim().replace(/[^\w.-]+/g, '_')
    : `t${Date.now()}`;
  return path.join(getRuntimeDataDir(), 'profiles', `task-${id}-run-${run}-tmp`);
}

/** True if path is under runtime-data/profiles and looks like a panel temp profile. */
function isPanelTempProfileDir(dir) {
  const raw = String(dir || '').trim();
  if (!raw) return false;
  try {
    const resolved = path.resolve(raw);
    const profilesRoot = path.resolve(path.join(getRuntimeDataDir(), 'profiles'));
    if (!resolved.startsWith(profilesRoot + path.sep) && resolved !== profilesRoot) return false;
    const base = path.basename(resolved);
    // New: task-3-run-...-tmp  | legacy sticky: task-3-tmp-profile
    return /^task-.+-tmp(-profile)?$/i.test(base) || /tmp-profile$/i.test(base) || /-tmp$/i.test(base);
  } catch {
    return false;
  }
}

/**
 * After the browser task ends: remove temp profile dirs (panel "临时" = disposable).
 * Never touch named persistent profiles outside runtime-data/profiles temp patterns.
 */
function removeTempProfileDir(dir, { delayMs = 2500 } = {}) {
  const target = String(dir || '').trim();
  if (!target || !isPanelTempProfileDir(target)) return;
  const wait = Math.max(0, Number(delayMs) || 0);
  setTimeout(() => {
    try {
      if (!fs.existsSync(target)) return;
      // Best-effort: Chrome may still be shutting down locks for a moment
      fs.rmSync(target, { recursive: true, force: true });
      console.log(`[browser-launcher] removed temp profile ${target}`);
    } catch (err) {
      console.warn(`[browser-launcher] temp profile cleanup failed: ${target}: ${err.message || err}`);
      // One more try later
      setTimeout(() => {
        try {
          if (fs.existsSync(target)) {
            fs.rmSync(target, { recursive: true, force: true });
            console.log(`[browser-launcher] removed temp profile (retry) ${target}`);
          }
        } catch (e2) {
          console.warn(`[browser-launcher] temp profile cleanup retry failed: ${e2.message || e2}`);
        }
      }, 8000);
    }
  }, wait);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function parsePackageList(value) {
  return String(value || '')
    .split(/[\r\n,;]+/g)
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function shouldUsePlaywrightExtra(settings) {
  const packages = parsePackageList(settings && settings.pluginPackages);
  return Boolean(settings && settings.usePlaywrightExtra) || packages.length > 0;
}

function normalizeRuntimeStack(settings) {
  const stack = String(settings && settings.runtimeStack ? settings.runtimeStack : '').trim().toLowerCase();
  return ['seleniumbase', 'ruyipage'].includes(stack) ? stack : 'playwright';
}

function resolveRuntimeStack(task, settings) {
  const params = parseTaskParams(task);
  const taskStack = String(
    params.BROWSER_RUNTIME_STACK ?? params.browser_runtime_stack ?? ''
  ).trim().toLowerCase();
  if (['playwright', 'seleniumbase', 'ruyipage'].includes(taskStack)) return taskStack;
  const profile = task && task._profile;
  const profileStack = String(profile && profile.runtime_stack ? profile.runtime_stack : '').trim().toLowerCase();
  if (['seleniumbase', 'ruyipage'].includes(profileStack)) return profileStack;
  if (profileStack === 'playwright') return 'playwright';
  return normalizeRuntimeStack(settings);
}

function pickNonEmptyString(...values) {
  for (const value of values) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    if (text) return text;
  }
  return '';
}

function getRuntimeNodeModules() {
  const settings = db.getBrowserRuntimeSettings();
  const modules = ['playwright', 'playwright-core'];
  if (shouldUsePlaywrightExtra(settings)) modules.push('playwright-extra');
  modules.push(...parsePackageList(settings.pluginPackages));
  return Array.from(new Set(modules));
}

function resolvePackageDir(packageName, searchPaths, rootNodeModules) {
  const pathsToTry = Array.from(new Set([
    ...(searchPaths || []),
    rootNodeModules,
  ]));

  try {
    const resolvedEntry = require.resolve(packageName, { paths: pathsToTry });
    let current = path.dirname(resolvedEntry);
    while (current && current !== path.dirname(current)) {
      const manifestPath = path.join(current, 'package.json');
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          if (manifest && manifest.name === packageName) {
            return current;
          }
        } catch {
          // ignore malformed package manifest
        }
      }
      current = path.dirname(current);
    }
  } catch {
    // fallback below
  }

  const directPath = path.join(rootNodeModules, ...packageName.split('/'));
  return fs.existsSync(directPath) ? directPath : null;
}

function collectModuleCopyPairs(entryModules, workerNodeModules) {
  const rootNodeModules = path.join(config.paths.root, 'node_modules');
  const queue = Array.from(new Set(entryModules)).map(name => ({
    name,
    searchPaths: [rootNodeModules],
  }));
  const visitedItems = new Set();
  const visitedDirs = new Set();
  const copies = [];

  while (queue.length) {
    const item = queue.shift();
    const token = `${item.name}|${item.searchPaths.join(';')}`;
    if (visitedItems.has(token)) continue;
    visitedItems.add(token);

    const packageDir = resolvePackageDir(item.name, item.searchPaths, rootNodeModules);
    if (!packageDir || visitedDirs.has(packageDir)) continue;
    visitedDirs.add(packageDir);

    const relativeFromRoot = path.relative(rootNodeModules, packageDir);
    if (!relativeFromRoot || relativeFromRoot.startsWith('..') || path.isAbsolute(relativeFromRoot)) {
      continue;
    }

    copies.push({
      from: packageDir,
      to: path.join(workerNodeModules, relativeFromRoot),
    });

    const manifestPath = path.join(packageDir, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const dependencies = {
        ...(manifest.dependencies || {}),
        ...(manifest.optionalDependencies || {}),
      };
      for (const depName of Object.keys(dependencies)) {
        queue.push({
          name: depName,
          searchPaths: [packageDir, rootNodeModules],
        });
      }
    } catch {
      // ignore malformed package manifest
    }
  }

  return copies;
}

function getBrowserWorkDir() {
  return (config.browser && config.browser.workDir)
    ? String(config.browser.workDir)
    : path.join('/home', config.browser.user || 'browser', 'browser-work');
}

function ensureRuntimeFiles(task) {
  const workerRoot = getBrowserWorkDir();
  const browserUser = String(config.browser.user || 'browser');
  const workerNodeModules = path.join(workerRoot, 'node_modules');
  fs.mkdirSync(workerNodeModules, { recursive: true });
  fs.mkdirSync(path.join(workerRoot, 'screenshots'), { recursive: true });
  fs.mkdirSync(path.join(workerRoot, 'task-results'), { recursive: true });
  // SeleniumBase UC lock/download dirs (browser user must write here)
  const sbWritable = ['downloaded_files', 'assets', 'archived_files'];
  for (const name of sbWritable) {
    const dir = path.join(workerRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.chmodSync(dir, 0o777);
    } catch {
      // ignore
    }
  }
  fs.mkdirSync(path.join(getRuntimeDataDir(), 'profiles'), { recursive: true });
  const moduleCopies = collectModuleCopyPairs(getRuntimeNodeModules(), workerNodeModules);
  const taskSourcePath = path.resolve(config.paths.root, task.script_path);
  const taskSourceDir = path.dirname(taskSourcePath);
  const taskBaseName = path.basename(taskSourcePath);
  const files = [
    ...moduleCopies,
    { from: path.join(config.paths.root, 'server', 'runtime', 'browser-runtime.js'), to: path.join(workerRoot, 'browser-runtime.js') },
    { from: path.join(config.paths.root, 'server', 'runtime', 'js-task-wrapper.js'), to: path.join(workerRoot, 'js-task-wrapper.js') },
    { from: path.join(config.paths.root, 'server', 'runtime', 'ruyipage_adapter.py'), to: path.join(workerRoot, 'ruyipage_adapter.py') },
    { from: taskSourcePath, to: path.join(workerRoot, taskBaseName) },
  ];

  if (task.type === 'python' && fs.existsSync(taskSourceDir)) {
    const pySiblings = fs.readdirSync(taskSourceDir, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
      .filter(name => name.endsWith('.py') && name !== taskBaseName);
    for (const sibling of pySiblings) {
      files.push({
        from: path.join(taskSourceDir, sibling),
        to: path.join(workerRoot, sibling),
      });
    }

    const hcaptchaPackageDir = path.join(config.paths.tasksDir, 'hcaptcha_solver_refactor');
    if (fs.existsSync(hcaptchaPackageDir)) {
      files.push({
        from: hcaptchaPackageDir,
        to: path.join(workerRoot, 'hcaptcha_solver_refactor'),
      });
    }

    const host2playPackageDir = path.join(config.paths.tasksDir, 'host2play_dp');
    if (fs.existsSync(host2playPackageDir)) {
      files.push({
        from: host2playPackageDir,
        to: path.join(workerRoot, 'host2play_dp'),
      });
    }

    // Hax / Woiden renew packages (copied when present under tasks/)
    for (const pkg of ['hax_yolo', 'woiden_yolo']) {
      const pkgDir = path.join(config.paths.tasksDir, pkg);
      if (fs.existsSync(pkgDir)) {
        files.push({
          from: pkgDir,
          to: path.join(workerRoot, pkg),
        });
      }
    }

    // Shared helpers used by Python scripts (panel_callback, etc.)
    // Prefer tasks/lib; fall back to packaged copy under server/runtime/py_lib
    // (upgrade keeps tasks/ intact, so tasks/lib may be missing on older installs).
    const tasksLibDir = path.join(config.paths.tasksDir, 'lib');
    const packagedLibDir = path.join(config.paths.root, 'server', 'runtime', 'py_lib');
    const libFrom = fs.existsSync(path.join(tasksLibDir, 'panel_callback.py'))
      ? tasksLibDir
      : (fs.existsSync(path.join(packagedLibDir, 'panel_callback.py')) ? packagedLibDir : '');
    if (libFrom) {
      files.push({
        from: libFrom,
        to: path.join(workerRoot, 'lib'),
      });
    }
  }

  for (const file of files) {
    if (!fs.existsSync(file.from)) continue;
    if (fs.existsSync(file.to)) fs.rmSync(file.to, { recursive: true, force: true });
    fs.cpSync(file.from, file.to, { recursive: true });
  }
  // Worker node binary: copy current process node (portable; no hard-coded nvm path).
  // Legacy name /tmp/node-openclaw kept so existing su/wrapper commands keep working.
  const workerNodePath = '/tmp/node-openclaw';
  const sourceNode = process.execPath;
  try {
    if (!fs.existsSync(sourceNode)) {
      throw new Error(`Node binary not found: ${sourceNode}`);
    }
    fs.copyFileSync(sourceNode, workerNodePath);
    fs.chmodSync(workerNodePath, 0o755);
  } catch (err) {
    throw new Error(
      `Failed to prepare worker node (${sourceNode} -> ${workerNodePath}): ${err.message}`
    );
  }
  const ch = spawnSync('chown', ['-R', `${browserUser}:${browserUser}`, workerRoot], { encoding: 'utf8' });
  if (ch.status !== 0) {
    console.warn('[browser-launcher] chown failed:', (ch.stderr || ch.stdout || '').trim());
    spawnSync('chmod', ['-R', 'a+rwX', workerRoot], { stdio: 'ignore' });
  }
  for (const name of sbWritable) {
    try { fs.chmodSync(path.join(workerRoot, name), 0o777); } catch { /* ignore */ }
  }
}


/**
 * Build kill commands scoped to THIS run only.
 *
 * Must NOT use:
 *   - pkill -f <script basename>   (kills other tasks sharing the same script)
 *   - pkill -u browser chrome…     (kills every concurrent browser task)
 *
 * Safe signals:
 *   1) launcher PID process tree (bash → setpriv → python/node → chrome children)
 *   2) processes whose environ/cmdline still carries this run's BAP_RUN_ID
 *   3) Chrome bound to this task's temp user-data-dir (task-N-tmp-profile is unique per task)
 */
function buildTerminateCommandsByTask(task) {
  const profile = task && task._profile;
  const params = parseTaskParams(task);
  const useTempProfile = resolveUseTempProfile(task, params);
  const runId = task && task._runId ? String(task._runId) : '';
  const userDataDir = task && task._effectiveUserDataDir
    ? String(task._effectiveUserDataDir)
    : useTempProfile
      ? getTempProfileDir(task, runId || null)
      : (profile && profile.user_data_dir
        ? profile.user_data_dir
        : (task && task.use_persistent
          ? config.browser.userDataDir
          : getTempProfileDir(task, runId || null)));
  const launcherPid = task && task._launcherPid ? Number(task._launcherPid) : 0;
  const taskId = task && task.id != null ? Number(task.id) : 0;
  const runtimeStack = String(task && task._runtimeStack ? task._runtimeStack : '').trim().toLowerCase();
  // Unique token injected as BAP_RUN_ID env on the worker process tree.
  const runMarker = runId
    ? `BAP_RUN_ID=${runId}`
    : (taskId ? `BAP_TASK_ID=${taskId}` : '');

  const killTreeFunc = [
    'kill_tree() {',
    '  local p="$1"',
    '  [ -z "$p" ] && return 0',
    '  for c in $(pgrep -P "$p" 2>/dev/null); do',
    '    kill_tree "$c"',
    '  done',
    '  kill -TERM "$p" 2>/dev/null || true',
    '}',
    'kill_tree_kill() {',
    '  local p="$1"',
    '  [ -z "$p" ] && return 0',
    '  for c in $(pgrep -P "$p" 2>/dev/null); do',
    '    kill_tree_kill "$c"',
    '  done',
    '  kill -KILL "$p" 2>/dev/null || true',
    '}',
    'owner_ok() {',
    '  local p="$1" owner',
    `  local buser=${shellEscape(String((config.browser && config.browser.user) || 'browser').trim())}`,
    '  owner=$(stat -c %U "/proc/$p" 2>/dev/null || true)',
    '  [ -z "$owner" ] || [ "$owner" = "$buser" ] || [ "$owner" = "root" ]',
    '}',
    'kill_run_marker() {',
    '  local sig="$1" marker="$2" e p',
    '  [ -z "$marker" ] && return 0',
    '  for e in /proc/[0-9]*/environ; do',
    '    p="${e#/proc/}"; p="${p%/environ}"',
    '    owner_ok "$p" || continue',
    '    tr "\\0" "\\n" < "$e" 2>/dev/null | grep -Fxq -- "$marker" || continue',
    '    kill "-$sig" "$p" 2>/dev/null || true',
    '  done',
    '}',
    'kill_ruyi_profile() {',
    '  local sig="$1" profile="$2" line p cmd',
    '  [ -z "$profile" ] && return 0',
    '  pgrep -af -- "firefox|geckodriver" 2>/dev/null | while IFS= read -r line; do',
    '    p="${line%% *}"; cmd="${line#* }"',
    '    case "$p" in ""|*[!0-9]*) continue;; esac',
    '    owner_ok "$p" || continue',
    '    printf "%s" "$cmd" | grep -Fq -- "$profile" || continue',
    '    echo "[terminate] ruyipage pid=$p profile=$profile signal=$sig"',
    '    kill "-$sig" "$p" 2>/dev/null || true',
    '  done',
    '}',
  ];

  const commands = [
    ...killTreeFunc,
    `echo "[terminate] task=${taskId || '?'} pid=${launcherPid || 0} run=${runId || '-'} user-data-dir=${userDataDir || ''}"`,
  ];

  // 1) Kill only this launcher process tree (covers python/node + child chrome when still parented)
  if (launcherPid > 0) {
    commands.push(`kill_tree ${launcherPid} || true`);
  }

  // 2) Match the unique run marker in process environments. pkill -f only
  //    examines cmdline, so it cannot find inherited BAP_RUN_ID reliably.
  if (runMarker) {
    commands.push(`kill_run_marker TERM ${shellEscape(runMarker)} || true`);
  }

  // 3) Always kill Chrome bound to THIS task's user-data-dir.
  //    Temp profiles are unique per task. Persistent profiles also must be cleaned when
  //    the run ends — SeleniumBase UC reparents chrome to init so PID-tree kill misses them.
  //    Sharing one persistent profile across concurrent tasks is unsupported.
  if (userDataDir) {
    const udMarker = `--user-data-dir=${userDataDir}`;
    commands.push(`pkill -TERM -f -- ${shellEscape(udMarker)} || true`);
  }
  if (runtimeStack === 'ruyipage' && userDataDir) {
    commands.push(`kill_ruyi_profile TERM ${shellEscape(userDataDir)} || true`);
  }

  commands.push('sleep 1');

  if (launcherPid > 0) {
    commands.push(`kill_tree_kill ${launcherPid} || true`);
  }
  if (runMarker) {
    commands.push(`kill_run_marker KILL ${shellEscape(runMarker)} || true`);
  }
  if (userDataDir) {
    const udMarker = `--user-data-dir=${userDataDir}`;
    commands.push(`pkill -KILL -f -- ${shellEscape(udMarker)} || true`);
  }
  if (runtimeStack === 'ruyipage' && userDataDir) {
    commands.push(`kill_ruyi_profile KILL ${shellEscape(userDataDir)} || true`);
  }

  // 4) SeleniumBase UC orphans: chrome reparented to init after python dies.
  //    Covers /tmp/tmp* AND persistent profiles under browser work dir.
  commands.push(...buildOrphanSbChromeCleanupCommands({
    aggressive: false,
    extraUserDataDirs: userDataDir ? [userDataDir] : [],
  }));

  return commands;
}

/**
 * Kill SeleniumBase leftover Chrome safely.
 * @param {{ aggressive?: boolean, extraUserDataDirs?: string[] }} opts
 *   aggressive=true: only when NO other browser task is active — sweep SB leftovers harder.
 *   aggressive=false: only kill orphans (parent dead / ppid 1).
 *   extraUserDataDirs: also match these profile paths (persistent profiles).
 *
 * Why this exists: SB UC launches chrome as a detached tree. When python exits,
 * chrome reparents to init (ppid=1). PID-tree kill misses them. Persistent
 * profiles (not only /tmp/tmp*) leave multi-GB orphans on small VPS.
 */
function buildOrphanSbChromeCleanupCommands(opts = {}) {
  const aggressive = Boolean(opts.aggressive);
  const browserUser = (config.browser && config.browser.user)
    ? String(config.browser.user).trim()
    : 'browser';
  const workDir = (config.browser && config.browser.workDir)
    ? String(config.browser.workDir).trim()
    : '';
  const extraDirs = Array.isArray(opts.extraUserDataDirs)
    ? opts.extraUserDataDirs.map((d) => String(d || '').trim()).filter(Boolean)
    : [];

  // Patterns: SB temp profiles, browser work profiles, optional exact dirs from this run
  const matchHints = [
    '--user-data-dir=/tmp/tmp',
    workDir ? `--user-data-dir=${workDir}` : '',
    ...extraDirs.map((d) => `--user-data-dir=${d}`),
  ].filter(Boolean);

  const script = [
    'cleanup_sb_orphan_chrome() {',
    `  local aggressive="${aggressive ? '1' : '0'}"`,
    `  local buser=${shellEscape(browserUser)}`,
    '  local line pid ppid udir owner cmd',
    '  is_browser_related() {',
    '    case "$1" in',
    '      *chrome*|*chromium*|*chromedriver*|*uc_driver*|*chrome_crashpad*) return 0 ;;',
    '      *) return 1 ;;',
    '    esac',
    '  }',
    '  is_target_udir() {',
    '    # $1 = full cmdline',
    `    case "$1" in`,
    ...matchHints.map((hint) => `      *${hint.replace(/'/g, '')}*) return 0 ;;`),
    '      *) return 1 ;;',
    '    esac',
    '  }',
    '  should_consider() {',
    '    is_browser_related "$1" || return 1',
    '    # Always consider SB temp profiles + workdir profiles + this-run dirs',
    '    if is_target_udir "$1"; then return 0; fi',
    '    # Aggressive + no concurrent tasks: any browser-user chrome is fair game if orphan',
    '    if [ "$aggressive" = "1" ]; then return 0; fi',
    '    return 1',
    '  }',
    '  owner_ok() {',
    '    local p="$1"',
    '    [ -z "$buser" ] && return 0',
    '    [ ! -r "/proc/$p" ] && return 0',
    '    owner=$(stat -c %U "/proc/$p" 2>/dev/null || true)',
    '    [ -z "$owner" ] && return 0',
    '    [ "$owner" = "$buser" ] || [ "$owner" = "root" ]',
    '  }',
    '  is_orphan() {',
    '    local p="$1" pp',
    '    pp=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d " ")',
    '    if [ -z "$pp" ] || [ "$pp" = "1" ] || [ "$pp" = "0" ]; then return 0; fi',
    '    if ! kill -0 "$pp" 2>/dev/null; then return 0; fi',
    '    return 1',
    '  }',
    '  # Pass 1: TERM orphans / aggressive matches',
    '  pgrep -af -- "chrome|chromium|chromedriver|uc_driver|chrome_crashpad" 2>/dev/null | while IFS= read -r line; do',
    '    pid="${line%% *}"',
    '    case "$pid" in ""|*[!0-9]*) continue;; esac',
    '    cmd="${line#* }"',
    '    should_consider "$cmd" || continue',
    '    owner_ok "$pid" || continue',
    '    orphan=0',
    '    if is_orphan "$pid"; then orphan=1; fi',
    '    if [ "$aggressive" = "1" ] || [ "$orphan" = "1" ]; then',
    '      udir=$(printf "%s" "$cmd" | sed -n "s/.*--user-data-dir=\\([^ ]*\\).*/\\1/p" | head -1)',
    '      echo "[terminate] sb-orphan chrome pid=$pid orphan=$orphan aggressive=$aggressive udir=$udir"',
    '      kill -TERM "$pid" 2>/dev/null || true',
    '    fi',
    '  done',
    '  sleep 1',
    '  # Pass 2: KILL survivors',
    '  pgrep -af -- "chrome|chromium|chromedriver|uc_driver|chrome_crashpad" 2>/dev/null | while IFS= read -r line; do',
    '    pid="${line%% *}"',
    '    case "$pid" in ""|*[!0-9]*) continue;; esac',
    '    cmd="${line#* }"',
    '    should_consider "$cmd" || continue',
    '    owner_ok "$pid" || continue',
    '    orphan=0',
    '    if is_orphan "$pid"; then orphan=1; fi',
    '    if [ "$aggressive" = "1" ] || [ "$orphan" = "1" ]; then',
    '      kill -KILL "$pid" 2>/dev/null || true',
    '    fi',
    '  done',
    '  # Driver leftovers often orphan without user-data-dir',
    '  for pat in chromedriver uc_driver chrome_crashpad_handler; do',
    '    pgrep -af -- "$pat" 2>/dev/null | while IFS= read -r line; do',
    '      pid="${line%% *}"',
    '      case "$pid" in ""|*[!0-9]*) continue;; esac',
    '      owner_ok "$pid" || continue',
    '      if [ "$aggressive" = "1" ] || is_orphan "$pid"; then',
    '        echo "[terminate] sb-orphan driver pid=$pid pat=$pat"',
    '        kill -TERM "$pid" 2>/dev/null || true',
    '        sleep 0.2',
    '        kill -KILL "$pid" 2>/dev/null || true',
    '      fi',
    '    done',
    '  done',
    '  # Remove stale /tmp/tmp* dirs that no longer have a live chrome',
    '  now=$(date +%s)',
    '  for d in /tmp/tmp*; do',
    '    [ -d "$d" ] || continue',
    '    base=$(basename "$d")',
    '    case "$base" in tmp[A-Za-z0-9_]*) ;; *) continue;; esac',
    '    if pgrep -af -- "--user-data-dir=$d" >/dev/null 2>&1; then continue; fi',
    '    mtime=$(stat -c %Y "$d" 2>/dev/null || echo 0)',
    '    age=$((now - mtime))',
    '    if [ "$aggressive" = "1" ] || [ "$age" -ge 45 ]; then',
    '      rm -rf "$d" 2>/dev/null || true',
    '      echo "[terminate] removed stale sb profile $d age=${age}s"',
    '    fi',
    '  done',
    '}',
    'cleanup_sb_orphan_chrome || true',
  ];
  return script;
}

function runTerminateCommands(commands) {
  const script = [
    '#!/usr/bin/env bash',
    'set +e',
    ...commands,
    '',
  ].join('\n');
  const tmpDir = fs.mkdtempSync('/tmp/bap-stop-');
  const scriptPath = path.join(tmpDir, 'terminate.sh');
  fs.writeFileSync(scriptPath, script, { encoding: 'utf8', mode: 0o700 });
  console.log(`[browser-launcher] terminate script=${scriptPath} lines=${commands.length}`);

  let settled = false;
  let stdout = '';
  let stderr = '';
  const child = spawn('/bin/bash', [scriptPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  };
  const report = (result = {}) => {
    if (settled) return;
    settled = true;
    cleanup();
    const out = String(stdout || '').trim();
    const err = String(stderr || '').trim();
    const spawnError = result.error
      ? `${result.error.name || 'Error'}: ${result.error.message || String(result.error)}`
      : '';
    if (result.code !== 0 || result.signal || out || err || spawnError) {
      console.log(
        `[browser-launcher] terminate status=${result.code ?? 'null'} signal=${result.signal || ''}\n` +
        `${spawnError ? `error:\n${spawnError}\n` : ''}` +
        `${out ? `stdout:\n${out}\n` : ''}${err ? `stderr:\n${err}\n` : ''}`.trim()
      );
    }
  };
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', (error) => report({ error }));
  child.once('close', (code, signal) => report({ code, signal }));
  const timeout = setTimeout(() => {
    if (settled) return;
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    report({ error: new Error('terminate command timed out after 20000ms') });
  }, 20_000);
  child.once('close', () => clearTimeout(timeout));
  return child;
}

function clearPendingTerminateTimers(taskId) {
  const id = Number(taskId);
  const list = pendingTerminateTimers.get(id);
  if (!list || !list.length) return;
  for (const handle of list) {
    try { clearTimeout(handle); } catch { /* ignore */ }
  }
  pendingTerminateTimers.delete(id);
}

/**
 * Schedule post-run process cleanup (scoped to this run only).
 * Skips if a *newer* run for the same task is already active.
 */
function scheduleTerminateCommands(task, delayMs, generation = 0) {
  const snapshot = task ? { ...task } : null;
  if (!snapshot) return;
  const taskId = Number(snapshot.id);
  const gen = Number(generation) || Number(snapshot._runGeneration) || 0;
  const wait = Math.max(0, Number(delayMs) || 0);
  const handle = setTimeout(() => {
    // Drop this handle from the pending list
    const list = pendingTerminateTimers.get(taskId) || [];
    const next = list.filter((h) => h !== handle);
    if (next.length) pendingTerminateTimers.set(taskId, next);
    else pendingTerminateTimers.delete(taskId);

    try {
      const active = activeBrowserRuns.get(taskId);
      if (active) {
        const activeGen = Number(active.runGeneration) || 0;
        // A newer run owns this task id — do not pkill by script name.
        if (!gen || activeGen > gen) {
          console.log(
            `[browser-launcher] skip delayed terminate task#${taskId} gen=${gen} ` +
            `(active gen=${activeGen})`
          );
          return;
        }
      }
      runTerminateCommands(buildTerminateCommandsByTask(snapshot));
    } catch {
      // ignore cleanup failures
    }
  }, wait);

  if (!pendingTerminateTimers.has(taskId)) pendingTerminateTimers.set(taskId, []);
  pendingTerminateTimers.get(taskId).push(handle);
}

/**
 * After a browser task ends, Chrome/DrissionPage often leave large dirs under /tmp
 * (tmpXXXX, .com.google.Chrome*, DrissionPage/...). On small VPS disks this piles up.
 * Safe rules:
 * - only under /tmp (or TMPDIR if under /tmp)
 * - only known leftover name patterns
 * - never delete if path is a configured persistent profile (should not live in /tmp)
 * - skip dirs modified in the last minAgeMs (default 2 min) to avoid racing a new task
 */
function shouldCleanupTmpEntry(name, absPath, minAgeMs) {
  const base = String(name || '');
  // Playwright / Python tempfile / Chrome ephemeral profiles
  const patterns = [
    /^tmp[A-Za-z0-9_-]+$/,           // /tmp/tmpgl8v2vzo
    /^\.com\.google\.Chrome\./,      // Chrome singleton leftovers
    /^\.org\.chromium\.Chromium\./,
    /^puppeteer_dev_chrome_profile-/,
    /^playwright[_-]?/,
    /^chromium[_-]?/,
    /^ScopedDir/,
  ];
  if (base === 'DrissionPage') return true;
  if (!patterns.some((re) => re.test(base))) return false;
  try {
    const st = fs.statSync(absPath);
    const age = Date.now() - Number(st.mtimeMs || st.mtime || 0);
    if (age < minAgeMs) return false;
  } catch {
    return false;
  }
  return true;
}

function isPathInsideTmp(absPath) {
  const resolved = path.resolve(absPath);
  const tmpRoot = path.resolve('/tmp');
  return resolved === tmpRoot || resolved.startsWith(`${tmpRoot}${path.sep}`);
}

function collectProtectedProfileDirs(task) {
  const protected = new Set();
  try {
    if (task && task._profile && task._profile.user_data_dir) {
      protected.add(path.resolve(String(task._profile.user_data_dir)));
    }
  } catch { /* ignore */ }
  try {
    const persistent = config.browser && config.browser.userDataDir
      ? path.resolve(config.browser.userDataDir)
      : '';
    if (persistent) protected.add(persistent);
  } catch { /* ignore */ }
  // Never treat runtime temp profiles as protected for /tmp cleanup (they are not under /tmp)
  return protected;
}

function cleanupBrowserTempDirs(task = null, options = {}) {
  const minAgeMs = Math.max(0, Number(options.minAgeMs) || 120000);
  const dryRun = Boolean(options.dryRun);
  const tmpRoot = '/tmp';
  let removed = 0;
  let freedHint = 0;
  const protectedDirs = collectProtectedProfileDirs(task);

  let entries = [];
  try {
    entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
  } catch (err) {
    console.warn('[browser-launcher] /tmp readdir failed:', err.message);
    return { removed: 0, freedHint: 0 };
  }

  for (const ent of entries) {
    const name = ent.name;
    const abs = path.join(tmpRoot, name);
    if (!isPathInsideTmp(abs)) continue;
    if (protectedDirs.has(path.resolve(abs))) continue;

    // DrissionPage is a directory tree
    if (name === 'DrissionPage' && (ent.isDirectory() || ent.isSymbolicLink())) {
      try {
        const st = fs.statSync(abs);
        const age = Date.now() - Number(st.mtimeMs || st.mtime || 0);
        if (age < minAgeMs) continue;
        if (!dryRun) fs.rmSync(abs, { recursive: true, force: true });
        removed += 1;
        console.log(`[browser-launcher] cleaned /tmp leftover: ${abs}`);
      } catch (err) {
        console.warn(`[browser-launcher] clean failed ${abs}:`, err.message);
      }
      continue;
    }

    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
    if (!shouldCleanupTmpEntry(name, abs, minAgeMs)) continue;

    try {
      if (!dryRun) fs.rmSync(abs, { recursive: true, force: true });
      removed += 1;
      console.log(`[browser-launcher] cleaned /tmp leftover: ${abs}`);
    } catch (err) {
      console.warn(`[browser-launcher] clean failed ${abs}:`, err.message);
    }
  }

  // Also clear common sub-caches if empty parents remain — already removed as trees
  if (removed > 0) {
    console.log(`[browser-launcher] /tmp cleanup done: removed=${removed}`);
  }
  return { removed, freedHint };
}

/**
 * After a run ends: if no other browser task is active, aggressively sweep
 * SeleniumBase chrome leftovers (orphans + /tmp profiles + workdir profiles).
 */
function scheduleOrphanSbChromeSweep(delayMs = 2500) {
  const wait = Math.max(0, Number(delayMs) || 0);
  setTimeout(() => {
    try {
      if (activeBrowserRuns.size > 0) {
        console.log(
          `[browser-launcher] skip aggressive sb-orphan sweep: ${activeBrowserRuns.size} active run(s)`
        );
        // Still safe: only kill orphans (parent dead)
        runTerminateCommands(buildOrphanSbChromeCleanupCommands({ aggressive: false }));
        return;
      }
      console.log('[browser-launcher] aggressive sb-orphan chrome sweep (no active browser runs)');
      runTerminateCommands(buildOrphanSbChromeCleanupCommands({ aggressive: true }));
    } catch (err) {
      console.warn('[browser-launcher] sb-orphan sweep error:', err.message);
    }
  }, wait);
}

function scheduleTmpCleanup(task, delayMs = 5000) {
  const snapshot = task ? { ...task, _profile: task._profile || null } : null;
  setTimeout(() => {
    try {
      // Kill orphan SB chrome first so rmdir can succeed
      if (activeBrowserRuns.size === 0) {
        runTerminateCommands(buildOrphanSbChromeCleanupCommands({ aggressive: true }));
      } else {
        runTerminateCommands(buildOrphanSbChromeCleanupCommands({ aggressive: false }));
      }
      cleanupBrowserTempDirs(snapshot, { minAgeMs: 120000 });
    } catch (err) {
      console.warn('[browser-launcher] scheduleTmpCleanup error:', err.message);
    }
  }, Math.max(0, Number(delayMs) || 0));
}

async function launchBrowserTaskAndWait(task, runId, hooks = {}) {
  ensureRuntimeFiles(task);
  const workDir = getBrowserWorkDir();
  const baseName = path.basename(task.script_path);
  const taskFile = path.join(workDir, baseName);
  const wrapperFile = path.join(workDir, 'js-task-wrapper.js');
  const ruyiAdapterFile = path.join(workDir, 'ruyipage_adapter.py');
  const workerScreenshotPath = path.join(workDir, 'screenshots', `task-${task.id}-${runId}.png`);
  const workerScreenshotDir = path.join(workDir, 'screenshots', 'runs', `task-${task.id}-run-${runId}`);
  const resultPath = path.join(workDir, 'task-results', `run-${runId}.json`);
  // Leave creation to the worker process so ownership stays writable for browser user.
  const runner = task.type === 'python'
    ? `${shellEscape('/usr/bin/python3')} ${shellEscape(taskFile)}`
    : `${shellEscape('/tmp/node-openclaw')} ${shellEscape(wrapperFile)} ${shellEscape(taskFile)}`;
  const profile = task && task._profile ? task._profile : null;
  const taskParams = parseTaskParams(task);
  const useTempProfile = resolveUseTempProfile(task, taskParams);
  // Temp = per-run disposable dir under runtime-data/profiles (deleted after run).
  // Persistent = named profile user_data_dir or global default — never auto-deleted.
  const effectiveUserDataDir = useTempProfile
    ? getTempProfileDir(task, runId)
    : pickNonEmptyString(
      profile && profile.user_data_dir,
      task && task.use_persistent ? config.browser.userDataDir : '',
      // Fallback only if misconfigured persistent without a dir
      getTempProfileDir(task, runId)
    );
  const proxyContract = resolveEffectiveProxyContract(task, profile);
  const effectiveProfileName = pickNonEmptyString(
    profile && profile.name,
    ''
  );
  const effectiveLocale = resolveEffectiveLocale(task, profile);
  const effectiveTimezone = resolveEffectiveTimezone(task, profile);
  const runtimeSettings = db.getBrowserRuntimeSettings();
  const runtimeStack = resolveRuntimeStack(task, runtimeSettings);
  const usePlaywrightExtra = shouldUsePlaywrightExtra(runtimeSettings);
  const userEnvPairs = buildBrowserUserEnvPairs(task);
  if (userEnvPairs.length > 0) {
    console.log(`[browser-launcher] forwarding user env: ${summarizeEnvPairs(userEnvPairs)}`);
  }

  // System keys first, then user layers (user may set script vars; system keys re-forced after).
  // GitHub-style aliases: BROWSER_PROXY → PROXY / HTTP_PROXY / … (only if panel has a proxy).
  const proxyAliasEnv = { BROWSER_PROXY: proxyContract.scriptProxy || '' };
  const chromePathEffective = (() => {
    try {
      const br = db.getBrowserRuntimeSettings();
      return (br && br.chromePath) || (config.browser && config.browser.chromePath) || '';
    } catch {
      return (config.browser && config.browser.chromePath) || '';
    }
  })();
  if (chromePathEffective) {
    proxyAliasEnv.BROWSER_CHROME_PATH = chromePathEffective;
  }
  if (workerScreenshotDir) {
    proxyAliasEnv.TASK_SCREENSHOT_DIR = workerScreenshotDir;
  }
  applyProxyAliases(proxyAliasEnv, { overwrite: true });

  const systemPairs = [
    ['DISPLAY', config.browser.display],
    ['XAUTHORITY', config.browser.xauthority],
    ['BROWSER_USER_DATA_DIR', effectiveUserDataDir],
    // Scripts (woiden/hax DP) key off this: 1 => treat as TEMP + cleanup after quit
    ['USE_TEMP_PROFILE', useTempProfile ? '1' : '0'],
    ['BROWSER_CHROME_PATH', chromePathEffective],
    ['BROWSER_RUYI_PATH', runtimeSettings.ruyiPath || config.browser.ruyiPath || process.env.BROWSER_RUYI_PATH || ''],
    ['BROWSER_RUYI_ADAPTER_MODULE', 'ruyipage_adapter'],
    ['BROWSER_RUYI_ADAPTER_PATH', ruyiAdapterFile],
    ['BROWSER_PROXY_MODE', proxyContract.mode],
    ['BROWSER_PROXY_VALUE', proxyContract.value],
    ['BROWSER_RUYI_FPFILE', proxyContract.fpfile],
    ['BROWSER_PROXY', proxyContract.scriptProxy],
    ['BROWSER_PROFILE_NAME', effectiveProfileName],
    ['BROWSER_LOCALE', effectiveLocale],
    ['BROWSER_TIMEZONE', effectiveTimezone],
    ['BROWSER_RUNTIME_STACK', runtimeStack],
    ['BROWSER_USE_PLAYWRIGHT_EXTRA', usePlaywrightExtra ? '1' : '0'],
    ['BROWSER_PLUGIN_PACKAGES', runtimeSettings.pluginPackages || ''],
    ['BROWSER_EXTENSIONS', runtimeSettings.extensionDirs || ''],
    ['TASK_SCREENSHOT_PATH', workerScreenshotPath],
    ['TASK_SCREENSHOT_DIR', workerScreenshotDir],
    ['TASK_RESULT_PATH', resultPath],
    // Unbuffered Python so GitHub scripts show logs immediately
    ['PYTHONUNBUFFERED', '1'],
    // workDir contains copied lib/ for `from lib.panel_callback import ...`
    ['PYTHONPATH', [workDir, process.env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter)],
    // Unique run marker for scoped terminate (must not collide across concurrent tasks)
    ['BAP_RUN_ID', String(runId || '')],
    ['BAP_TASK_ID', String(task && task.id != null ? task.id : '')],
  ];
  // Expand proxy / chrome / artifact aliases for SeleniumBase & requests-style scripts
  for (const key of PROXY_ALIAS_KEYS) {
    systemPairs.push([key, proxyContract.scriptProxy]);
  }
  if (proxyAliasEnv.CHROME_PATH) {
    systemPairs.push(['CHROME_PATH', proxyAliasEnv.CHROME_PATH]);
    systemPairs.push(['CHROMIUM_PATH', proxyAliasEnv.CHROMIUM_PATH || proxyAliasEnv.CHROME_PATH]);
  }
  if (workerScreenshotDir) {
    systemPairs.push(['ARTIFACTS_DIR', workerScreenshotDir]);
    systemPairs.push(['SCREENSHOT_DIR', workerScreenshotDir]);
    // Scripts (hax/woiden) historically read BROWSER_SCREENSHOTS_DIR / SCREENSHOTS_DIR
    systemPairs.push(['BROWSER_SCREENSHOTS_DIR', workerScreenshotDir]);
    systemPairs.push(['SCREENSHOTS_DIR', workerScreenshotDir]);
  }

  // Ensure SB can create downloaded_files under cwd + write chromedriver under package drivers/
  const browserUser = String((config.browser && config.browser.user) || 'browser').trim();
  try {
    fs.mkdirSync(path.join(workDir, 'downloaded_files'), { recursive: true });
    fs.mkdirSync(path.join(workDir, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(workDir, 'archived_files'), { recursive: true });
    fs.mkdirSync(workerScreenshotDir, { recursive: true });
    // Chrome user-data-dir must exist and be writable by browser user (temp or persistent)
    if (effectiveUserDataDir) {
      fs.mkdirSync(effectiveUserDataDir, { recursive: true });
      fs.mkdirSync(path.dirname(effectiveUserDataDir), { recursive: true });
    }
    fs.mkdirSync(getRuntimeDataDir(), { recursive: true });
    fs.mkdirSync(path.join(getRuntimeDataDir(), 'profiles'), { recursive: true });
    fs.chmodSync(workDir, 0o777);
    fs.chmodSync(path.join(workDir, 'downloaded_files'), 0o777);
    fs.chmodSync(path.join(workDir, 'assets'), 0o777);
    fs.chmodSync(path.join(workDir, 'archived_files'), 0o777);
  } catch (e) {
    console.warn('[browser-launcher] chmod workDir:', e.message);
  }
  spawnSync('chown', ['-R', `${browserUser}:${browserUser}`, workDir], { stdio: 'ignore' });
  spawnSync('chmod', ['-R', 'a+rwX', workDir], { stdio: 'ignore' });
  // Profile dirs under panel root are often root-owned; browser user needs write for Playwright/Chrome
  if (effectiveUserDataDir) {
    spawnSync('chown', ['-R', `${browserUser}:${browserUser}`, effectiveUserDataDir], { stdio: 'ignore' });
    spawnSync('chmod', ['-R', 'a+rwX', effectiveUserDataDir], { stdio: 'ignore' });
    const parentProfiles = path.dirname(effectiveUserDataDir);
    spawnSync('chown', [`${browserUser}:${browserUser}`, parentProfiles], { stdio: 'ignore' });
    spawnSync('chmod', ['a+rwx', parentProfiles], { stdio: 'ignore' });
  }
  const runtimeDataDir = getRuntimeDataDir();
  spawnSync('chown', ['-R', `${browserUser}:${browserUser}`, runtimeDataDir], { stdio: 'ignore' });
  spawnSync('chmod', ['-R', 'a+rwX', runtimeDataDir], { stdio: 'ignore' });

  // SeleniumBase UC downloads chromedriver into site-packages/.../drivers (often root-owned).
  // Make that dir writable for browser user, or fail loudly in logs.
  try {
    const py = spawnSync('/usr/bin/python3', ['-c', 'import seleniumbase,os; print(os.path.join(os.path.dirname(seleniumbase.__file__), "drivers"))'], { encoding: 'utf8' });
    const driversDir = String(py.stdout || '').trim();
    if (driversDir && driversDir.startsWith('/')) {
      fs.mkdirSync(driversDir, { recursive: true });
      spawnSync('chmod', ['-R', 'a+rwX', driversDir], { stdio: 'ignore' });
      // also parent sometimes needs write for zip extract
      spawnSync('chmod', ['a+rwX', path.dirname(driversDir)], { stdio: 'ignore' });
      console.log(`[browser-launcher] SB drivers dir writable: ${driversDir}`);
    }
  } catch (e) {
    console.warn('[browser-launcher] SB drivers chmod skip:', e.message);
  }

  const cmdParts = [
    `mkdir -p ${shellEscape(path.join(workDir, 'downloaded_files'))} ${shellEscape(path.join(workDir, 'assets'))} ${shellEscape(path.join(workDir, 'archived_files'))}`,
    `chmod -R a+rwX ${shellEscape(workDir)} 2>/dev/null || true`,
    `cd ${shellEscape(workDir)}`,
  ];
  for (const [key, value] of userEnvPairs) {
    // Skip keys that will be forced by system layer
    if (systemPairs.some(([sk]) => sk === key)) continue;
    cmdParts.push(`export ${key}=${shellEscape(value)}`);
  }
  for (const [key, value] of systemPairs) {
    cmdParts.push(`export ${key}=${shellEscape(value)}`);
  }
  cmdParts.push(runner);
  const cmd = cmdParts.join(' && ');

  const startedAt = new Date().toISOString();
  // Monotonic generation per task: delayed pkill from older runs must not kill this one.
  const prevActive = activeBrowserRuns.get(Number(task.id));
  const runGeneration = (Number(prevActive && prevActive.runGeneration) || 0) + 1;
  // Cancel any pending terminate timers from a previous run of this task.
  clearPendingTerminateTimers(task.id);

  return await new Promise((resolve) => {
    const onStdout = hooks && typeof hooks.onStdout === 'function' ? hooks.onStdout : null;
    const onStderr = hooks && typeof hooks.onStderr === 'function' ? hooks.onStderr : null;
    // Prefer setuid over `su` — avoids pam/user-systemd failures in containers.
    let runUid;
    let runGid;
    let runHome = process.env.HOME || '';
    if (browserUser) {
      try {
        const out = spawnSync('getent', ['passwd', browserUser], { encoding: 'utf8' });
        const parts = String(out.stdout || '').trim().split(':');
        if (parts.length >= 6) {
          runUid = Number(parts[2]);
          runGid = Number(parts[3]);
          runHome = parts[5] || runHome;
        }
      } catch {
        // keep current user
      }
    }
    // Run shell as root so mkdir/chmod work, then the python/node process inherits cwd.
    // Drop privileges only for the final runner via setpriv if available.
    let finalCmd = cmd;
    if (Number.isFinite(runUid) && Number.isFinite(runGid)) {
      const hasSetpriv = spawnSync('bash', ['-lc', 'command -v setpriv'], { encoding: 'utf8' }).status === 0;
      if (hasSetpriv) {
        // mkdir as root, then re-run only the last segment as browser user
        const prep = cmdParts.slice(0, -1).join(' && ');
        const envExports = cmdParts.filter((p) => p.startsWith('export ')).join(' && ');
        finalCmd = [
          prep,
          // run actual task as browser user with same env
          `setpriv --reuid=${runUid} --regid=${runGid} --clear-groups --inh-caps=-all -- ` +
            `/bin/bash -lc ${shellEscape(`${envExports} && cd ${shellEscape(workDir)} && ${runner}`)}`,
        ].join(' && ');
      } else {
        // Fallback: whole command as browser user; dirs already chmod a+rwX
        finalCmd = cmd;
      }
    }
    const spawnOpts = {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: {
        ...process.env,
        HOME: runHome || process.env.HOME,
        USER: browserUser || process.env.USER,
        LOGNAME: browserUser || process.env.LOGNAME,
      },
    };
    // If no setpriv, drop privileges on the bash process (dirs must be world-writable)
    if ((!finalCmd.includes('setpriv')) && Number.isFinite(runUid) && Number.isFinite(runGid)) {
      spawnOpts.uid = runUid;
      spawnOpts.gid = runGid;
    }
    const child = spawn('/bin/bash', ['-c', finalCmd], spawnOpts);
    const taskSnapshotForRun = {
      ...task,
      _launcherPid: child.pid,
      _runGeneration: runGeneration,
      _runId: runId,
      _runtimeStack: runtimeStack,
      _effectiveUserDataDir: effectiveUserDataDir,
    };
    activeBrowserRuns.set(Number(task.id), {
      child,
      task: taskSnapshotForRun,
      runGeneration,
      runId,
      workerScreenshotPath,
      workerScreenshotDir,
      resultPath,
      stoppedByUser: false,
    });
    // Always emit one line so logs are never totally empty if the script dies instantly.
    const launchLine =
      `[panel] launching script=${baseName} type=${task.type || '?'} ` +
      `run=${runId} gen=${runGeneration} proxy=${proxyContract.scriptProxy ? 'set' : 'none'} ` +
      `python_unbuffered=1\n`;
    let stdout = launchLine;
    let stderr = '';
    if (onStdout) {
      try { onStdout(launchLine); } catch { /* ignore */ }
    }
    console.log(
      `[browser-launcher] task#${task.id} launch gen=${runGeneration} run=${runId} script=${baseName}`
    );
    let timedOut = false;
    let graceKilled = false;
    let graceTimer = null;
    let hardKillTimer = null;
    let timer = null;
    const heuristics = resolveHeuristicsForTask(task);

    const clearRunTimers = () => {
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      timer = null;
      graceTimer = null;
      hardKillTimer = null;
    };

    const requestKill = (reason) => {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
      }
      hardKillTimer = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }, 2000);
      if (reason) {
        stderr += `\n${reason}`;
      }
    };

    const maybeStartGraceKill = () => {
      if (!heuristics.enabled || graceKilled || graceTimer || timedOut) return;
      if (heuristics.graceSec <= 0) return;
      const verdict = evaluateLogSuccess(`${stdout}\n${stderr}`, task);
      if (!verdict.softSuccess) return;
      graceKilled = true;
      console.log(
        `[browser-launcher] task#${task.id} success log matched (${verdict.successHit}); grace kill in ${heuristics.graceSec}s`
      );
      stderr += `\n[panel] success log matched (${verdict.successHit}); waiting ${heuristics.graceSec}s then stopping hung process`;
      graceTimer = setTimeout(() => {
        // process still running → terminate but keep soft-success path in task-runner
        if (child.exitCode === null && child.signalCode === null) {
          requestKill(`[panel] grace kill after success log (${heuristics.graceSec}s)`);
        }
      }, heuristics.graceSec * 1000);
    };

    timer = setTimeout(() => {
      timedOut = true;
      requestKill(`Task timed out after ${task.timeout_sec}s`);
    }, task.timeout_sec * 1000);

    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      stdout += text;
      maybeStartGraceKill();
      if (onStdout) {
        try {
          onStdout(text);
        } catch {
          // ignore hook errors
        }
      }
    });
    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;
      maybeStartGraceKill();
      if (onStderr) {
        try {
          onStderr(text);
        } catch {
          // ignore hook errors
        }
      }
    });
    child.on('error', (error) => {
      clearRunTimers();
      const state = activeBrowserRuns.get(Number(task.id));
      const stoppedByUser = Boolean(state && state.stoppedByUser);
      const cleanupTask = state && state.task
        ? state.task
        : { ...task, _runGeneration: runGeneration };
      // Only clear active map if this generation still owns the slot
      if (state && Number(state.runGeneration) === runGeneration) {
        activeBrowserRuns.delete(Number(task.id));
      }
      scheduleTerminateCommands(cleanupTask, 0, runGeneration);
      scheduleTerminateCommands(cleanupTask, 1800, runGeneration);
      // SB orphans + /tmp dirs — after processes are signalled
      scheduleOrphanSbChromeSweep(3000);
      scheduleTmpCleanup(cleanupTask, 8000);
      // Panel "临时": delete per-run profile after Chrome is signalled
      if (useTempProfile && effectiveUserDataDir) {
        removeTempProfileDir(effectiveUserDataDir, { delayMs: 3500 });
      }
      resolve({
        startedAt,
        endedAt: new Date().toISOString(),
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${error.message || String(error)}`.trim(),
        errorCode: stoppedByUser ? 'stopped' : 'browser_launch_error',
        timedOut: false,
        graceKilled: false,
        workerScreenshotPath,
        workerScreenshotDir,
        resultPath,
      });
    });
    child.on('close', (code, signal) => {
      clearRunTimers();
      const state = activeBrowserRuns.get(Number(task.id));
      const stoppedByUser = Boolean(state && state.stoppedByUser);
      const cleanupTask = state && state.task
        ? state.task
        : { ...task, _runGeneration: runGeneration };
      if (state && Number(state.runGeneration) === runGeneration) {
        activeBrowserRuns.delete(Number(task.id));
      }
      scheduleTerminateCommands(cleanupTask, 0, runGeneration);
      scheduleTerminateCommands(cleanupTask, 1800, runGeneration);
      scheduleOrphanSbChromeSweep(3000);
      scheduleTmpCleanup(cleanupTask, 8000);
      if (useTempProfile && effectiveUserDataDir) {
        removeTempProfileDir(effectiveUserDataDir, { delayMs: 3500 });
      }
      const exitCode = code ?? (signal ? 1 : 0);
      const errorCode = stoppedByUser ? 'stopped' : null;
      resolve({
        startedAt,
        endedAt: new Date().toISOString(),
        // grace kill is intentional after success — keep real exit for heuristics;
        // hard timeout still forces non-zero so soft-success path can override.
        exitCode: timedOut ? 1 : exitCode,
        stdout,
        stderr,
        errorCode,
        timedOut,
        graceKilled,
        workerScreenshotPath,
        workerScreenshotDir,
        resultPath,
      });
    });
  });
}

function stopBrowserTask(taskId, fallbackTask = null) {
  const state = activeBrowserRuns.get(Number(taskId));
  if (!state) {
    if (!fallbackTask) return false;
    const snapshot = { ...fallbackTask };
    const gen = Number(snapshot._runGeneration) || 0;
    runTerminateCommands(buildTerminateCommandsByTask(snapshot));
    scheduleTerminateCommands(snapshot, 1500, gen);
    scheduleTerminateCommands(snapshot, 3500, gen);
    scheduleTerminateCommands(snapshot, 6500, gen);
    return true;
  }
  state.stoppedByUser = true;
  const child = state.child;
  const taskSnapshot = state.task ? { ...state.task } : null;
  const groupPid = child && child.pid ? Number(child.pid) : 0;
  let groupSignalSent = false;
  try {
    if (groupPid > 0) {
      process.kill(-groupPid, 'SIGTERM');
      groupSignalSent = true;
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  setTimeout(() => {
    try {
      if (groupSignalSent && groupPid > 0) {
        process.kill(-groupPid, 'SIGKILL');
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
  }, 1500);

  if (taskSnapshot) {
    const gen = Number(taskSnapshot._runGeneration) || Number(state.runGeneration) || 0;
    runTerminateCommands(buildTerminateCommandsByTask(taskSnapshot));
    scheduleTerminateCommands(taskSnapshot, 1500, gen);
    scheduleTerminateCommands(taskSnapshot, 3500, gen);
    scheduleTerminateCommands(taskSnapshot, 6500, gen);
    scheduleOrphanSbChromeSweep(4000);
    scheduleTmpCleanup(taskSnapshot, 10000);
  }
  return true;
}

module.exports = {
  launchBrowserTaskAndWait,
  stopBrowserTask,
  cleanupBrowserTempDirs,
  buildOrphanSbChromeCleanupCommands,
  scheduleOrphanSbChromeSweep,
  getBrowserWorkDir,
  getRuntimeDataDir,
  getTempProfileDir,
  removeTempProfileDir,
  isPanelTempProfileDir,
  shouldCleanupTmpEntry,
};
