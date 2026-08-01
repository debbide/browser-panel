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

  // 面板已把浏览器进程降到 BROWSER_USER（browser.js 用 setuid/setgid，
  // browser-launcher.js 用 setpriv），非 root 下 Chrome sandbox 本来就能起来。
  // --no-sandbox 是当年 root 运行的遗留：关掉沙箱 = 丢掉渲染器的
  // seccomp/namespace 隔离，网页内容打穿渲染器就直接拿到该用户的全部权限。
  // 少数机器（AppArmor 限制、老内核不给 unprivileged userns）沙箱起不来会
  // 直接 "No usable sandbox" 启动失败 —— 那种机器把 BROWSER_NO_SANDBOX=1
  // 写进 .env.panel 即可回到旧行为，不用改代码。
  const args = ['--disable-dev-shm-usage'];
  if (String(process.env.BROWSER_NO_SANDBOX || '').trim() === '1') {
    args.unshift('--no-sandbox', '--disable-setuid-sandbox');
  }

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    executablePath: chromePath,
    proxy: proxy ? { server: proxy } : undefined,
    viewport: { width: 1440, height: 900 },
    locale,
    timezoneId,
    args,
  });

  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(30000);
  return { context, page };
}

module.exports = {
  launchBrowser,
};
