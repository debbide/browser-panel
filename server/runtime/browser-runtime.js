const fs = require('fs');
const path = require('path');

function toBool(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function parsePackageList(value) {
  return String(value || '')
    .split(/[\r\n,;]+/g)
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function loadChromiumRuntime() {
  const pluginPackages = parsePackageList(process.env.BROWSER_PLUGIN_PACKAGES);
  const usePlaywrightExtra = toBool(process.env.BROWSER_USE_PLAYWRIGHT_EXTRA) || pluginPackages.length > 0;
  let chromium;

  if (usePlaywrightExtra) {
    const runtime = require('playwright-extra');
    chromium = runtime.chromium;
    for (const pkg of pluginPackages) {
      const pluginModule = require(pkg);
      const pluginFactory = typeof pluginModule === 'function'
        ? pluginModule
        : (pluginModule && typeof pluginModule.default === 'function' ? pluginModule.default : null);
      if (!pluginFactory) {
        throw new Error(`Plugin "${pkg}" must export a function`);
      }
      chromium.use(pluginFactory());
    }
  } else {
    const runtime = require('playwright');
    chromium = runtime.chromium;
  }

  return chromium;
}

function parseExtensionDirs(value) {
  const roots = [
    process.env.APP_ROOT,
    process.env.APP_ROOT ? path.join(process.env.APP_ROOT, 'tasks') : '',
    process.cwd(),
    path.join(process.cwd(), 'tasks'),
  ].filter(Boolean);
  return String(value || '')
    .split(/[|;]/g)
    .map(item => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
    .flatMap(item => (path.isAbsolute(item) ? [item] : roots.map(root => path.join(root, item))))
    .map(item => path.resolve(item))
    .filter((item, index, items) => items.indexOf(item) === index)
    .filter(item => {
      try {
        return fs.statSync(item).isDirectory() && fs.existsSync(path.join(item, 'manifest.json'));
      } catch {
        return false;
      }
    });
}

function getExtensionArgs() {
  const raw = process.env.BROWSER_EXTENSIONS;
  const extensionDirs = parseExtensionDirs(raw);
  if (!String(raw || '').trim()) return {};
  if (extensionDirs.length === 0) {
    console.warn('[browser-runtime] BROWSER_EXTENSIONS configured but no unpacked extensions were found');
    return {};
  }
  const joined = extensionDirs.join(',');
  console.log(`[browser-runtime] loading ${extensionDirs.length} unpacked extension(s)`);
  return {
    args: [`--load-extension=${joined}`],
  };
}

async function launchBrowser() {
  const chromium = loadChromiumRuntime();
  const userDataDir = process.env.BROWSER_USER_DATA_DIR;
  const chromePath = process.env.BROWSER_CHROME_PATH;
  const proxy = process.env.BROWSER_PROXY;
  const headless = process.env.BROWSER_HEADLESS === 'true';
  const locale = process.env.BROWSER_LOCALE || 'zh-CN';
  const timezoneId = process.env.BROWSER_TIMEZONE || 'Asia/Shanghai';

  const extensionOptions = getExtensionArgs();
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    executablePath: chromePath,
    proxy: proxy ? { server: proxy } : undefined,
    viewport: { width: 1440, height: 900 },
    locale,
    timezoneId,
    // Playwright 1.58 adds --disable-extensions by default. Remove only that
    // default so persistent profiles can still use Chrome Web Store extensions.
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      ...(extensionOptions.args || []),
    ],
  });

  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(30000);
  return { context, page };
}

module.exports = {
  launchBrowser,
};
