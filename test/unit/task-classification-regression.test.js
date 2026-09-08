const test = require('node:test');
const assert = require('node:assert/strict');

const { createTaskService } = require('../../server/tasks/task-service');

function createHarness(existing = null) {
  let savedPayload = null;
  const db = {
    createTask(payload) { savedPayload = payload; return { id: 1, ...payload }; },
    updateTask(id, payload) { savedPayload = payload; return { id, ...payload }; },
    getTask() { return existing; },
    listLatestRunPerTask() { return []; },
    listTasks() { return []; },
  };
  const service = createTaskService({
    db,
    normalizeTaskEnvPayload() {},
    applyTaskEnvPayload() { return null; },
    decorateTaskForApi(task) { return task; },
    buildConditionFieldsFromPayload() { return {}; },
    resolveTaskGroupId(value) { return value; },
    normalizeExtraPathsPayload(value) { return value; },
    reloadJobs() {},
    executeTask() {},
    isTaskRunning() { return false; },
    emit() {},
  });
  return { service, getSavedPayload: () => savedPayload };
}

test('browser classification is explicit and independent of script language', () => {
  for (const type of ['javascript', 'python', 'php', 'shell']) {
    const browserHarness = createHarness();
    browserHarness.service.create({ name: type, type, script_path: `tasks/test.${type}`, use_browser: true });
    assert.equal(browserHarness.getSavedPayload().use_browser, 1, `${type} can be a browser task`);

    const requestHarness = createHarness();
    requestHarness.service.create({ name: type, type, script_path: `tasks/test.${type}`, use_browser: false });
    assert.equal(requestHarness.getSavedPayload().use_browser, 0, `${type} can be a request task`);
  }
});

test('editing preserves classification only when use_browser is omitted', () => {
  const existing = { id: 7, name: 'existing', type: 'python', script_path: 'tasks/existing.py', use_browser: 1 };
  const harness = createHarness(existing);

  harness.service.update(7, { ...existing, use_browser: false });
  assert.equal(harness.getSavedPayload().use_browser, 0);

  harness.service.update(7, { name: existing.name, type: existing.type, script_path: existing.script_path });
  assert.equal(harness.getSavedPayload().use_browser, 1);
});
