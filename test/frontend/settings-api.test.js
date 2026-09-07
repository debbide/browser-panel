const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { read } = require('./helpers');

function loadApi(fetchJson) {
  const context = vm.createContext({ window: { fetchJson } });
  context.window.window = context.window;
  vm.runInContext(read('public/features/settings/api.js'), context);
  return context.window.SettingsApi;
}

test('settings API module is exposed without changing static delivery', () => {
  const api = loadApi(async () => ({}));
  assert.equal(typeof api.loadScheduler, 'function');
  assert.equal(typeof api.saveScheduler, 'function');
  assert.equal(typeof api.loadSuccessHeuristics, 'function');
  assert.equal(typeof api.saveSuccessHeuristics, 'function');
  assert.equal(typeof api.loadBrowserRuntime, 'function');
  assert.equal(typeof api.saveBrowserRuntime, 'function');
});

test('scheduler settings preserve paths, method, headers, and payload', async () => {
  const calls = [];
  const api = loadApi(async (...args) => { calls.push(args); return { data: {} }; });
  await api.loadScheduler();
  await api.saveScheduler({ allowParallel: true });
  assert.deepEqual(calls.map(([path, options]) => [path, options && JSON.parse(JSON.stringify(options))]), [
    ['/api/settings/scheduler', undefined],
    ['/api/settings/scheduler', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowParallel: true }),
    }],
  ]);
});

test('success heuristics and browser runtime preserve settings requests', async () => {
  const calls = [];
  const api = loadApi(async (...args) => { calls.push(args); return { data: {} }; });
  const heuristics = { enabled: true, minRunSeconds: 12 };
  const runtime = { runtimeStack: 'playwright', usePlaywrightExtra: true };
  await api.loadSuccessHeuristics();
  await api.saveSuccessHeuristics(heuristics);
  await api.loadBrowserRuntime();
  await api.saveBrowserRuntime(runtime);
  assert.deepEqual(calls.map(([path, options]) => [path, options && JSON.parse(JSON.stringify(options))]), [
    ['/api/settings/success-heuristics', undefined],
    ['/api/settings/success-heuristics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(heuristics),
    }],
    ['/api/settings/browser-runtime', undefined],
    ['/api/settings/browser-runtime', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(runtime),
    }],
  ]);
});

test('production page loads settings API before the application entry', () => {
  const html = read('public/index.html');
  const settingsApi = html.indexOf('/features/settings/api.js?v=20260907a');
  const app = html.indexOf('/app.js?v=20260814c');
  assert.ok(settingsApi >= 0);
  assert.ok(app > settingsApi);
});
