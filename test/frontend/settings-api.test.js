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
  assert.equal(typeof api.loadTelegram, 'function');
  assert.equal(typeof api.saveTelegram, 'function');
  assert.equal(typeof api.testTelegram, 'function');
  assert.equal(typeof api.saveScheduler, 'function');
  assert.equal(typeof api.loadSuccessHeuristics, 'function');
  assert.equal(typeof api.saveSuccessHeuristics, 'function');
  assert.equal(typeof api.loadBrowserRuntime, 'function');
  assert.equal(typeof api.saveBrowserRuntime, 'function');
});

test('telegram settings preserve load, save and test request contracts', async () => {
  const calls = [];
  const api = loadApi(async (...args) => { calls.push(args); return { data: {} }; });
  const payload = { botToken: 'token', chatId: '42', proxy: '', webhookUrl: 'https://example.test' };
  await api.loadTelegram();
  await api.saveTelegram(payload);
  await api.testTelegram();
  assert.deepEqual(calls.map(([path, options]) => [path, options && JSON.parse(JSON.stringify(options))]), [
    ['/api/settings/telegram', undefined],
    ['/api/settings/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }],
    ['/api/settings/telegram/test', { method: 'POST' }],
  ]);
});

test('vision settings preserve load, save, model update and test contracts', async () => {
  const calls = [];
  const api = loadApi(async (path, options) => {
    calls.push([path, options]);
    return { data: {} };
  });
  const channelList = [{ id: 'primary', baseUrl: 'https://vision.example', apiKey: '', model: 'vision-model' }];

  await api.loadVision();
  await api.saveVision({ channelList });
  await api.updateVisionModel({ id: 'primary', model: 'vision-model' });
  await api.testVision({ baseUrl: 'https://vision.example', apiKey: 'secret', model: 'vision-model', fetchModels: true, testImage: false });

  assert.deepEqual(calls.map(([path, options]) => [path, options && JSON.parse(JSON.stringify(options))]), [
    ['/api/settings/vision', undefined],
    ['/api/settings/vision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelList }),
    }],
    ['/api/settings/vision/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'primary', model: 'vision-model' }),
    }],
    ['/api/settings/vision/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://vision.example', apiKey: 'secret', model: 'vision-model', fetchModels: true, testImage: false }),
    }],
  ]);
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
