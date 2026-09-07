const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { read } = require('./helpers');

function loadApi() {
  const calls = [];
  const context = vm.createContext({
    window: {},
    fetchJson: async (url, options) => {
      calls.push({ url, options });
      return { data: { ok: true } };
    },
  });
  context.window = context;
  vm.runInContext(read('public/features/tasks/api.js'), context);
  return { api: context.TasksApi, calls };
}

test('task API preserves list, create and update request contracts', async () => {
  const { api, calls } = loadApi();
  const payload = { name: 'Example', type: 'python', script_path: 'tasks/example.py' };
  await api.listTasks();
  await api.saveTask(null, payload);
  await api.saveTask(42, payload);
  assert.equal(calls[0].url, '/api/tasks');
  assert.equal(calls[0].options, undefined);
  assert.equal(calls[1].url, '/api/tasks');
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), payload);
  assert.equal(calls[2].url, '/api/tasks/42');
  assert.equal(calls[2].options.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[2].options.body), payload);
});

test('task API preserves run, stop, delete and condition request contracts', async () => {
  const { api, calls } = loadApi();
  await api.runTask(7, 19);
  await api.stopTask(7);
  await api.deleteTask(7);
  const result = await api.testCondition(7, { type: 'http_check' });
  assert.deepEqual(calls.map(call => [call.url, call.options.method]), [
    ['/api/tasks/7/run', 'POST'],
    ['/api/tasks/7/stop', 'POST'],
    ['/api/tasks/7', 'DELETE'],
    ['/api/tasks/7/condition/test', 'POST'],
  ]);
  assert.deepEqual(JSON.parse(calls[0].options.body), { profile_id: 19 });
  assert.deepEqual(JSON.parse(calls[3].options.body), { condition: { type: 'http_check' } });
  assert.deepEqual(result, { ok: true });
});
