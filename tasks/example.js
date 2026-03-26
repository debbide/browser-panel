const fs = require('fs');
const browserApi = require('./browser-runtime');

(async () => {
  const screenshotPath = process.env.TASK_SCREENSHOT_PATH;
  const resultPath = process.env.TASK_RESULT_PATH;
  let payload = { ok: false };
  try {
    const { context, page } = await browserApi.launchBrowser();
    try {
      await page.goto('https://nav.bcbc.pp.ua', { waitUntil: 'domcontentloaded' });
      if (screenshotPath) {
        await page.screenshot({ path: screenshotPath, fullPage: true });
      }
      console.log('Page opened and screenshot saved');
      payload = { ok: true, screenshotPath: screenshotPath || null };
    } finally {
      await context.close();
    }
  } catch (error) {
    console.error(error);
    payload = { ok: false, error: error.message || String(error) };
    process.exitCode = 1;
  } finally {
    if (resultPath) {
      fs.writeFileSync(resultPath, JSON.stringify(payload, null, 2));
    }
  }
})();
