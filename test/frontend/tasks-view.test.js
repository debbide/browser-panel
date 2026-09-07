const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { read } = require('./helpers');

function loadView() {
  const context = vm.createContext({ window: {} });
  context.window = context;
  vm.runInContext(read('public/features/tasks/view.js'), context);
  return context.TasksView;
}

test('task view module is exposed without changing the static delivery model', () => {
  const view = loadView();
  assert.equal(typeof view.taskCard, 'function');
  assert.equal(typeof view.renderTaskGroups, 'function');
});

test('task view source preserves task card DOM and group filter selectors', () => {
  const source = read('public/features/tasks/view.js');
  assert.match(source, /data-testid="task-card"/);
  assert.match(source, /data-task-id=/);
  assert.match(source, /data-task-overflow-trigger/);
  assert.match(source, /class="task-group-chip/);
  assert.match(source, /class="task-grid"/);
  assert.match(source, /当前还没有任务。/);
  assert.match(source, /当前分组没有任务。/);
});

test('production page loads task view before the application entry', () => {
  const html = read('public/index.html');
  const view = html.indexOf('/features/tasks/view.js?v=20260907a');
  const app = html.indexOf('/app.js?v=20260814c');
  assert.ok(view >= 0);
  assert.ok(app > view);
});
