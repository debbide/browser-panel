const fs = require('fs');
const path = require('path');
const config = require('../../../config');
const { builtinActions } = require('../actions/builtins');
const { resolveSiteAdapter } = require('../sites/site-adapters');

function ensureGeneratedDir() {
  const dir = path.join(config.paths.root, 'runtime-data', 'generated');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function buildScriptSource(payload) {
  const workDir = (config.browser && config.browser.workDir)
    ? String(config.browser.workDir)
    : path.join('/home', (config.browser && config.browser.user) || 'browser', 'browser-work');
  const builtinsPath = path.join(workDir, 'modules', 'actions', 'builtins.js').replace(/\\/g, '/');
  return `'use strict';

const { builtinActions } = require(${JSON.stringify(builtinsPath)});
const payload = ${JSON.stringify(payload, null, 2)};

module.exports = async ({ page, screenshotPath }) => {
  const output = {};
  let failedStep = '';
  const steps = Array.isArray(payload.steps) ? payload.steps : [];
  try {
    for (let idx = 0; idx < steps.length; idx += 1) {
      const step = steps[idx];
      const actionName = String(step && step.action || '').trim();
      failedStep = 'step_' + (idx + 1) + '_' + actionName;
      const action = builtinActions[actionName];
      if (!action) {
        throw new Error('Unsupported action: ' + actionName);
      }
      await action({
        page,
        step: {
          ...step,
          path: step.path || screenshotPath || process.env.TASK_SCREENSHOT_PATH || '',
        },
        taskInput: payload.input || {},
        output,
      });
    }
  } catch (error) {
    const wrapped = new Error((error && error.message) ? error.message : String(error));
    wrapped.failed_step = failedStep || 'unknown_step';
    throw wrapped;
  }
  return output;
};
`;
}

function createModularTaskFile(task) {
  const adapter = resolveSiteAdapter(task);
  let customSteps = [];
  if (task && task.modular_steps_json) {
    try {
      const parsed = JSON.parse(String(task.modular_steps_json));
      if (Array.isArray(parsed)) customSteps = parsed;
    } catch {
      customSteps = [];
    }
  }
  const taskInput = {
    login_url: task.login_url,
    signin_url: task.signin_url,
  };
  const payload = {
    adapter: adapter.key,
    steps: customSteps.length > 0 ? customSteps : adapter.steps,
    input: taskInput,
  };

  const dir = ensureGeneratedDir();
  const filePath = path.join(dir, `modular-task-${task.id}.js`);
  fs.writeFileSync(filePath, buildScriptSource(payload), 'utf8');
  return filePath;
}

module.exports = {
  createModularTaskFile,
};
