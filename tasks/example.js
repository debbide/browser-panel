module.exports = async ({ page, screenshotPath }) => {
  await page.goto('https://nav.bcbc.pp.ua', { waitUntil: 'domcontentloaded' });

  if (screenshotPath) {
    await page.screenshot({ path: screenshotPath });
  }

  console.log('Page opened and screenshot saved');
  return { opened: true };
};
