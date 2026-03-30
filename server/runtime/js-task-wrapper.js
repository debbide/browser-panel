const fs = require('fs');
const path = require('path');
const { launchBrowser } = require('./browser-runtime');

async function run() {
  const taskFile = process.argv[2];
  const screenshotPath = process.env.TASK_SCREENSHOT_PATH;
  const resultPath = process.env.TASK_RESULT_PATH;
  let payload = { ok: false };
  let context = null;

  try {
    if (!taskFile) throw new Error('Missing task file');
    const taskModule = require(path.resolve(taskFile));
    const taskFn = typeof taskModule === 'function'
      ? taskModule
      : typeof taskModule?.run === 'function'
        ? taskModule.run
        : null;

    if (!taskFn) {
      throw new Error('Task must export an async function');
    }

    const launched = await launchBrowser();
    context = launched.context;

    const result = await taskFn({
      context: launched.context,
      page: launched.page,
      screenshotPath,
      env: process.env,
    });

    if (screenshotPath && !fs.existsSync(screenshotPath)) {
      await launched.page.screenshot({ path: screenshotPath, fullPage: true });
    }

    payload = {
      ok: true,
      screenshotPath: screenshotPath || null,
      data: result ?? null,
    };
  } catch (error) {
    console.error(error);
    payload = {
      ok: false,
      error: error.message || String(error),
    };
    process.exitCode = 1;
  } finally {
    if (context) {
      try {
        await context.close();
      } catch (error) {
        console.error(error);
      }
    }
    if (resultPath) {
      fs.writeFileSync(resultPath, JSON.stringify(payload, null, 2));
    }
  }
}

run();
