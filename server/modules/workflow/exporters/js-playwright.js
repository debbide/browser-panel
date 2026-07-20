function esc(value) {
  return JSON.stringify(String(value ?? ''));
}

function timeoutArg(step) {
  const t = Number(step?.timeoutMs || 0);
  return Number.isFinite(t) && t > 0 ? `, { timeout: ${Math.floor(t)} }` : '';
}

function stepToJs(step, index) {
  const action = String(step?.action || '').trim();
  const selector = String(step?.selector || '');
  const url = String(step?.url || '');
  const value = String(step?.value || '');
  const valueFrom = String(step?.valueFrom || '');
  const name = String(step?.name || `field_${index + 1}`);
  const waitState = String(step?.state || 'visible');
  const waitUntil = String(step?.waitUntil || 'domcontentloaded');
  const path = String(step?.path || '');

  if (action === 'open') {
    return `  await page.goto(${esc(url)}, { waitUntil: ${esc(waitUntil)}${Number(step?.timeoutMs) > 0 ? `, timeout: ${Math.floor(Number(step.timeoutMs))}` : ''} });`;
  }
  if (action === 'wait') {
    return `  await page.waitForSelector(${esc(selector)}, { state: ${esc(waitState)}${Number(step?.timeoutMs) > 0 ? `, timeout: ${Math.floor(Number(step.timeoutMs))}` : ''} });`;
  }
  if (action === 'click') {
    return `  await page.click(${esc(selector)}${timeoutArg(step)});`;
  }
  if (action === 'type') {
    if (valueFrom) {
      return `  await page.fill(${esc(selector)}, String(input[${esc(valueFrom)}] ?? '')${timeoutArg(step)});`;
    }
    return `  await page.fill(${esc(selector)}, ${esc(value)}${timeoutArg(step)});`;
  }
  if (action === 'extract') {
    return `  output[${esc(name)}] = String(await page.textContent(${esc(selector)}${timeoutArg(step)}) || '').trim();`;
  }
  if (action === 'check') {
    return `  if ((await page.locator(${esc(selector)}).count()) < 1) { throw new Error(${esc(step?.message || `check failed: ${selector}`)}); }`;
  }
  if (action === 'screenshot') {
    const targetPath = path ? esc(path) : `process.env.SCREENSHOT_PATH || 'screenshot.png'`;
    const fullPage = step?.fullPage === false ? 'false' : 'true';
    return `  await page.screenshot({ path: ${targetPath}, fullPage: ${fullPage} });`;
  }
  return `  // Unsupported action: ${action}`;
}

function exportJsPlaywright(ir) {
  const steps = Array.isArray(ir?.steps) ? ir.steps : [];
  const body = steps.map((step, idx) => stepToJs(step, idx)).join('\n');
  return `const { chromium } = require('playwright');

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const input = {
    username: process.env.WF_USERNAME || '',
    password: process.env.WF_PASSWORD || '',
    login_url: process.env.WF_LOGIN_URL || '',
    signin_url: process.env.WF_SIGNIN_URL || '',
  };
  const output = {};

  try {
${body}
    console.log(JSON.stringify({ ok: true, output }, null, 2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

run();
`;
}

module.exports = {
  exportJsPlaywright,
};
