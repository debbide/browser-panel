const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const config = require('../../config');
const db = require('../db');
const {
  parseTaskParams,
  resolveUseTempProfile,
  resolveEffectiveProxy,
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

function getTempProfileDir(task) {
  return path.join(getRuntimeDataDir(), 'profiles', `task-${task.id}-tmp-profile`);
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
  return stack === 'seleniumbase' ? 'seleniumbase' : 'playwright';
}

function resolveRuntimeStack(profile, settings) {
  const profileStack = String(profile && profile.runtime_stack ? profile.runtime_stack : '').trim().toLowerCase();
  if (profileStack === 'seleniumbase') return 'seleniumbase';
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


function buildTerminateCommandsByTask(task) {
  const profile = task && task._profile;
  const params = parseTaskParams(task);
  const useTempProfile = resolveUseTempProfile(task, params);
  const userDataDir = useTempProfile
    ? getTempProfileDir(task)
    : (profile && profile.user_data_dir
      ? profile.user_data_dir
      : (task && task.use_persistent
        ? config.browser.userDataDir
        : getTempProfileDir(task)));
  const scriptName = task && task.script_path ? path.basename(task.script_path) : '';
  const browserUser = (config.browser && config.browser.user) ? String(config.browser.user).trim() : '';
  const userPrefix = browserUser ? `pkill -u ${shellEscape(browserUser)} ` : 'pkill ';
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
  ];
  const workDir = getBrowserWorkDir();
  const commands = [
    ...killTreeFunc,
    `pkill -TERM -f ${shellEscape(path.join(workDir, 'manual-browser-session-sb.py'))} || true`,
    `pkill -TERM -f ${shellEscape(path.join(workDir, 'manual-browser-session.js'))} || true`,
  ];
  if (task && task._launcherPid) {
    commands.push(`kill_tree ${Number(task._launcherPid)} || true`);
  }
  if (scriptName) {
    commands.push(`pkill -TERM -f ${shellEscape(path.join(workDir, scriptName))} || true`);
  }
  commands.push(`pkill -TERM -f ${shellEscape('/opt/google/chrome/chrome_crashpad_handler')} || true`);
  commands.push(`pkill -TERM -f -- ${shellEscape(`--user-data-dir=${userDataDir}`)} || true`);
  commands.push(`${userPrefix}-TERM -f ${shellEscape('/opt/google/chrome/chrome --')} || true`);
  commands.push(`${userPrefix}-TERM -f ${shellEscape('/opt/google/chrome/chrome')} || true`);
  commands.push(`${userPrefix}-TERM -f ${shellEscape('/usr/bin/google-chrome')} || true`);
  commands.push(`${userPrefix}-TERM -f ${shellEscape('google-chrome')} || true`);
  commands.push(`${userPrefix}-TERM -f ${shellEscape('chromedriver')} || true`);
  commands.push(`${userPrefix}-TERM -f ${shellEscape('/seleniumbase/drivers/uc_driver')} || true`);
  commands.push(`${userPrefix}-TERM -f ${shellEscape('uc_driver')} || true`);
  commands.push(`${userPrefix}-TERM -f ${shellEscape('chrome_crashpad_handler')} || true`);
  commands.push('sleep 1');
  if (scriptName) {
    commands.push(`pkill -KILL -f ${shellEscape(path.join(workDir, scriptName))} || true`);
  }
  if (task && task._launcherPid) {
    commands.push(`kill_tree_kill ${Number(task._launcherPid)} || true`);
  }
  commands.push(`pkill -KILL -f ${shellEscape('/opt/google/chrome/chrome_crashpad_handler')} || true`);
  commands.push(`pkill -KILL -f -- ${shellEscape(`--user-data-dir=${userDataDir}`)} || true`);
  commands.push(`${userPrefix}-KILL -f ${shellEscape('/opt/google/chrome/chrome --')} || true`);
  commands.push(`${userPrefix}-KILL -f ${shellEscape('/opt/google/chrome/chrome')} || true`);
  commands.push(`${userPrefix}-KILL -f ${shellEscape('/usr/bin/google-chrome')} || true`);
  commands.push(`${userPrefix}-KILL -f ${shellEscape('google-chrome')} || true`);
  commands.push(`${userPrefix}-KILL -f ${shellEscape('chromedriver')} || true`);
  commands.push(`${userPrefix}-KILL -f ${shellEscape('/seleniumbase/drivers/uc_driver')} || true`);
  commands.push(`${userPrefix}-KILL -f ${shellEscape('uc_driver')} || true`);
  commands.push(`${userPrefix}-KILL -f ${shellEscape('chrome_crashpad_handler')} || true`);
  return commands;
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

  const result = spawnSync('/bin/bash', [scriptPath], {
    encoding: 'utf8',
    timeout: 20_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }

  const out = String(result.stdout || '').trim();
  const err = String(result.stderr || '').trim();
  const timeoutOrSpawnError = result.error ? `${result.error.name || 'Error'}: ${result.error.message || String(result.error)}` : '';
  if (result.status !== 0 || out || err || timeoutOrSpawnError) {
    console.log(
      `[browser-launcher] terminate status=${result.status ?? 'null'} signal=${result.signal || ''}\n` +
      `${timeoutOrSpawnError ? `error:\n${timeoutOrSpawnError}\n` : ''}` +
      `${out ? `stdout:\n${out}\n` : ''}${err ? `stderr:\n${err}\n` : ''}`.trim()
    );
  }
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
 * Schedule post-run process cleanup. Skips if a *newer* run for the same task
 * is already active (avoids pkill -f script.py killing the next attempt).
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

function scheduleTmpCleanup(task, delayMs = 5000) {
  const snapshot = task ? { ...task, _profile: task._profile || null } : null;
  setTimeout(() => {
    try {
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
  const effectiveUserDataDir = pickNonEmptyString(
    useTempProfile ? '' : (profile && profile.user_data_dir),
    useTempProfile ? getTempProfileDir(task) : (task && task.use_persistent ? config.browser.userDataDir : getTempProfileDir(task))
  );
  const effectiveProxy = resolveEffectiveProxy(task, profile);
  const effectiveProfileName = pickNonEmptyString(
    profile && profile.name,
    ''
  );
  const profileLocale = profile && profile.locale ? String(profile.locale).trim() : '';
  const profileTimezone = profile && profile.timezone_id ? String(profile.timezone_id).trim() : '';
  const effectiveLocale = profileLocale || config.browser.locale || 'zh-CN';
  const effectiveTimezone = profileTimezone || config.browser.timezoneId || 'Asia/Shanghai';
  const runtimeSettings = db.getBrowserRuntimeSettings();
  const runtimeStack = resolveRuntimeStack(task._profile, runtimeSettings);
  const usePlaywrightExtra = shouldUsePlaywrightExtra(runtimeSettings);
  const userEnvPairs = buildBrowserUserEnvPairs(task);
  if (userEnvPairs.length > 0) {
    console.log(`[browser-launcher] forwarding user env: ${summarizeEnvPairs(userEnvPairs)}`);
  }

  // System keys first, then user layers (user may set script vars; system keys re-forced after).
  // GitHub-style aliases: BROWSER_PROXY → PROXY / HTTP_PROXY / … (only if panel has a proxy).
  const proxyAliasEnv = { BROWSER_PROXY: effectiveProxy || '' };
  if (config.browser && config.browser.chromePath) {
    proxyAliasEnv.BROWSER_CHROME_PATH = config.browser.chromePath;
  }
  if (workerScreenshotDir) {
    proxyAliasEnv.TASK_SCREENSHOT_DIR = workerScreenshotDir;
  }
  applyProxyAliases(proxyAliasEnv, { overwrite: true });

  const systemPairs = [
    ['DISPLAY', config.browser.display],
    ['XAUTHORITY', config.browser.xauthority],
    ['BROWSER_USER_DATA_DIR', effectiveUserDataDir],
    ['BROWSER_CHROME_PATH', config.browser.chromePath],
    ['BROWSER_PROXY', effectiveProxy],
    ['BROWSER_PROFILE_NAME', effectiveProfileName],
    ['BROWSER_LOCALE', effectiveLocale],
    ['BROWSER_TIMEZONE', effectiveTimezone],
    ['BROWSER_RUNTIME_STACK', runtimeStack],
    ['BROWSER_USE_PLAYWRIGHT_EXTRA', usePlaywrightExtra ? '1' : '0'],
    ['BROWSER_PLUGIN_PACKAGES', runtimeSettings.pluginPackages || ''],
    ['TASK_SCREENSHOT_PATH', workerScreenshotPath],
    ['TASK_SCREENSHOT_DIR', workerScreenshotDir],
    ['TASK_RESULT_PATH', resultPath],
    // Unbuffered Python so GitHub scripts show logs immediately
    ['PYTHONUNBUFFERED', '1'],
  ];
  // Expand proxy / chrome / artifact aliases for SeleniumBase & requests-style scripts
  if (effectiveProxy) {
    for (const key of PROXY_ALIAS_KEYS) {
      systemPairs.push([key, effectiveProxy]);
    }
  }
  if (proxyAliasEnv.CHROME_PATH) {
    systemPairs.push(['CHROME_PATH', proxyAliasEnv.CHROME_PATH]);
    systemPairs.push(['CHROMIUM_PATH', proxyAliasEnv.CHROMIUM_PATH || proxyAliasEnv.CHROME_PATH]);
  }
  if (workerScreenshotDir) {
    systemPairs.push(['ARTIFACTS_DIR', workerScreenshotDir]);
    systemPairs.push(['SCREENSHOT_DIR', workerScreenshotDir]);
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
      `run=${runId} gen=${runGeneration} proxy=${effectiveProxy ? 'set' : 'none'} ` +
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
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      hardKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
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
      // Chrome/DP temp dirs under /tmp — clean after processes are signalled
      scheduleTmpCleanup(cleanupTask, 8000);
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
      scheduleTmpCleanup(cleanupTask, 8000);
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
    if (child.exitCode === null && child.signalCode === null) {
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
    }
  }, 1500);

  if (taskSnapshot) {
    const gen = Number(taskSnapshot._runGeneration) || Number(state.runGeneration) || 0;
    runTerminateCommands(buildTerminateCommandsByTask(taskSnapshot));
    scheduleTerminateCommands(taskSnapshot, 1500, gen);
    scheduleTerminateCommands(taskSnapshot, 3500, gen);
    scheduleTerminateCommands(taskSnapshot, 6500, gen);
    scheduleTmpCleanup(taskSnapshot, 10000);
  }
  return true;
}

module.exports = {
  launchBrowserTaskAndWait,
  stopBrowserTask,
  cleanupBrowserTempDirs,
};
