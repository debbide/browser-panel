const browserApi = require('../server/runtime/browser-runtime');
const { screenshotPath } = require('../server/helpers');

(async () => {
  const taskId = process.env.TASK_ID || 'template';
  const { context, page } = await browserApi.launchBrowser();
  try {
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
    await page.screenshot({ path: screenshotPath(taskId, 'home'), fullPage: true });
  } finally {
    await context.close();
  }
})();
