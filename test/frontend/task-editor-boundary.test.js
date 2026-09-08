const test = require('node:test');
const assert = require('node:assert/strict');
const { read } = require('./helpers');

test('task editor has one focused implementation, state, and binding owner', () => {
  const controller = read('public/features/tasks/editor-controller.js');
  const runtime = read('public/panel-runtime.js');

  assert.match(controller, /function createTaskEditorController/);
  assert.match(controller, /let editingId = null/);
  assert.equal((controller.match(/form\.addEventListener\('submit'/g) || []).length, 1);
  assert.equal((controller.match(/addTaskBtn\.addEventListener\('click'/g) || []).length, 1);
  assert.doesNotMatch(runtime, /function deleteTask\(/);
  assert.doesNotMatch(runtime, /async function editTask\(/);
  assert.doesNotMatch(runtime, /form\.addEventListener\('submit'/);
  assert.doesNotMatch(runtime, /addTaskBtn\.addEventListener\('click'/);
});

test('task editor controller loads after task API and before panel runtime', () => {
  const html = read('public/index.html');
  const apiIndex = html.indexOf('/features/tasks/api.js');
  const controllerIndex = html.indexOf('/features/tasks/editor-controller.js');
  const runtimeIndex = html.indexOf('/panel-runtime.js');

  assert.ok(apiIndex >= 0);
  assert.ok(controllerIndex > apiIndex);
  assert.ok(runtimeIndex > controllerIndex);
});

test('task editor preserves create, update, clone, delete and refresh contracts', () => {
  const controller = read('public/features/tasks/editor-controller.js');

  assert.match(controller, /TasksApi\.saveTask\(editingId, payload\)/);
  assert.match(controller, /TasksApi\.deleteTask\(id\)/);
  assert.match(controller, /payload\.type = TasksModel\.resolveTaskType\(payload\.script_path, payload\.type\)/);
  assert.match(controller, /payload\.use_browser = String\(payload\.use_browser\) === '1'/);
  assert.doesNotMatch(controller, /payload\.use_browser = !\[['"]python['"]/);
  assert.match(controller, /await loadTasks\(\)/);
  assert.match(controller, /openModal\('create'\)/);
  assert.match(controller, /openModal\('edit'\)/);
  assert.match(controller, /closeModal\(\)/);
  assert.match(controller, /escapeHtml/);
});
