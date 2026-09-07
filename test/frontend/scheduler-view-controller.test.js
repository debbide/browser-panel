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

test('scheduler view exposes stable render, collect, and status boundaries', () => {
  const view = loadModule('public/features/scheduler/view.js', 'SchedulerView');
  assert.equal(typeof view.render, 'function');
  assert.equal(typeof view.collect, 'function');
  assert.equal(typeof view.setStatus, 'function');
});

test('scheduler controller exposes idempotent lifecycle and initial load', () => {
  const controller = loadModule('public/features/scheduler/controller.js', 'SchedulerController');
  assert.equal(typeof controller.create, 'function');
  const instance = controller.create({ api: {}, view: {}, actions: {} });
  assert.equal(typeof instance.mount, 'function');
  assert.equal(typeof instance.unmount, 'function');
  assert.equal(typeof instance.load, 'function');
});

test('production page loads scheduler modules before app', () => {
  const html = read('public/index.html');
  const api = html.indexOf('/features/scheduler/api.js?v=20260907a');
  const view = html.indexOf('/features/scheduler/view.js?v=20260907a');
  const controller = html.indexOf('/features/scheduler/controller.js?v=20260907a');
  const app = html.indexOf('/app.js?v=20260814c');
  assert.ok(api >= 0);
  assert.ok(view > api);
  assert.ok(controller > view);
  assert.ok(app > controller);
});

test('application entry delegates scheduler startup', () => {
  const source = read('public/panel-runtime.js');
  assert.match(source, /SchedulerController\.create\(/);
  assert.match(source, /schedulerController\.mount\(\)/);
  assert.match(source, /schedulerController\.load\(\)/);
});
