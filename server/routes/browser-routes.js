const express = require('express');

function isValidTimeZone(value) {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: String(value || '') });
    return true;
  } catch {
    return false;
  }
}

function normalizeProfileLocale(value) {
  return String(value || '').trim();
}

function normalizeProfileUserDataDir(value) {
  return String(value || '').trim();
}

function normalizeProfileProxy(value) {
  return String(value || '').trim();
}

function normalizeProfileTimezone(value) {
  const timezone = String(value || '').trim();
  if (!timezone) return '';
  if (!isValidTimeZone(timezone)) {
    throw new Error('Invalid timezone, use IANA format like Asia/Shanghai');
  }
  return timezone;
}

function normalizeProfileProxyMode(value, legacyProxy = '', proxyModes = []) {
  const mode = String(value || '').trim().toLowerCase();
  if (!mode) return legacyProxy ? 'launch' : 'inherit';
  if (proxyModes.includes(mode)) return mode;
  throw new Error(`Invalid proxy mode: ${mode}`);
}

function normalizeProfileRuntimeStack(value) {
  const stack = String(value || '').trim().toLowerCase();
  if (!stack) return '';
  if (stack === 'playwright' || stack === 'seleniumbase' || stack === 'ruyipage') return stack;
  throw new Error('Invalid runtime stack, use playwright, seleniumbase, or ruyipage');
}

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function normalizeRuntimeStack(value) {
  const stack = String(value || '').trim().toLowerCase();
  if (stack === 'seleniumbase' || stack === 'ruyipage') return stack;
  return 'playwright';
}

function normalizePluginPackages(value) {
  return String(value || '')
    .split(/[\r\n,;]+/g)
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((pkg) => {
      if (pkg === 'playwright-extra-plugin-stealth') {
        return 'puppeteer-extra-plugin-stealth';
      }
      return pkg;
    });
}

function validatePluginPackageName(pkg) {
  return /^(?:@[\w.-]+\/)?[\w.-]+$/.test(pkg);
}

function createBrowserRouteHelpers({ db, proxyModes }) {
function normalizeBrowserRuntimeSettingsPayload(payload = {}, fallback = null) {
  const base = fallback || db.getBrowserRuntimeSettings();
  const runtimeStack = normalizeRuntimeStack(payload.runtimeStack === undefined ? base.runtimeStack : payload.runtimeStack);
  const usePlaywrightExtra = parseBooleanFlag(payload.usePlaywrightExtra, Boolean(base.usePlaywrightExtra));
  const pluginPackages = normalizePluginPackages(payload.pluginPackages === undefined ? base.pluginPackages : payload.pluginPackages);
  const chromePath = payload.chromePath === undefined
    ? (base.chromePath || '')
    : String(payload.chromePath || '').trim().slice(0, 512);
  const extensionDirs = payload.extensionDirs === undefined
    ? (base.extensionDirs || '')
    : String(payload.extensionDirs || '').trim().slice(0, 4096);
  const ruyiPath = payload.ruyiPath === undefined
    ? (base.ruyiPath || '')
    : String(payload.ruyiPath || '').trim().slice(0, 512);
  const proxyMode = String(payload.proxyMode === undefined ? base.proxyMode : payload.proxyMode).trim().toLowerCase();
  const proxyValue = String(payload.proxyValue === undefined ? base.proxyValue : payload.proxyValue || '').trim().slice(0, 2048);
  const ruyiFpfile = String(payload.ruyiFpfile === undefined ? base.ruyiFpfile : payload.ruyiFpfile || '').trim().slice(0, 512);

  if (pluginPackages.includes('playwright-stealth')) {
    throw new Error('playwright-stealth 这个包是占位包，请改用 puppeteer-extra-plugin-stealth');
  }

  const invalidPackage = pluginPackages.find(item => !validatePluginPackageName(item));
  if (invalidPackage) {
    throw new Error(`插件包名不合法: ${invalidPackage}`);
  }

  if (chromePath && /[\r\n\0]/.test(chromePath)) {
    throw new Error('Chrome 路径含非法字符');
  }

  if (extensionDirs && /[\r\n\0]/.test(extensionDirs)) {
    throw new Error('扩展目录含非法字符');
  }

  if ([ruyiPath, ruyiFpfile].some(value => /[\r\n\0]/.test(value))) {
    throw new Error('RuyiPage path contains invalid characters');
  }

  if (!proxyModes.includes(proxyMode)) {
    throw new Error(`Invalid global proxy mode: ${proxyMode}`);
  }
  const safeProxyValue = proxyMode === 'warp' ? '' : proxyValue;

  return {
    runtimeStack,
    usePlaywrightExtra: runtimeStack === 'playwright' && (usePlaywrightExtra || pluginPackages.length > 0),
    pluginPackages: pluginPackages.join(','),
    chromePath,
    ruyiPath,
    proxyMode,
    proxyValue: safeProxyValue,
    ruyiFpfile,
    extensionDirs,
  };
}

  return {
    normalizeProfileLocale,
    normalizeProfileUserDataDir,
    normalizeProfileProxy,
    normalizeProfileTimezone,
    normalizeProfileProxyMode: (value, legacyProxy = '') => normalizeProfileProxyMode(value, legacyProxy, proxyModes),
    normalizeProfileRuntimeStack,
    normalizePluginPackages,
    normalizeBrowserRuntimeSettingsPayload,
  };
}

