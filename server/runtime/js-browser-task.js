const { launchDetached } = require('./browser-launcher');

async function runNodeBrowserTask(task) {
  await launchDetached(task.script_path, {
    TASK_SCREENSHOT_PATH: process.env.TASK_SCREENSHOT_PATH,
  });
}

module.exports = {
  runNodeBrowserTask,
};
