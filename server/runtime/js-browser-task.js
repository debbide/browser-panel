const { launchBrowserTaskAndWait } = require('./browser-launcher');

async function runNodeBrowserTask(task) {
  const runId = `${task?.id || 'task'}-${Date.now()}`;
  return launchBrowserTaskAndWait(task, runId);
}

module.exports = {
  runNodeBrowserTask,
};