function createBrowserStatusRouter({ getManualBrowserStatus }) {
  const router = express.Router();
  router.get('/api/browser', (req, res) => {
  res.json({ data: getManualBrowserStatus() });
});

  return router;
}

function createBrowserRuntimeRouter({ db, config, spawnSync, resolveNpmCommand, runBashCommand, helpers }) {
  const router = express.Router();
  const { normalizePluginPackages, normalizeBrowserRuntimeSettingsPayload } = helpers;
  router.get('/api/settings/browser-runtime', (req, res) => {
  res.json({ data: db.getBrowserRuntimeSettings() });
});

  router.post('/api/settings/browser-runtime', (req, res) => {
  try {
    const settings = normalizeBrowserRuntimeSettingsPayload(req.body || {});
    const updated = db.setBrowserRuntimeSettings(settings);
    res.json({ data: updated });
  } catch (error) {
    res.status(400).json({ message: error.message || '保存浏览器运行时配置失败' });
  }
});

  router.post('/api/settings/browser-runtime/install', (req, res) => {
  try {
    const settings = normalizeBrowserRuntimeSettingsPayload(req.body || {});
    if (settings.runtimeStack !== 'playwright') {
      return res.status(400).json({ message: '当前运行栈不是 Playwright，请使用“安装浏览器环境”按钮' });
    }

    const packageSet = new Set();
    if (settings.usePlaywrightExtra) packageSet.add('playwright-extra');
    for (const pkg of normalizePluginPackages(settings.pluginPackages)) {
      packageSet.add(pkg);
    }
    const installList = Array.from(packageSet);
    if (!installList.length) {
      return res.status(400).json({ message: '请先配置至少一个插件包名' });
    }

    const npmCommand = resolveNpmCommand();
    const env = { ...process.env };
    if (npmCommand.nodeDir) {
      env.PATH = `${npmCommand.nodeDir}:${env.PATH || ''}`;
    }
    const result = spawnSync(npmCommand.command, [...npmCommand.args, 'install', '--no-audit', '--no-fund', ...installList], {
      cwd: config.paths.root,
      encoding: 'utf8',
      timeout: 5 * 60 * 1000,
      env,
    });

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      const output = `${result.stderr || ''}\n${result.stdout || ''}`.trim();
      return res.status(500).json({
        message: `npm 安装失败（退出码 ${result.status}）`,
        output: output.slice(-3000),
      });
    }

    const updated = db.setBrowserRuntimeSettings(settings);
    res.json({
      data: {
        settings: updated,
        installed: installList,
        output: String(result.stdout || '').trim().slice(-3000),
      },
    });
  } catch (error) {
    res.status(400).json({ message: error.message || '安装插件包失败' });
  }
});

  router.post('/api/settings/browser-runtime/install-browser', (req, res) => {
  try {
    const settings = normalizeBrowserRuntimeSettingsPayload(req.body || {});
    const steps = [];

    if (settings.runtimeStack === 'seleniumbase') {
      steps.push({
        name: '检查 Chrome（缺失时自动安装）',
        command: [
          'if command -v google-chrome >/dev/null 2>&1 || command -v google-chrome-stable >/dev/null 2>&1; then',
          '  echo "google-chrome already installed";',
          'else',
          '  export DEBIAN_FRONTEND=noninteractive;',
          '  apt-get update;',
          '  apt-get install -y wget ca-certificates;',
          '  wget -q -O /tmp/google-chrome-stable_current_amd64.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb;',
          '  apt-get install -y /tmp/google-chrome-stable_current_amd64.deb || apt-get -f install -y;',
          'fi',
        ].join('\n'),
      });
      steps.push({
        name: '安装 xvfb',
        command: 'if command -v xvfb-run >/dev/null 2>&1; then echo "xvfb already installed"; else apt-get update && apt-get install -y xvfb; fi',
      });
      steps.push({
        name: '安装 pip3',
        command: 'if command -v pip3 >/dev/null 2>&1; then echo "pip3 already installed"; else apt-get update && apt-get install -y python3-pip; fi',
      });
      steps.push({
        name: '安装 SeleniumBase',
        command: [
          '/usr/bin/python3 -m pip install --break-system-packages --upgrade pip setuptools wheel',
          '/usr/bin/python3 -m pip install --break-system-packages --upgrade --ignore-installed urllib3 requests selenium',
          '/usr/bin/python3 -m pip install --break-system-packages --upgrade --ignore-installed seleniumbase',
        ].join('\n'),
      });
      steps.push({
        name: '安装 ChromeDriver',
        command: '/usr/bin/python3 -m seleniumbase install chromedriver',
      });
      steps.push({
        name: '验证 SeleniumBase',
        command: '/usr/bin/python3 -c "import seleniumbase; print(seleniumbase.__version__)"',
      });
    } else {
      steps.push({
        name: '检查 Chrome（缺失时自动安装）',
        command: [
          'if command -v google-chrome >/dev/null 2>&1 || command -v google-chrome-stable >/dev/null 2>&1; then',
          '  echo "google-chrome already installed";',
          'else',
          '  export DEBIAN_FRONTEND=noninteractive;',
          '  apt-get update;',
          '  apt-get install -y wget ca-certificates;',
          '  wget -q -O /tmp/google-chrome-stable_current_amd64.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb;',
          '  apt-get install -y /tmp/google-chrome-stable_current_amd64.deb || apt-get -f install -y;',
          'fi',
        ].join('\n'),
      });
    }

    const logs = [];
    for (const step of steps) {
      const result = runBashCommand(step.command, 15 * 60 * 1000);
      const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
      logs.push({
        step: step.name,
        exitCode: result.status ?? (result.error ? 1 : 0),
        output: output.slice(-3000),
      });

      if (result.error || result.status !== 0) {
        return res.status(500).json({
          message: `安装失败：${step.name}`,
          output: output.slice(-3000),
          logs,
        });
      }
    }

    const updated = db.setBrowserRuntimeSettings(settings);
    res.json({
      data: {
        settings: updated,
        logs,
      },
    });
  } catch (error) {
    res.status(400).json({ message: error.message || '安装浏览器环境失败' });
  }
});

  return router;
}

