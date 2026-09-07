const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { read } = require('./helpers');

function createHarness(responses = []) {
  const dom = new JSDOM(`
    <button id="open"></button>
    <button id="close"></button>
    <button id="add"></button>
    <select id="profile"><option value=""></option><option value="7" selected>seven</option></select>
  `);
  const calls = [];
  const toasts = [];
  const icons = [];
  const queue = [...responses];
  const context = vm.createContext({ window: dom.window });
  context.window.window = context.window;
  context.window.fetchJson = async (url, options) => {
      calls.push([url, options]);
      const result = queue.shift();
      if (result instanceof Error) throw result;
      return result || { data: {} };
  };
  context.window.lucide = { createIcons(options) { icons.push(options.root.id); } };
  vm.runInContext(read('public/features/browser-resources/api.js'), context);
  vm.runInContext(read('public/features/browser-resources/view.js'), context);
  vm.runInContext(read('public/features/browser-resources/controller.js'), context);
  const elements = {
    openBrowserBtn: dom.window.document.querySelector('#open'),
    closeBrowserBtn: dom.window.document.querySelector('#close'),
    addTaskBtn: dom.window.document.querySelector('#add'),
    browserProfileSelect: dom.window.document.querySelector('#profile'),
  };
  const controller = context.window.BrowserResourcesController.create({
    api: context.window.BrowserResourcesApi,
    view: context.window.BrowserResourcesView,
    elements,
    actions: {
      shortTime: (value) => `short:${value}`,
      toast(message, type) { toasts.push([message, type]); },
      createIcons(root) { context.window.lucide.createIcons({ root }); },
    },
  });
  return { ...controller, controller, context, calls, toasts, icons, ...elements };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('browser status load preserves state and visible controls', async () => {
  const harness = createHarness([{ data: { open: true, openedAt: '2026-01-02T03:04:05Z' } }]);
  await harness.loadBrowserStatus();
  assert.deepEqual(harness.calls, [['/api/browser', undefined]]);
  assert.equal(harness.state.browserSessionOpen, true);
  assert.equal(harness.state.browserOpenedAt, '2026-01-02T03:04:05Z');
  assert.equal(harness.openBrowserBtn.disabled, true);
  assert.match(harness.openBrowserBtn.innerHTML, /已启动/);
  assert.equal(harness.closeBrowserBtn.disabled, false);
  assert.match(harness.closeBrowserBtn.innerHTML, /关闭浏览器/);
  assert.equal(harness.addTaskBtn.title, '浏览器已打开：short:2026-01-02T03:04:05Z');
});

test('browser open preserves payload, message order, and refreshed state', async () => {
  const harness = createHarness([{ data: {} }, { data: { open: true, openedAt: 'now' } }]);
  await harness.openBrowserSession();
  assert.deepEqual(plain(harness.calls), [
    ['/api/browser/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile_id: '7' }) }],
    ['/api/browser', null],
  ]);
  assert.deepEqual(harness.toasts, [
    ['正在启动浏览器…', 'info'],
    ['浏览器已成功启动（常驻，手动关闭或点「关闭浏览器」）', 'success'],
  ]);
  assert.equal(harness.openBrowserBtn.disabled, true);
  assert.equal(harness.closeBrowserBtn.disabled, false);
});

test('browser open failure refreshes status before reporting the exact error', async () => {
  const harness = createHarness([new Error('launch denied'), { data: { open: false } }]);
  await harness.openBrowserSession();
  assert.deepEqual(harness.calls.map(([url]) => url), ['/api/browser/open', '/api/browser']);
  assert.deepEqual(harness.toasts, [
    ['正在启动浏览器…', 'info'],
    ['launch denied', 'error'],
  ]);
  assert.equal(harness.openBrowserBtn.disabled, false);
  assert.equal(harness.closeBrowserBtn.disabled, true);
});

test('browser close preserves method, refresh order, and success message', async () => {
  const harness = createHarness([{ data: {} }, { data: { open: false } }]);
  await harness.closeBrowserSession();
  assert.deepEqual(plain(harness.calls), [
    ['/api/browser/close', { method: 'POST' }],
    ['/api/browser', null],
  ]);
  assert.deepEqual(harness.toasts, [['浏览器会话已安全关闭', 'success']]);
  assert.equal(harness.openBrowserBtn.disabled, false);
  assert.equal(harness.closeBrowserBtn.disabled, true);
});

test('browser close failure preserves visible state and reports exact error', async () => {
  const harness = createHarness([new Error('close denied')]);
  harness.state.browserSessionOpen = true;
  harness.renderBrowserControls();
  await harness.closeBrowserSession();
  assert.deepEqual(plain(harness.calls), [['/api/browser/close', { method: 'POST' }]]);
  assert.deepEqual(harness.toasts, [['close denied', 'error']]);
  assert.equal(harness.openBrowserBtn.disabled, true);
  assert.equal(harness.closeBrowserBtn.disabled, false);
});
