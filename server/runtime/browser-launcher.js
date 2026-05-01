const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const config = require('../../config');
const db = require('../db');
const activeBrowserRuns = new Map();

function getRuntimeDataDir() {
  return path.join(config.paths.root, 'runtime-data');
}

function getTempProfileDir(task) {
  return path.join(getRuntimeDataDir(), 'profiles', `task-${task.id}-tmp-profile`);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function collectEnvByPrefixes(prefixes) {
  const out = [];
  for (const [key, rawValue] of Object.entries(process.env || {})) {
    if (!prefixes.some(prefix => key.startsWith(prefix))) continue;
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;
    out.push([key, String(rawValue)]);
  }
  out.sort((a, b) => a[0].localeCompare(b[0]));
  return out;
}

function redactEnvValue(key, value) {
  const name = String(key || '').toUpperCase();
  if (name.includes('TOKEN') || name.includes('SECRET') || name.includes('PASSWORD')) {
    return '***';
  }
  return String(value);
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

function ensureRuntimeFiles(task) {
  const workerNodeModules = '/home/abc61154321/browser-work/node_modules';
  fs.mkdirSync(workerNodeModules, { recursive: true });
  fs.mkdirSync(path.join(getRuntimeDataDir(), 'profiles'), { recursive: true });
  const moduleCopies = collectModuleCopyPairs(getRuntimeNodeModules(), workerNodeModules);
  const taskSourcePath = path.resolve(config.paths.root, task.script_path);
  const taskSourceDir = path.dirname(taskSourcePath);
  const taskBaseName = path.basename(taskSourcePath);
  const files = [
    ...moduleCopies,
    { from: path.join(config.paths.root, 'server', 'runtime', 'browser-runtime.js'), to: '/home/abc61154321/browser-work/browser-runtime.js' },
    { from: path.join(config.paths.root, 'server', 'runtime', 'js-task-wrapper.js'), to: '/home/abc61154321/browser-work/js-task-wrapper.js' },
    { from: taskSourcePath, to: `/home/abc61154321/browser-work/${taskBaseName}` },
  ];

  if (task.type === 'python' && fs.existsSync(taskSourceDir)) {
    const pySiblings = fs.readdirSync(taskSourceDir, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
      .filter(name => name.endsWith('.py') && name !== taskBaseName);
    for (const sibling of pySiblings) {
      files.push({
        from: path.join(taskSourceDir, sibling),
        to: `/home/abc61154321/browser-work/${sibling}`,
      });
    }
  }

  for (const file of files) {
    if (!fs.existsSync(file.from)) continue;
    if (fs.existsSync(file.to)) fs.rmSync(file.to, { recursive: true, force: true });
    fs.cpSync(file.from, file.to, { recursive: true });
  }
  if (!fs.existsSync('/tmp/node-openclaw')) {
    fs.copyFileSync('/root/.nvm/versions/node/v22.22.1/bin/node', '/tmp/node-openclaw');
    fs.chmodSync('/tmp/node-openclaw', 0o755);
  }
  spawnSync('bash', ['-lc', 'chown -R abc61154321:abc61154321 /home/abc61154321/browser-work'], { stdio: 'ignore' });
}


function buildTerminateCommandsByTask(task) {
  const profile = task && task._profile;
  const userDataDir = profile && profile.user_data_dir
    ? profile.user_data_dir
    : (task && task.use_persistent
      ? config.browser.userDataDir
      : getTempProfileDir(task));
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
  const commands = [
    ...killTreeFunc,
    `pkill -TERM -f ${shellEscape('/home/abc61154321/browser-work/manual-browser-session-sb.py')} || true`,
    `pkill -TERM -f ${shellEscape('/home/abc61154321/browser-work/manual-browser-session.js')} || true`,
  ];
  if (task && task._launcherPid) {
    commands.push(`kill_tree ${Number(task._launcherPid)} || true`);
  }
  if (scriptName) {
    commands.push(`pkill -TERM -f ${shellEscape(`/home/abc61154321/browser-work/${scriptName}`)} || true`);
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
    commands.push(`pkill -KILL -f ${shellEscape(`/home/abc61154321/browser-work/${scriptName}`)} || true`);
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

function scheduleTerminateCommands(task, delayMs) {
  const snapshot = task ? { ...task } : null;
  setTimeout(() => {
    if (!snapshot) return;
    try {
      runTerminateCommands(buildTerminateCommandsByTask(snapshot));
    } catch {
      // ignore cleanup failures
    }
  }, Math.max(0, Number(delayMs) || 0));
}

async function launchBrowserTaskAndWait(task, runId, hooks = {}) {
  ensureRuntimeFiles(task);
  const baseName = path.basename(task.script_path);
  const taskFile = `/home/abc61154321/browser-work/${baseName}`;
  const wrapperFile = '/home/abc61154321/browser-work/js-task-wrapper.js';
  const workerScreenshotPath = `/home/abc61154321/browser-work/screenshots/task-${task.id}-${runId}.png`;
  const resultPath = `/home/abc61154321/browser-work/task-results/run-${runId}.json`;
  const runner = task.type === 'python'
    ? `${shellEscape('/usr/bin/python3')} ${shellEscape(taskFile)}`
    : `${shellEscape('/tmp/node-openclaw')} ${shellEscape(wrapperFile)} ${shellEscape(taskFile)}`;
  const profileLocale = task._profile && task._profile.locale ? String(task._profile.locale).trim() : '';
  const profileTimezone = task._profile && task._profile.timezone_id ? String(task._profile.timezone_id).trim() : '';
  const effectiveLocale = profileLocale || config.browser.locale || 'zh-CN';
  const effectiveTimezone = profileTimezone || config.browser.timezoneId || 'Asia/Shanghai';
  const runtimeSettings = db.getBrowserRuntimeSettings();
  const runtimeStack = resolveRuntimeStack(task._profile, runtimeSettings);
  const usePlaywrightExtra = shouldUsePlaywrightExtra(runtimeSettings);
  const cfEnvPairs = collectEnvByPrefixes(['CF_']);
  const tgEnvPairs = collectEnvByPrefixes(['TG_']);
  if (cfEnvPairs.length > 0) {
    const summary = cfEnvPairs.map(([k, v]) => `${k}=${v}`).join(', ');
    console.log(`[browser-launcher] forwarding env: ${summary}`);
  }
  if (tgEnvPairs.length > 0) {
    const summary = tgEnvPairs.map(([k, v]) => `${k}=${redactEnvValue(k, v)}`).join(', ');
    console.log(`[browser-launcher] forwarding tg env: ${summary}`);
  }

  const cmdParts = [
    'cd /home/abc61154321/browser-work &&',
    `DISPLAY=${shellEscape(config.browser.display)}`,
    `XAUTHORITY=${shellEscape(config.browser.xauthority)}`,
    `BROWSER_USER_DATA_DIR=${shellEscape(task._profile ? task._profile.user_data_dir : (task.use_persistent ? config.browser.userDataDir : getTempProfileDir(task)))}`,
    `BROWSER_CHROME_PATH=${shellEscape(config.browser.chromePath)}`,
    `BROWSER_PROXY=${shellEscape(task._profile && task._profile.proxy ? task._profile.proxy : (config.browser.proxy || ''))}`,
    `BROWSER_PROFILE_NAME=${shellEscape(task._profile && task._profile.name ? task._profile.name : '')}`,
    `BROWSER_LOCALE=${shellEscape(effectiveLocale)}`,
    `BROWSER_TIMEZONE=${shellEscape(effectiveTimezone)}`,
    `BROWSER_RUNTIME_STACK=${shellEscape(runtimeStack)}`,
    `BROWSER_USE_PLAYWRIGHT_EXTRA=${shellEscape(usePlaywrightExtra ? '1' : '0')}`,
    `BROWSER_PLUGIN_PACKAGES=${shellEscape(runtimeSettings.pluginPackages || '')}`,
    `TASK_SCREENSHOT_PATH=${shellEscape(workerScreenshotPath)}`,
    `TASK_RESULT_PATH=${shellEscape(resultPath)}`,
  ];
  for (const [key, value] of cfEnvPairs) {
    cmdParts.push(`${key}=${shellEscape(value)}`);
  }
  for (const [key, value] of tgEnvPairs) {
    cmdParts.push(`${key}=${shellEscape(value)}`);
  }
  cmdParts.push(runner);
  const cmd = cmdParts.join(' ');

  const startedAt = new Date().toISOString();
  return await new Promise((resolve) => {
    const onStdout = hooks && typeof hooks.onStdout === 'function' ? hooks.onStdout : null;
    const onStderr = hooks && typeof hooks.onStderr === 'function' ? hooks.onStderr : null;
    const child = spawn('su', ['-s', '/bin/bash', config.browser.user, '-c', cmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    activeBrowserRuns.set(Number(task.id), {
      child,
      task: { ...task, _launcherPid: child.pid },
      workerScreenshotPath,
      resultPath,
      stoppedByUser: false,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      stderr += `\nTask timed out after ${task.timeout_sec}s`;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 2000);
    }, task.timeout_sec * 1000);

    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      stdout += text;
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
      if (onStderr) {
        try {
          onStderr(text);
        } catch {
          // ignore hook errors
        }
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      const state = activeBrowserRuns.get(Number(task.id));
      const stoppedByUser = Boolean(state && state.stoppedByUser);
      const cleanupTask = state && state.task ? state.task : task;
      activeBrowserRuns.delete(Number(task.id));
      scheduleTerminateCommands(cleanupTask, 0);
      scheduleTerminateCommands(cleanupTask, 1800);
      resolve({
        startedAt,
        endedAt: new Date().toISOString(),
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${error.message || String(error)}`.trim(),
        errorCode: stoppedByUser ? 'stopped' : 'browser_launch_error',
        workerScreenshotPath,
        resultPath,
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const state = activeBrowserRuns.get(Number(task.id));
      const stoppedByUser = Boolean(state && state.stoppedByUser);
      const cleanupTask = state && state.task ? state.task : task;
      activeBrowserRuns.delete(Number(task.id));
      scheduleTerminateCommands(cleanupTask, 0);
      scheduleTerminateCommands(cleanupTask, 1800);
      const exitCode = code ?? (signal ? 1 : 0);
      const errorCode = stoppedByUser ? 'stopped' : null;
      resolve({
        startedAt,
        endedAt: new Date().toISOString(),
        exitCode: timedOut ? 1 : exitCode,
        stdout,
        stderr,
        errorCode,
        workerScreenshotPath,
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
    runTerminateCommands(buildTerminateCommandsByTask(snapshot));
    scheduleTerminateCommands(snapshot, 1500);
    scheduleTerminateCommands(snapshot, 3500);
    scheduleTerminateCommands(snapshot, 6500);
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
    runTerminateCommands(buildTerminateCommandsByTask(taskSnapshot));
    scheduleTerminateCommands(taskSnapshot, 1500);
    scheduleTerminateCommands(taskSnapshot, 3500);
    scheduleTerminateCommands(taskSnapshot, 6500);
  }
  return true;
}

module.exports = {
  launchBrowserTaskAndWait,
  stopBrowserTask,
};
