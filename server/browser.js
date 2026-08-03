const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const config = require('../config');
const db = require('./db');
const events = require('./events');

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

function getBrowserWorkDir() {
  return (config.browser && config.browser.workDir)
    ? String(config.browser.workDir)
    : path.join('/home', config.browser.user || 'browser', 'browser-work');
}

/** Resolve unix user for browser processes without calling `su` (container-safe). */
function resolveBrowserRunAs() {
  const name = String((config.browser && config.browser.user) || 'browser').trim() || 'browser';
  const home = String((config.browser && config.browser.home) || path.join('/home', name));
  try {
    const out = spawnSync('getent', ['passwd', name], { encoding: 'utf8' });
    const line = String(out.stdout || '').trim();
    // name:x:uid:gid:gecos:home:shell
    const parts = line.split(':');
    if (parts.length >= 4) {
      const uid = Number(parts[2]);
      const gid = Number(parts[3]);
      const homeDir = parts[5] || home;
      if (Number.isFinite(uid) && Number.isFinite(gid)) {
        return { user: name, uid, gid, home: homeDir };
      }
    }
  } catch {
    // fall through
  }
  // Run as current process user (root on typical panel service) if target user missing
  return {
    user: process.env.USER || 'root',
    uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
    gid: typeof process.getgid === 'function' ? process.getgid() : undefined,
    home: process.env.HOME || home,
  };
}

