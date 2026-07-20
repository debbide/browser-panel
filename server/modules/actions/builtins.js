function safeSelector(step) {
  return step?.selector || step?.target || '';
}

async function actionOpen({ page, step }) {
  const url = String(step?.url || '').trim();
  if (!url) throw new Error('open step requires url');
  await page.goto(url, { waitUntil: step?.waitUntil || 'domcontentloaded', timeout: Number(step?.timeoutMs || 30000) });
  return { url };
}

async function actionWait({ page, step }) {
  const selector = safeSelector(step);
  if (!selector) throw new Error('wait step requires selector');
  await page.waitForSelector(selector, {
    timeout: Number(step?.timeoutMs || 15000),
    state: step?.state || 'visible',
  });
  return { selector };
}

async function actionClick({ page, step }) {
  const selector = safeSelector(step);
  if (!selector) throw new Error('click step requires selector');
  await page.click(selector, { timeout: Number(step?.timeoutMs || 15000) });
  return { selector };
}

async function actionType({ page, step, taskInput }) {
  const selector = safeSelector(step);
  if (!selector) throw new Error('type step requires selector');

  let value = step?.value;
  const fromInput = String(step?.valueFrom || '').trim();
  if (fromInput) {
    value = taskInput?.[fromInput] ?? '';
  }
  const finalValue = String(value ?? '');

  await page.fill(selector, finalValue, { timeout: Number(step?.timeoutMs || 15000) });
  return { selector, valueLength: finalValue.length };
}

async function actionExtract({ page, step, output }) {
  const selector = safeSelector(step);
  if (!selector) throw new Error('extract step requires selector');
  const name = String(step?.name || '').trim();
  if (!name) throw new Error('extract step requires name');
  const text = await page.textContent(selector, { timeout: Number(step?.timeoutMs || 15000) });
  output[name] = String(text || '').trim();
  return { selector, name };
}

async function actionScreenshot({ page, step }) {
  const path = String(step?.path || process.env.TASK_SCREENSHOT_PATH || '').trim();
  if (!path) throw new Error('screenshot step requires path or TASK_SCREENSHOT_PATH');
  await page.screenshot({ path, fullPage: step?.fullPage !== false });
  return { path };
}

async function actionCheck({ page, step }) {
  const selector = safeSelector(step);
  if (!selector) throw new Error('check step requires selector');
  const exists = await page.locator(selector).count();
  if (!exists) {
    throw new Error(step?.message || `check failed: ${selector}`);
  }
  return { selector };
}

const builtinActions = {
  open: actionOpen,
  wait: actionWait,
  click: actionClick,
  type: actionType,
  extract: actionExtract,
  screenshot: actionScreenshot,
  check: actionCheck,
};

module.exports = {
  builtinActions,
};
