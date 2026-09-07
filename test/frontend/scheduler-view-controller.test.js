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

test('scheduler DOM, visible text, state, and binding contracts are frozen before extraction', () => {
  const html = read('public/index.html');
  const runtime = read('public/panel-runtime.js');
  for (const id of ['scheduler-form', 'scheduler-status-text', 'scheduler-allow-parallel', 'scheduler-save-btn']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(runtime, /浏览器任务并行/);
  assert.match(runtime, /浏览器任务串行（默认）/);
  assert.match(runtime, /当前运行：#/);
  assert.match(runtime, /当前空闲/);
  assert.match(runtime, /状态：加载失败/);
  assert.match(runtime, /调度设置已保存/);
  assert.match(runtime, /保存调度设置失败/);
  assert.equal((runtime.match(/schedulerForm\.addEventListener\('submit'/g) || []).length, 1);
});

test('scheduler load and refresh timing preserve save then reload behavior', () => {
  const runtime = read('public/panel-runtime.js');
  assert.match(runtime, /async function saveSchedulerSettings\(\)[\s\S]*await fetchJson\('\/api\/settings\/scheduler'[\s\S]*await loadSchedulerSettings\(\)/);
  assert.match(runtime, /schedulerSaveBtn\.disabled = true/);
  assert.match(runtime, /schedulerSaveBtn\.disabled = false/);
  assert.match(runtime, /schedulerSaveBtn\.innerHTML = '<i data-lucide="save" class="icon-sm"><\/i> 保存调度设置'/);
});
