const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');

const manualBrowserState = {
  pid: null,
  openedAt: null,
};

function ensureManualRuntimeFiles() {
  const workerRoot = '/home/abc61154321/browser-work';
  fs.mkdirSync(path.join(workerRoot, 'node_modules'), { recursive: true });
  const files = [
    { from: path.join(config.paths.root, 'node_modules', 'playwright'), to: path.join(workerRoot, 'node_modules', 'playwright') },
    { from: path.join(config.paths.root, 'node_modules', 'playwright-core'), to: path.join(workerRoot, 'node_modules', 'playwright-core') },
    { from: path.join(config.paths.root, 'server', 'runtime', 'browser-runtime.js'), to: path.join(workerRoot, 'browser-runtime.js') },
    { from: path.join(config.paths.root, 'server', 'runtime', 'manual-browser-session.js'), to: path.join(workerRoot, 'manual-browser-session.js') },
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
  }
}

async function openManualBrowser(profile) {
  syncManualState();
  if (manualBrowserState.pid) {
    return { open: true, openedAt: manualBrowserState.openedAt, pid: manualBrowserState.pid };
  }

  const runtimeScript = '/home/abc61154321/browser-work/manual-browser-session.js';
  ensureManualRuntimeFiles();
  if (!fs.existsSync(runtimeScript)) {
    throw new Error('Manual browser runtime not found');
  }

  const workerNodePath = '/tmp/node-openclaw';

  const cmd = [
    'cd /home/abc61154321/browser-work &&',
    `DISPLAY=${shellEscape(config.browser.display)}`,
    `XAUTHORITY=${shellEscape(config.browser.xauthority)}`,
    `BROWSER_USER_DATA_DIR=${shellEscape(profile && profile.user_data_dir ? profile.user_data_dir : config.browser.userDataDir)}`,
    `BROWSER_CHROME_PATH=${shellEscape(config.browser.chromePath)}`,
    `BROWSER_PROXY=${shellEscape(profile && profile.proxy ? profile.proxy : (config.browser.proxy || ''))}`,
    `BROWSER_HEADLESS='false'`,
    `exec ${shellEscape(workerNodePath)} ${shellEscape(runtimeScript)}`,
  ].join(' ');

  const child = spawn('su', ['-s', '/bin/bash', config.browser.user, '-c', cmd], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  manualBrowserState.pid = child.pid;
  manualBrowserState.openedAt = new Date().toISOString();

  return { open: true, openedAt: manualBrowserState.openedAt, pid: manualBrowserState.pid };
}

async function closeManualBrowser() {
  syncManualState();
  if (!manualBrowserState.pid) {
    return { open: false };
  }

  try {
    process.kill(manualBrowserState.pid, 'SIGTERM');
  } catch {
    // ignore stale pid
  }

  manualBrowserState.pid = null;
  manualBrowserState.openedAt = null;
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

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `"'"'`)}'`;
}

module.exports = {
  openManualBrowser,
  closeManualBrowser,
  getManualBrowserStatus,
  createHelpers,
};
