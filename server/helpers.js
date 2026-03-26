const path = require('path');

function screenshotPath(taskId, name = 'step') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(process.env.SCREENSHOTS_DIR || '.', `task-${taskId}-${name}-${stamp}.png`);
}

module.exports = {
  screenshotPath,
};
