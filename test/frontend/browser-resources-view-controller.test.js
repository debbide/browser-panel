const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { read } = require('./helpers');

function loadModule(path, name, window = {}) {
  const context = vm.createContext({ window });
  context.window.window = context.window;
  vm.runInContext(read(path), context);
  return context.window[name];
}

test('browser resources view exposes stable rendering boundaries', () => {
  const view = loadModule('public/features/browser-resources/view.js', 'BrowserResourcesView');
  assert.equal(typeof view.renderBrowserControls, 'function');
  assert.equal(typeof view.renderProfiles, 'function');
  assert.equal(typeof view.renderResourceEntries, 'function');
});

test('browser resources controller exposes idempotent lifecycle and load', () => {
  const controller = loadModule('public/features/browser-resources/controller.js', 'BrowserResourcesController');
  assert.equal(typeof controller.create, 'function');
  const instance = controller.create({ api: {}, view: {}, actions: {} });
  assert.equal(typeof instance.mount, 'function');
  assert.equal(typeof instance.unmount, 'function');
  assert.equal(typeof instance.load, 'function');
});

test('production page loads browser resources modules before app', () => {
  const html = read('public/index.html');
  const api = html.indexOf('/features/browser-resources/api.js?v=20260907a');
  const view = html.indexOf('/features/browser-resources/view.js?v=20260907a');
  const controller = html.indexOf('/features/browser-resources/controller.js?v=20260907a');
  const app = html.indexOf('/app.js?v=20260814c');
  assert.ok(api >= 0);
  assert.ok(view > api);
  assert.ok(controller > view);
  assert.ok(app > controller);
});

test('application entry delegates resource manager startup', () => {
  const source = read('public/app.js');
  assert.match(source, /BrowserResourcesController\.create\(/);
  assert.match(source, /browserResourcesController\.mount\(\)/);
});
