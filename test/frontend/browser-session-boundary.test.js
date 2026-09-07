const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { read } = require('./helpers');

function createBoundary(responses = []) {
  const dom = new JSDOM('<button id="open"></button><button id="close"></button><button id="add"></button><select id="profile"><option value="7" selected>seven</option></select>');
  const calls = [];
  const toasts = [];
  const queue = [...responses];
  const context = vm.createContext({ window: dom.window });
  context.window.window = context.window;
  context.window.fetchJson = async (url, options) => {
    calls.push([url, options]);
    const result = queue.shift();
    if (result instanceof Error) throw result;
    return result || { data: {} };
  };
  vm.runInContext(read('public/features/browser-resources/api.js'), context);
  vm.runInContext(read('public/features/browser-resources/view.js'), context);
  vm.runInContext(read('public/features/browser-resources/controller.js'), context);
  const controller = context.window.BrowserResourcesController.create({
    api: context.window.BrowserResourcesApi,
    view: context.window.BrowserResourcesView,
    elements: {
      openBrowserBtn: dom.window.document.querySelector('#open'),
      closeBrowserBtn: dom.window.document.querySelector('#close'),
      addTaskBtn: dom.window.document.querySelector('#add'),
      browserProfileSelect: dom.window.document.querySelector('#profile'),
    },
    actions: {
      toast(message, type) { toasts.push([message, type]); },
      shortTime: (value) => `short:${value}`,
      createIcons() {},
    },
  });
  return { controller, calls, toasts, dom };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('feature browser session boundary matches frozen open trace', async () => {
  const boundary = createBoundary([{ data: {} }, { data: { open: true, openedAt: 'now' } }]);
  await boundary.controller.openBrowserSession();
  assert.deepEqual(plain(boundary.calls), [
    ['/api/browser/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile_id: '7' }) }],
    ['/api/browser', null],
  ]);
  assert.deepEqual(boundary.toasts, [
    ['正在启动浏览器…', 'info'],
    ['浏览器已成功启动（常驻，手动关闭或点「关闭浏览器」）', 'success'],
  ]);
});

test('feature browser session boundary matches frozen failure and close traces', async () => {
  const failed = createBoundary([new Error('launch denied'), { data: { open: false } }]);
  await failed.controller.openBrowserSession();
  assert.deepEqual(failed.toasts, [['正在启动浏览器…', 'info'], ['launch denied', 'error']]);
  const closed = createBoundary([{ data: {} }, { data: { open: false } }]);
  await closed.controller.closeBrowserSession();
  assert.deepEqual(plain(closed.calls), [['/api/browser/close', { method: 'POST' }], ['/api/browser', null]]);
  assert.deepEqual(closed.toasts, [['浏览器会话已安全关闭', 'success']]);
});

test('feature browser session state and bindings are independent and reversible', () => {
  const first = createBoundary();
  const second = createBoundary();
  first.controller.state.browserSessionOpen = true;
  assert.equal(second.controller.state.browserSessionOpen, false);
  let opens = 0;
  const button = first.dom.window.document.querySelector('#open');
  const original = button.addEventListener.bind(button);
  button.addEventListener = (...args) => { opens += 1; original(...args); };
  first.controller.mount();
  first.controller.mount();
  assert.equal(opens, 1);
  first.controller.unmount();
});
