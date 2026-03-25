const { launchBrowser, createHelpers } = require('../server/browser');

module.exports = async function run(task) {
  const { context, page } = await launchBrowser();
  const helpers = createHelpers(task.id || 'example');

  try {
    await page.goto('https://nav.bcbc.pp.ua', { waitUntil: 'domcontentloaded' });
    await page.screenshot({ path: helpers.screenshotPath, fullPage: true });
  } finally {
    await context.close();
  }
};