function createBrowserProfileRouter({ db, isAnyBrowserTaskRunning, buildSchedulerBusyPayload, openManualBrowser, closeManualBrowser, helpers }) {
  const router = express.Router();
  const { normalizeProfileLocale, normalizeProfileUserDataDir, normalizeProfileProxy, normalizeProfileTimezone, normalizeProfileProxyMode, normalizeProfileRuntimeStack } = helpers;
  router.post('/api/browser/open', async (req, res) => {
  try {
    if (isAnyBrowserTaskRunning()) {
      const busy = buildSchedulerBusyPayload();
      return res.status(busy.status).json(busy.payload);
    }
    const profileId = req.body && req.body.profile_id ? Number(req.body.profile_id) : null;
    const profile = profileId ? db.getBrowserProfile(profileId) : null;
    const session = await openManualBrowser(profile);
    res.json({ data: { open: true, openedAt: session.openedAt, profileId } });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Failed to open browser' });
  }
});

  router.get('/api/browser-profiles', (req, res) => {
  res.json({ data: db.listBrowserProfiles() });
});

  router.post('/api/browser-profiles', (req, res) => {
  try {
    const { name, user_data_dir, proxy } = req.body || {};
    const legacyProxy = normalizeProfileProxy(proxy);
    const proxy_mode = normalizeProfileProxyMode(req.body?.proxy_mode ?? req.body?.proxyMode, legacyProxy);
    const proxy_value = proxy_mode === 'warp' ? '' : normalizeProfileProxy(req.body?.proxy_value ?? req.body?.proxyValue ?? legacyProxy);
    const ruyi_fpfile = normalizeProfileUserDataDir(req.body?.ruyi_fpfile ?? req.body?.ruyiFpfile);
    const runtime_stack = normalizeProfileRuntimeStack(req.body?.runtime_stack ?? req.body?.runtimeStack);
    const locale = normalizeProfileLocale(req.body?.locale);
    const timezone_id = normalizeProfileTimezone(req.body?.timezone_id ?? req.body?.timezoneId);
    if (!name) return res.status(400).json({ message: 'Profile name is required' });
    const profile = db.createBrowserProfile({
      name: String(name),
      user_data_dir: normalizeProfileUserDataDir(user_data_dir),
      proxy: legacyProxy,
      proxy_mode,
      proxy_value,
      ruyi_fpfile,
      runtime_stack,
      locale,
      timezone_id,
    });
    res.json({ data: profile });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});
  router.put('/api/browser-profiles/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, user_data_dir, proxy } = req.body || {};
    const legacyProxy = normalizeProfileProxy(proxy);
    const proxy_mode = normalizeProfileProxyMode(req.body?.proxy_mode ?? req.body?.proxyMode, legacyProxy);
    const proxy_value = proxy_mode === 'warp' ? '' : normalizeProfileProxy(req.body?.proxy_value ?? req.body?.proxyValue ?? legacyProxy);
    const ruyi_fpfile = normalizeProfileUserDataDir(req.body?.ruyi_fpfile ?? req.body?.ruyiFpfile);
    const runtime_stack = normalizeProfileRuntimeStack(req.body?.runtime_stack ?? req.body?.runtimeStack);
    const locale = normalizeProfileLocale(req.body?.locale);
    const timezone_id = normalizeProfileTimezone(req.body?.timezone_id ?? req.body?.timezoneId);
    if (!name) return res.status(400).json({ message: 'Profile name is required' });
    const profile = db.updateBrowserProfile(id, {
      name: String(name),
      user_data_dir: normalizeProfileUserDataDir(user_data_dir),
      proxy: legacyProxy,
      proxy_mode,
      proxy_value,
      ruyi_fpfile,
      runtime_stack,
      locale,
      timezone_id,
    });
    res.json({ data: profile });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

  router.delete('/api/browser-profiles/:id', (req, res) => {
  try {
    db.deleteBrowserProfile(Number(req.params.id));
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

  router.post('/api/browser/close', async (req, res) => {
  try {
    const result = await closeManualBrowser();
    res.json({ data: result });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Failed to close browser' });
  }
});

  return router;
}

module.exports = { createBrowserRouteHelpers, createBrowserStatusRouter, createBrowserRuntimeRouter, createBrowserProfileRouter };
