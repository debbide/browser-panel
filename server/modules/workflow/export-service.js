const { buildWorkflowIrFromTask } = require('./ir');
const { exportJsPlaywright } = require('./exporters/js-playwright');
const { exportPySeleniumBase } = require('./exporters/py-seleniumbase');

function exportTaskWorkflow(task, target = 'js-playwright') {
  const ir = buildWorkflowIrFromTask(task);
  const normalizedTarget = String(target || 'js-playwright').trim().toLowerCase();
  const engine = String(task?.script_engine || '').trim().toLowerCase() || 'playwright';

  if (engine === 'seleniumbase' && normalizedTarget !== 'py-seleniumbase') {
    throw new Error('SeleniumBase engine tasks can only export to py-seleniumbase');
  }
  if (engine === 'playwright' && normalizedTarget !== 'js-playwright') {
    throw new Error('Playwright engine tasks can only export to js-playwright');
  }

  if (normalizedTarget === 'py-seleniumbase') {
    return {
      target: normalizedTarget,
      fileName: `task-${task.id || 'export'}-workflow.py`,
      language: 'python',
      code: exportPySeleniumBase(ir),
      ir,
    };
  }

  return {
    target: 'js-playwright',
    fileName: `task-${task.id || 'export'}-workflow.js`,
    language: 'javascript',
    code: exportJsPlaywright(ir),
    ir,
  };
}

module.exports = {
  exportTaskWorkflow,
};
