const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { read } = require('./helpers');

function loadModel() {
  const context = vm.createContext({ window: {} });
  context.window = context;
  vm.runInContext(read('public/features/tasks/model.js'), context);
  return context.TasksModel;
}

test('task payload type follows all four supported script extensions', () => {
  const model = loadModel();
  assert.equal(model.resolveTaskType('tasks/example.js', 'javascript'), 'javascript');
  assert.equal(model.resolveTaskType('tasks/example.py', 'javascript'), 'python');
  assert.equal(model.resolveTaskType('tasks/example.php', 'javascript'), 'php');
  assert.equal(model.resolveTaskType('tasks/example.sh', 'javascript'), 'shell');
});

test('task payload keeps explicit type for unknown script extensions', () => {
  const model = loadModel();
  assert.equal(model.resolveTaskType('tasks/example.custom', 'node'), 'node');
});
