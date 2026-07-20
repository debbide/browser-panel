const { resolveSiteAdapter } = require('../sites/site-adapters');
const { normalizeModularStepsJson } = require('../definitions/task-definition');

function parseSteps(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function resolveStepsForTask(task) {
  const normalizedJson = normalizeModularStepsJson(task?.modular_steps_json || '');
  const customSteps = parseSteps(normalizedJson);
  if (customSteps.length) return customSteps;
  const adapter = resolveSiteAdapter(task);
  return Array.isArray(adapter?.steps) ? adapter.steps : [];
}

function buildWorkflowIrFromTask(task) {
  const steps = resolveStepsForTask(task);
  return {
    version: '1.0',
    kind: 'browser_workflow',
    metadata: {
      taskId: task?.id || null,
      taskName: task?.name || '',
      executionMode: task?.execution_mode || 'legacy',
      siteAdapter: task?.site_adapter || 'default',
      sourceScriptPath: task?.script_path || '',
      createdAt: new Date().toISOString(),
    },
    runtime: {
      timeoutSec: Number(task?.timeout_sec || 300),
      useBrowser: Boolean(task?.use_browser),
      usePersistent: Boolean(task?.use_persistent),
    },
    inputSchema: {
      username: { type: 'string', required: false },
      password: { type: 'string', required: false },
      login_url: { type: 'string', required: false },
      signin_url: { type: 'string', required: false },
    },
    steps,
  };
}

module.exports = {
  buildWorkflowIrFromTask,
};
