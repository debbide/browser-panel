module.exports = async ({ page, screenshotPath }) => {
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });

  if (screenshotPath) {
    await page.screenshot({ path: screenshotPath });
  }

  return { title: await page.title() };
};
