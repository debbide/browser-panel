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

async function launchBrowser() {
  const chromium = loadChromiumRuntime();
  const userDataDir = process.env.BROWSER_USER_DATA_DIR;
  const chromePath = process.env.BROWSER_CHROME_PATH;
  const proxy = process.env.BROWSER_PROXY;
  const headless = process.env.BROWSER_HEADLESS === 'true';
  const locale = process.env.BROWSER_LOCALE || 'zh-CN';
  const timezoneId = process.env.BROWSER_TIMEZONE || 'Asia/Shanghai';

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    executablePath: chromePath,
    proxy: proxy ? { server: proxy } : undefined,
    viewport: { width: 1440, height: 900 },
    locale,
    timezoneId,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(30000);
  return { context, page };
}

module.exports = {
  launchBrowser,
};
