const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const config = require('../config');
const db = require('./db');

const manualBrowserState = {
  pid: null,
  openedAt: null,
  userDataDir: null,
};

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `"'"'`)}'`;
}

function parsePackageList(value) {
  return String(value || '')
    .split(/[\r\n,;]+/g)
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function shouldUsePlaywrightExtra(runtimeSettings) {
  const packages = parsePackageList(runtimeSettings && runtimeSettings.pluginPackages);
  return Boolean(runtimeSettings && runtimeSettings.usePlaywrightExtra) || packages.length > 0;
}

function normalizeRuntimeStack(runtimeSettings) {
  const stack = String(runtimeSettings && runtimeSettings.runtimeStack ? runtimeSettings.runtimeStack : '').trim().toLowerCase();
  return stack === 'seleniumbase' ? 'seleniumbase' : 'playwright';
}

function resolveRuntimeStack(profile, runtimeSettings) {
  const profileStack = String(profile && profile.runtime_stack ? profile.runtime_stack : '').trim().toLowerCase();
  if (profileStack === 'seleniumbase') return 'seleniumbase';
  if (profileStack === 'playwright') return 'playwright';
  return normalizeRuntimeStack(runtimeSettings);
}

function pickNonEmptyString(...values) {
  for (const value of values) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    if (text) return text;
  }
  return '';
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

function ensureManualRuntimeFiles(runtimeSettings) {
  const workerRoot = '/home/abc61154321/browser-work';
  const workerNodeModules = path.join(workerRoot, 'node_modules');
  fs.mkdirSync(workerNodeModules, { recursive: true });

  const effectiveRuntimeSettings = runtimeSettings || db.getBrowserRuntimeSettings();
  const moduleList = ['playwright', 'playwright-core'];
  if (shouldUsePlaywrightExtra(effectiveRuntimeSettings)) {
    moduleList.push('playwright-extra');
  }
  moduleList.push(...parsePackageList(effectiveRuntimeSettings.pluginPackages));

  const moduleCopies = collectModuleCopyPairs(moduleList, workerNodeModules);
  const files = [
    ...moduleCopies,
    { from: path.join(config.paths.root, 'server', 'runtime', 'browser-runtime.js'), to: path.join(workerRoot, 'browser-runtime.js') },
    { from: path.join(config.paths.root, 'server', 'runtime', 'manual-browser-session.js'), to: path.join(workerRoot, 'manual-browser-session.js') },
    { from: path.join(config.paths.root, 'server', 'runtime', 'manual-browser-session-sb.py'), to: path.join(workerRoot, 'manual-browser-session-sb.py') },
  ];

  for (const file of files) {
    if (!fs.existsSync(file.from)) continue;
    if (fs.existsSync(file.to)) fs.rmSync(file.to, { recursive: true, force: true });
    fs.cpSync(file.from, file.to, { recursive: true });
  }

  const workerNodePath = '/tmp/node-openclaw';
  if (!fs.existsSync(workerNodePath)) {
    fs.copyFileSync('/root/.nvm/versions/node/v22.22.1/bin/node', workerNodePath);
    fs.chmodSync(workerNodePath, 0o755);
  }
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function syncManualState() {
  if (manualBrowserState.pid && !isPidAlive(manualBrowserState.pid)) {
    manualBrowserState.pid = null;
    manualBrowserState.openedAt = null;
    manualBrowserState.userDataDir = null;
  }
}

function terminateManualGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // ignore and fallback
  }
  try {
    process.kill(pid, signal);
  } catch {
    // ignore stale pid
  }
}

function sweepManualProcesses(userDataDir) {
  const commands = [
    `pkill -TERM -f ${shellEscape('/home/abc61154321/browser-work/manual-browser-session-sb.py')} || true`,
    `pkill -TERM -f ${shellEscape('/home/abc61154321/browser-work/manual-browser-session.js')} || true`,
  ];

  if (userDataDir) {
    commands.push(`pkill -TERM -f -- ${shellEscape(`--user-data-dir=${userDataDir}`)} || true`);
  }
  commands.push(`pkill -TERM -f ${shellEscape('/opt/google/chrome/chrome')} || true`);
  commands.push(`pkill -TERM -f ${shellEscape('/usr/bin/google-chrome')} || true`);
  commands.push(`pkill -TERM -f ${shellEscape('google-chrome')} || true`);
  commands.push(`pkill -TERM -f ${shellEscape('chromedriver')} || true`);
  commands.push(`pkill -TERM -f ${shellEscape('/seleniumbase/drivers/uc_driver')} || true`);
  commands.push(`pkill -TERM -f ${shellEscape('uc_driver')} || true`);
  commands.push(`pkill -TERM -f ${shellEscape('chrome_crashpad_handler')} || true`);

  commands.push('sleep 1');
  commands.push(`pkill -KILL -f ${shellEscape('/home/abc61154321/browser-work/manual-browser-session-sb.py')} || true`);
  commands.push(`pkill -KILL -f ${shellEscape('/home/abc61154321/browser-work/manual-browser-session.js')} || true`);
  if (userDataDir) {
    commands.push(`pkill -KILL -f -- ${shellEscape(`--user-data-dir=${userDataDir}`)} || true`);
  }
  commands.push(`pkill -KILL -f ${shellEscape('/opt/google/chrome/chrome')} || true`);
  commands.push(`pkill -KILL -f ${shellEscape('/usr/bin/google-chrome')} || true`);
  commands.push(`pkill -KILL -f ${shellEscape('google-chrome')} || true`);
  commands.push(`pkill -KILL -f ${shellEscape('chromedriver')} || true`);
  commands.push(`pkill -KILL -f ${shellEscape('/seleniumbase/drivers/uc_driver')} || true`);
  commands.push(`pkill -KILL -f ${shellEscape('uc_driver')} || true`);
  commands.push(`pkill -KILL -f ${shellEscape('chrome_crashpad_handler')} || true`);

  spawnSync('/bin/bash', ['-c', commands.join('\n')], {
    encoding: 'utf8',
    timeout: 12_000,
    stdio: 'ignore',
  });
}