function ensureManualRuntimeFiles(runtimeSettings) {
  const workerRoot = getBrowserWorkDir();
  const browserUser = String((config.browser && config.browser.user) || 'browser');
  const workerNodeModules = path.join(workerRoot, 'node_modules');
  fs.mkdirSync(workerRoot, { recursive: true });
  fs.mkdirSync(path.join(workerRoot, 'screenshots'), { recursive: true });
  fs.mkdirSync(path.join(workerRoot, 'task-results'), { recursive: true });
  fs.mkdirSync(path.join(workerRoot, 'persistent'), { recursive: true });
  // SeleniumBase UC / fasteners lock dirs (must be writable by browser user)
  for (const name of ['downloaded_files', 'assets', 'archived_files']) {
    const dir = path.join(workerRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    try { fs.chmodSync(dir, 0o777); } catch { /* ignore */ }
  }
  try { fs.chmodSync(workerRoot, 0o755); } catch { /* ignore */ }
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

  const missing = [];
  for (const file of files) {
    if (!fs.existsSync(file.from)) {
      missing.push(file.from);
      continue;
    }
    if (fs.existsSync(file.to)) fs.rmSync(file.to, { recursive: true, force: true });
    fs.cpSync(file.from, file.to, { recursive: true });
  }
  if (missing.length) {
    console.warn('[browser] runtime sources missing:', missing.join(', '));
  }

  // Prefer symlink to panel node_modules when copies are empty/partial
  const panelModules = path.join(config.paths.root, 'node_modules');
  if (fs.existsSync(panelModules)) {
    try {
      const linked = path.join(workerRoot, 'node_modules');
      if (!fs.existsSync(path.join(linked, 'playwright')) && !fs.existsSync(path.join(linked, 'playwright-core'))) {
        fs.rmSync(linked, { recursive: true, force: true });
        fs.symlinkSync(panelModules, linked, 'dir');
      }
    } catch (err) {
      console.warn('[browser] node_modules link failed:', err.message);
    }
  }

  // Portable worker node: use current process binary (no hard-coded nvm path).
  const workerNodePath = '/tmp/node-openclaw';
  const sourceNode = process.execPath;
  if (!fs.existsSync(sourceNode)) {
    throw new Error(`Node binary not found: ${sourceNode}`);
  }
  fs.copyFileSync(sourceNode, workerNodePath);
  fs.chmodSync(workerNodePath, 0o755);

  // Ownership for browser user (required: SB creates locks under cwd as that user)
  try {
    const r = spawnSync('chown', ['-R', `${browserUser}:${browserUser}`, workerRoot], { encoding: 'utf8' });
    if (r.status !== 0) {
      console.warn('[browser] chown failed:', (r.stderr || r.stdout || '').trim());
      spawnSync('chmod', ['-R', 'a+rwX', workerRoot], { stdio: 'ignore' });
    }
  } catch (err) {
    console.warn('[browser] chown error:', err.message);
    try { spawnSync('chmod', ['-R', 'a+rwX', workerRoot], { stdio: 'ignore' }); } catch { /* ignore */ }
  }

  const sessionJs = path.join(workerRoot, 'manual-browser-session.js');
  if (!fs.existsSync(sessionJs)) {
    throw new Error(`Browser runtime not prepared: missing ${sessionJs}`);
  }
  return workerRoot;
}

/** Call on panel boot so "open browser" works without manual VPS setup. */
function prepareBrowserWorkspace() {
  try {
    const root = ensureManualRuntimeFiles(db.getBrowserRuntimeSettings());
    console.log(`[browser] workspace ready: ${root}`);
    return root;
  } catch (err) {
    console.error('[browser] workspace prepare failed:', err.message || err);
    throw err;
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
    // 兜底通知：正常情况下 child.on('exit') 会先发，但面板重启后旧进程的 exit
    // 句柄已经没了，只能靠这里的 isPidAlive 兜。只在真的发生了状态翻转时发 ——
    // 状态清空后再调用不会重复发，所以不会和前端的拉取形成来回。
    events.emit('browser', { open: false });
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
  const workDir = getBrowserWorkDir();
  const commands = [
    `pkill -TERM -f ${shellEscape(path.join(workDir, 'manual-browser-session-sb.py'))} || true`,
    `pkill -TERM -f ${shellEscape(path.join(workDir, 'manual-browser-session.js'))} || true`,
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
  commands.push(`pkill -KILL -f ${shellEscape(path.join(workDir, 'manual-browser-session-sb.py'))} || true`);
  commands.push(`pkill -KILL -f ${shellEscape(path.join(workDir, 'manual-browser-session.js'))} || true`);
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

function resolveWorkerNodeBinary() {
  // Prefer portable copy for browser user; fall back to panel's own node.
  const portable = '/tmp/node-openclaw';
  try {
    if (fs.existsSync(portable)) {
      try { fs.accessSync(portable, fs.constants.X_OK); } catch {
        fs.chmodSync(portable, 0o755);
      }
      return portable;
    }
  } catch {
    // ignore
  }
  const self = process.execPath;
  if (self && fs.existsSync(self)) return self;
  throw new Error('No usable Node binary for manual browser (tried /tmp/node-openclaw and process.execPath)');
}

function resolveManualChromePath(runtimeSettings) {
  const candidates = [];
  const fromDb = runtimeSettings && runtimeSettings.chromePath
    ? String(runtimeSettings.chromePath).trim()
    : '';
  if (fromDb) candidates.push(fromDb);
  const fromConfig = config.browser && config.browser.chromePath
    ? String(config.browser.chromePath).trim()
    : '';
  if (fromConfig) candidates.push(fromConfig);
  candidates.push(
    '/snap/chromium/current/usr/lib/chromium-browser/chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  );
  const seen = new Set();
  for (const c of candidates) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    try {
      if (fs.existsSync(c)) {
        try { fs.accessSync(c, fs.constants.X_OK); } catch { /* still try */ }
        return c;
      }
    } catch {
      // continue
    }
  }
  return fromDb || fromConfig || '';
}

function waitForManualBrowserReady(child, { timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let launchLog = '';
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdout && child.stdout.off('data', onOut); } catch { /* ignore */ }
      try { child.stderr && child.stderr.off('data', onErr); } catch { /* ignore */ }
      try { child.off('exit', onExit); } catch { /* ignore */ }
      try { child.off('error', onError); } catch { /* ignore */ }
      fn(arg);
    };
    const onOut = (buf) => {
      const text = buf.toString();
      launchLog += text;
      if (launchLog.length > 6000) launchLog = launchLog.slice(-6000);
      process.stderr.write(`[browser-launch] ${text}`);
      if (/MANUAL_BROWSER_READY/i.test(text)) {
        finish(resolve, { log: launchLog });
      }
    };
    const onErr = (buf) => {
      const text = buf.toString();
      launchLog += text;
      if (launchLog.length > 6000) launchLog = launchLog.slice(-6000);
      process.stderr.write(`[browser-launch] ${text}`);
      // Some stacks may print ready on stderr
      if (/MANUAL_BROWSER_READY/i.test(text)) {
        finish(resolve, { log: launchLog });
      }
    };
    const onExit = (code, signal) => {
      const tail = launchLog.slice(-1200);
      finish(
        reject,
        new Error(
          `Manual browser exited before ready (code=${code} signal=${signal || ''}). `
          + `Check Chrome path / DISPLAY. Log tail:\n${tail || '(empty)'}`
        )
      );
    };
    const onError = (err) => {
      finish(reject, new Error(`Manual browser spawn failed: ${err.message || err}`));
    };
    const timer = setTimeout(() => {
      finish(
        reject,
        new Error(
          `Manual browser ready timeout after ${timeoutMs}ms. `
          + `Log tail:\n${launchLog.slice(-1200) || '(empty)'}`
        )
      );
    }, timeoutMs);

    if (child.stdout) child.stdout.on('data', onOut);
    if (child.stderr) child.stderr.on('data', onErr);
    child.on('exit', onExit);
    child.on('error', onError);
  });
}

async function openManualBrowser(profile) {
  syncManualState();
  if (manualBrowserState.pid) {
    return { open: true, openedAt: manualBrowserState.openedAt, pid: manualBrowserState.pid };
  }

  const runtimeSettings = db.getBrowserRuntimeSettings();
  const runtimeStack = resolveRuntimeStack(profile, runtimeSettings);
  const workDir = getBrowserWorkDir();
  const runtimeScript = runtimeStack === 'seleniumbase'
    ? path.join(workDir, 'manual-browser-session-sb.py')
    : path.join(workDir, 'manual-browser-session.js');
  ensureManualRuntimeFiles(runtimeSettings);
  if (!fs.existsSync(runtimeScript)) {
    throw new Error(`Manual browser runtime not found: ${runtimeScript}`);
  }

  const workerNodePath = resolveWorkerNodeBinary();
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
  const chromePath = resolveManualChromePath(runtimeSettings);
  if (!chromePath || !fs.existsSync(chromePath)) {
    throw new Error(
      `Chrome/Chromium not found (path=${chromePath || '(empty)'}). `
      + 'Set panel 浏览器路径, e.g. /snap/chromium/current/usr/lib/chromium-browser/chrome on ARM.'
    );
  }
  const usePlaywrightExtra = shouldUsePlaywrightExtra(runtimeSettings);
  // Avoid `su` (triggers user systemd / pam in many containers → Permission denied).
  // Drop privileges with setuid/setgid when possible; otherwise run as current user.
  const runAs = resolveBrowserRunAs();
  const childEnv = {
    ...process.env,
    HOME: runAs.home,
    USER: runAs.user,
    LOGNAME: runAs.user,
    DISPLAY: String(config.browser.display || ':1.0'),
    XAUTHORITY: String(config.browser.xauthority || ''),
    BROWSER_USER_DATA_DIR: effectiveUserDataDir,
    BROWSER_CHROME_PATH: chromePath,
    PLAYWRIGHT_CHROME_PATH: chromePath,
    BROWSER_PROXY: effectiveProxy || '',
    BROWSER_LOCALE: effectiveLocale,
    BROWSER_TIMEZONE: effectiveTimezone,
    BROWSER_RUNTIME_STACK: runtimeStack,
    BROWSER_USE_PLAYWRIGHT_EXTRA: usePlaywrightExtra ? '1' : '0',
    BROWSER_PLUGIN_PACKAGES: runtimeSettings.pluginPackages || '',
    BROWSER_EXTENSIONS: runtimeSettings.extensionDirs || '',
    BROWSER_HEADLESS: 'false',
    BROWSER_WORK_DIR: workDir,
  };

  const spawnOpts = {
    cwd: workDir,
    env: childEnv,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  if (runAs.uid != null && runAs.gid != null) {
    spawnOpts.uid = runAs.uid;
    spawnOpts.gid = runAs.gid;
  }

  let child;
  if (runtimeStack === 'seleniumbase') {
    child = spawn('/usr/bin/python3', [runtimeScript], spawnOpts);
  } else {
    child = spawn(workerNodePath, [runtimeScript], spawnOpts);
  }

  console.log(
    `[browser-launch] spawning pid=${child.pid} stack=${runtimeStack} `
    + `node=${workerNodePath} chrome=${chromePath} as ${runAs.user}`
  );

  try {
    await waitForManualBrowserReady(child, { timeoutMs: 45000 });
  } catch (err) {
    // Ensure zombie session is cleaned if ready never came
    try {
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ignore */ }
        try { process.kill(child.pid, 'SIGKILL'); } catch { /* ignore */ }
      }
    } catch {
      // ignore
    }
    manualBrowserState.pid = null;
    manualBrowserState.openedAt = null;
    manualBrowserState.userDataDir = null;
    throw err;
  }

  // Keep listening after ready so we clear state when user closes the window
  const onLaterExit = (code, signal) => {
    if (code || signal) {
      console.error(
        `[browser-launch] session ended code=${code} signal=${signal || ''}`
      );
    }
    if (manualBrowserState.pid === child.pid) {
      manualBrowserState.pid = null;
      manualBrowserState.openedAt = null;
      manualBrowserState.userDataDir = null;
      // 用户手动关掉窗口 / 浏览器崩了，都会走到这里。这是 SSE 相对轮询最有价值的
      // 一处：以前只能等下一次轮询或手动刷页面才知道浏览器没了。
      events.emit('browser', { open: false });
    }
  };
  child.on('exit', onLaterExit);
  child.unref();

  manualBrowserState.pid = child.pid;
  manualBrowserState.openedAt = new Date().toISOString();
  manualBrowserState.userDataDir = effectiveUserDataDir;
  console.log(`[browser-launch] READY pid=${child.pid} chrome=${chromePath}`);
  events.emit('browser', { open: true });

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
  events.emit('browser', { open: false });
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
  prepareBrowserWorkspace,
  ensureManualRuntimeFiles,
  getBrowserWorkDir,
};
