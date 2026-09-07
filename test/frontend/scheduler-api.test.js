const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { read } = require('./helpers');

function loadApi(fetchJson) {
  const context = vm.createContext({ window: { fetchJson } });
  context.window.window = context.window;
  vm.runInContext(read('public/features/scheduler/api.js'), context);
  return context.window.SchedulerApi;
}

test('scheduler API exposes load and save operations', () => {
  const api = loadApi(async () => ({}));
  assert.equal(typeof api.load, 'function');
  assert.equal(typeof api.save, 'function');
});

test('scheduler API preserves path, method, headers, and payload', async () => {
  const calls = [];
  const api = loadApi(async (...args) => { calls.push(args); return { data: {} }; });
  const settings = { allowParallel: true, maxConcurrent: 3 };
  await api.load();
  await api.save(settings);
  assert.deepEqual(calls.map(([path, options]) => [path, options && JSON.parse(JSON.stringify(options))]), [
    ['/api/settings/scheduler', undefined],
    ['/api/settings/scheduler', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    }],
  ]);
});
