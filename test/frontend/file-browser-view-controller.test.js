const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { read } = require('./helpers');

function loadModule(path, name) {
  const context = vm.createContext({ window: {} });
  context.window.window = context.window;
  vm.runInContext(read(path), context);
  return context.window[name];
}

test('file browser view exposes stable formatting and rendering boundaries', () => {
  const view = loadModule('public/features/file-browser/view.js', 'FileBrowserView');
  assert.equal(view.formatBytes(0), '0 B');
  assert.equal(view.formatBytes(1536), '1.5 KB');
  assert.equal(view.formatMtime(''), '—');
  assert.equal(typeof view.renderBreadcrumb, 'function');
  assert.equal(typeof view.renderEntries, 'function');
});

test('file browser controller exposes idempotent lifecycle and navigation', () => {
  const controller = loadModule('public/features/file-browser/controller.js', 'FileBrowserController');
  const instance = controller.create({ api: {}, view: {} });
  assert.equal(typeof instance.mount, 'function');
  assert.equal(typeof instance.unmount, 'function');
  assert.equal(typeof instance.load, 'function');
  assert.equal(typeof instance.currentPath, 'function');
});

test('production page loads file browser modules before app', () => {
  const html = read('public/index.html');
  const api = html.indexOf('/features/file-browser/api.js?v=20260907a');
  const view = html.indexOf('/features/file-browser/view.js?v=20260907a');
  const controller = html.indexOf('/features/file-browser/controller.js?v=20260907a');
  const app = html.indexOf('/app.js?v=20260814c');
  assert.ok(api >= 0);
  assert.ok(view > api);
  assert.ok(controller > view);
  assert.ok(app > controller);
});

test('application entry delegates file browser startup', () => {
  const source = read('public/app.js');
  assert.match(source, /FileBrowserController\.create\(/);
  assert.match(source, /fileBrowserController\.mount\(\)/);
  assert.match(source, /fileBrowserController\.load\(/);
});
