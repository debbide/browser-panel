const { chromium } = require('playwright');

async function launchBrowser() {
  const userDataDir = process.env.BROWSER_USER_DATA_DIR;
  const chromePath = process.env.BROWSER_CHROME_PATH;
  const proxy = process.env.BROWSER_PROXY;
  const headless = process.env.BROWSER_HEADLESS === 'true';

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    executablePath: chromePath,
    proxy: proxy ? { server: proxy } : undefined,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'UTC',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(30000);
  return { context, page };
}

module.exports = {
  launchBrowser,
};
