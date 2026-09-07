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

test('settings view exposes deterministic form payload and rendering helpers', () => {
  const view = loadModule('public/features/settings/view.js', 'SettingsView');
  assert.equal(typeof view.renderTelegram, 'function');
  assert.equal(typeof view.collectTelegram, 'function');
  assert.equal(typeof view.renderVisionChannels, 'function');
  assert.equal(typeof view.collectVisionChannels, 'function');
  assert.equal(typeof view.renderGlobalEnv, 'function');
  assert.equal(typeof view.collectGlobalEnv, 'function');
});

test('settings controller exposes idempotent lifecycle and initial load', () => {
  const controller = loadModule('public/features/settings/controller.js', 'SettingsController');
  assert.equal(typeof controller.create, 'function');
  const instance = controller.create({ api: {}, view: {} });
  assert.equal(typeof instance.mount, 'function');
  assert.equal(typeof instance.unmount, 'function');
  assert.equal(typeof instance.load, 'function');
});

test('production page loads settings view and controller before app', () => {
  const html = read('public/index.html');
  const api = html.indexOf('/features/settings/api.js?v=20260907a');
  const view = html.indexOf('/features/settings/view.js?v=20260907a');
  const controller = html.indexOf('/features/settings/controller.js?v=20260907a');
  const app = html.indexOf('/app.js?v=20260814c');
  assert.ok(api >= 0);
  assert.ok(view > api);
  assert.ok(controller > view);
  assert.ok(app > controller);
});

test('application entry delegates settings startup to the controller', () => {
  const source = read('public/panel-runtime.js');
  assert.match(source, /SettingsController\.create\(/);
  assert.match(source, /settingsController\.mount\(\)/);
  assert.match(source, /settingsController\.load\(\)/);
});