async function openManualBrowser(profile) {
  syncManualState();
  if (manualBrowserState.pid) {
    return { open: true, openedAt: manualBrowserState.openedAt, pid: manualBrowserState.pid };
  }

  const runtimeSettings = db.getBrowserRuntimeSettings();
  const runtimeStack = resolveRuntimeStack(profile, runtimeSettings);
  const runtimeScript = runtimeStack === 'seleniumbase'
    ? '/home/abc61154321/browser-work/manual-browser-session-sb.py'
    : '/home/abc61154321/browser-work/manual-browser-session.js';
  ensureManualRuntimeFiles(runtimeSettings);
  if (!fs.existsSync(runtimeScript)) {
    throw new Error('Manual browser runtime not found');
  }

  const workerNodePath = '/tmp/node-openclaw';
  const profileLocale = profile && profile.locale ? String(profile.locale).trim() : '';
  const profileTimezone = profile && profile.timezone_id ? String(profile.timezone_id).trim() : '';
  const effectiveLocale = profileLocale || config.browser.locale || 'zh-CN';
  const effectiveTimezone = profileTimezone || config.browser.timezoneId || 'Asia/Shanghai';
  const effectiveUserDataDir = pickNonEmptyString(
    profile && profile.user_data_dir,
    config.browser.userDataDir
  );
  const effectiveProxy = pickNonEmptyString(
    profile && profile.proxy,
    config.browser.proxy || ''
  );
  const usePlaywrightExtra = shouldUsePlaywrightExtra(runtimeSettings);
  const launchCommand = runtimeStack === 'seleniumbase'
    ? `${shellEscape('/usr/bin/python3')} ${shellEscape(runtimeScript)}`
    : `exec ${shellEscape(workerNodePath)} ${shellEscape(runtimeScript)}`;

  const cmd = [
    'cd /home/abc61154321/browser-work &&',
    `DISPLAY=${shellEscape(config.browser.display)}`,
    `XAUTHORITY=${shellEscape(config.browser.xauthority)}`,
    `BROWSER_USER_DATA_DIR=${shellEscape(effectiveUserDataDir)}`,
    `BROWSER_CHROME_PATH=${shellEscape(config.browser.chromePath)}`,
    `BROWSER_PROXY=${shellEscape(effectiveProxy)}`,
    `BROWSER_LOCALE=${shellEscape(effectiveLocale)}`,
    `BROWSER_TIMEZONE=${shellEscape(effectiveTimezone)}`,
    `BROWSER_RUNTIME_STACK=${shellEscape(runtimeStack)}`,
    `BROWSER_USE_PLAYWRIGHT_EXTRA=${shellEscape(usePlaywrightExtra ? '1' : '0')}`,
    `BROWSER_PLUGIN_PACKAGES=${shellEscape(runtimeSettings.pluginPackages || '')}`,
    `BROWSER_HEADLESS='false'`,
    launchCommand,
  ].join(' ');

  const child = spawn('su', ['-s', '/bin/bash', config.browser.user, '-c', cmd], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  manualBrowserState.pid = child.pid;
  manualBrowserState.openedAt = new Date().toISOString();
  manualBrowserState.userDataDir = effectiveUserDataDir;

  return { open: true, openedAt: manualBrowserState.openedAt, pid: manualBrowserState.pid };
}

async function closeManualBrowser() {
  syncManualState();
  const pid = manualBrowserState.pid;
  const userDataDir = manualBrowserState.userDataDir;

  if (!pid) {
    sweepManualProcesses(userDataDir);
    return { open: false };
  }

  terminateManualGroup(pid, 'SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 1200));
  if (isPidAlive(pid)) {
    terminateManualGroup(pid, 'SIGKILL');
  }
  sweepManualProcesses(userDataDir);

  manualBrowserState.pid = null;
  manualBrowserState.openedAt = null;
  manualBrowserState.userDataDir = null;
  return { open: false };
}

function getManualBrowserStatus() {
  syncManualState();
  return {
    open: Boolean(manualBrowserState.pid),
    openedAt: manualBrowserState.openedAt,
  };
}

function createHelpers(taskId) {
  const screenshotsDir = process.env.SCREENSHOTS_DIR;
  return {
    screenshotPath: path.join(screenshotsDir, `task-${taskId}-latest.png`),
  };
}

module.exports = {
  openManualBrowser,
  closeManualBrowser,
  getManualBrowserStatus,
  createHelpers,
};
