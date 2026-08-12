const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("https://example.com/login");

  await page.locator("#email").waitFor({ state: 'visible' });
  await page.locator("#email").fill("demo@example.com");
  await page.locator("#password").waitFor({ state: 'visible' });
  await page.locator("#password").fill("{{PASSWORD}}");
  await page.locator("button[type='submit']").waitFor({ state: 'visible' });
  await page.locator("button[type='submit']").click();
  await page.waitForTimeout(1500);
  if (!page.url().includes("dashboard")) throw new Error('URL assertion failed');
  await page.locator(".user-menu").waitFor({ state: 'visible' });
  await page.locator(".user-menu").hover();
  await page.locator("input[name='search']").waitFor({ state: 'visible' });
  await page.locator("input[name='search']").press("Enter");
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.screenshot({ path: "after-login.png", fullPage: false });

  // await browser.close();
})();
