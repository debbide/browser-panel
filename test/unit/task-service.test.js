const test = require('node:test');
const assert = require('node:assert/strict');

const { createTaskService } = require('../../server/tasks/task-service');

function createDependencies(overrides = {}) {
  const calls = [];
  const tasks = new Map();
  let nextId = 1;
  const db = {
    createTask(payload) {
      const task = { id: nextId++, ...payload };
      tasks.set(task.id, task);
      calls.push(['create', task.id]);
      return task;
    },
    getTask(id) {
      return tasks.get(id) || null;
    },
    updateTask(id, payload) {
      const task = { id, ...payload };
      tasks.set(id, task);
      calls.push(['update', id]);
      return task;
    },
    deleteTask(id) {
      const existed = tasks.delete(id);
      calls.push(['delete', id]);
      return { changes: existed ? 1 : 0 };
    },
    listTasks() {
      return [...tasks.values()];
    },
    listLatestRunPerTask() {
      return [];
    },
    ...overrides.db,
  };
  return {
    calls,
    tasks,
    db,
    normalizeTaskEnvPayload() {},
    applyTaskEnvPayload(id) { return db.getTask(id); },
    decorateTaskForApi(task) { return task; },
    buildConditionFieldsFromPayload() { return {}; },
    resolveTaskGroupId() { return null; },
    normalizeExtraPathsPayload() { return null; },
    reloadJobs() { calls.push(['reload']); },
    executeTask() {},
    isTaskRunning() { return false; },
    ...overrides,
  };
}

test('task service preserves explicit script bindings and update bindings', () => {
  const dependencies = createDependencies();
  const service = createTaskService(dependencies);
  const created = service.create({ name: 'Example', type: 'python', script_path: 'custom/example.py' });
  assert.equal(created.script_path, 'custom/example.py');

  const updated = service.update(created.id, { name: 'Renamed', type: 'python' });
  assert.equal(updated.script_path, 'custom/example.py');
  assert.deepEqual(dependencies.calls, [['create', created.id], ['reload'], ['update', created.id], ['reload']]);
});

test('task service does not broadcast or reload before a failed database mutation', () => {
  const events = [];
  const dependencies = createDependencies({
    db: {
      createTask() { throw new Error('database unavailable'); },
    },
    emit(event, payload) { events.push([event, payload]); },
  });
  const service = createTaskService(dependencies);

  assert.throws(() => service.create({ name: 'Failure' }), /database unavailable/);
  assert.deepEqual(dependencies.calls, []);
  assert.deepEqual(events, []);
});

test('task service reports missing deletes and emits once after successful deletion', () => {
  const events = [];
  const dependencies = createDependencies({
    emit(event, payload) { events.push([event, payload]); },
  });
  const service = createTaskService(dependencies);

  assert.equal(service.remove(999), false);
  const task = service.create({ name: 'Delete me', type: 'shell' });
  events.length = 0;
  assert.equal(service.remove(task.id), true);
  assert.deepEqual(events, [['tasks', { action: 'deleted', task_id: task.id }]]);
});
