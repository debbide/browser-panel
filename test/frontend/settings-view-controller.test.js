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
  const source = `${read('public/features/settings/view.js')}\n${read('public/features/settings/controller.js')}\n${read('public/panel-runtime.js')}`;
  assert.match(source, /SettingsController\.create\(/);
  assert.match(source, /settingsController\.mount\(\)/);
  assert.match(source, /settingsController\.load\(\)/);
});

test('settings controller owns lifecycle without duplicate event binding', async () => {
  const controller = loadModule('public/features/settings/controller.js', 'SettingsController');
  const calls = [];
  const instance = controller.create({
    api: {},
    view: {},
    actions: {
      mount() { calls.push('mount'); },
      unmount() { calls.push('unmount'); },
      load() { calls.push('load'); },
    },
  });
  instance.mount();
  instance.mount();
  await instance.load();
  instance.unmount();
  instance.unmount();
  assert.deepEqual(calls, ['mount', 'load', 'unmount']);
});

test('settings DOM selectors and visible status text remain stable', () => {
  const html = read('public/index.html');
  for (const id of [
    'tg-status-text',
    'tg-bot-token',
    'tg-chat-id',
    'tg-proxy',
    'tg-webhook-url',
    'global-env-editor',
    'global-env-save',
    'vision-channels-list',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  const source = `${read('public/features/settings/view.js')}\n${read('public/features/settings/controller.js')}\n${read('public/panel-runtime.js')}`;
  assert.match(source, /状态：未配置/);
  assert.match(source, /状态：已配置，Webhook 已注册/);
  assert.match(source, /状态：加载失败/);
  assert.match(source, /全局变量已保存/);
});

test('settings static scripts preserve api view controller runtime app order', () => {
  const html = read('public/index.html');
  const paths = [
    '/features/settings/api.js?v=20260907a',
    '/features/settings/view.js?v=20260907a',
    '/features/settings/controller.js?v=20260907a',
    '/panel-runtime.js?v=20260907a',
    '/app.js?v=20260814c',
  ];
  const positions = paths.map((path) => html.indexOf(path));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
});

test('vision settings freeze card, dropdown and modal DOM contracts before extraction', () => {
  const source = `${read('public/features/settings/controller.js')}\n${read('public/features/vision-settings/ui.js')}\n${read('public/panel-runtime.js')}`;
  for (const selector of [
    'vision-channel-card',
    'vision-channel-row',
    'vision-channel-badge',
    'vision-ch-base',
    'vision-ch-key',
    'vision-ch-model',
    'vision-ch-model-toggle',
    'vision-channel-test',
    'vision-channel-make-primary',
    'vision-channel-remove',
    'vision-model-dropdown',
    'vision-test-modal',
  ]) {
    assert.match(source, new RegExp(selector));
  }
  assert.match(source, /data-vision-channel/);
  assert.match(source, /data-close-vision-test/);
  assert.match(source, /至少保留一个通道/);
  assert.match(source, /请至少配置一个视觉通道/);
  assert.match(source, /需要填写 Base URL 和 Model/);
  assert.match(source, /测试完成 · 可用/);
  assert.match(source, /测试完成 · 存在问题/);
  assert.match(source, /Vision 测试失败/);
});

test('vision settings freeze selection state and event binding contracts before extraction', () => {
  const runtime = read('public/panel-runtime.js');
  const controller = read('public/features/settings/controller.js');
  const visionUi = read('public/features/vision-settings/ui.js');
  const source = `${controller}\n${visionUi}\n${runtime}`;
  assert.match(source, /const visionModelCache = new Map\(\)/);
  assert.match(source, /document\.addEventListener\('mousedown', visionDropdownOutsideHandler, true\)/);
  assert.match(source, /document\.addEventListener\('keydown', visionDropdownKeyHandler, true\)/);
  assert.equal((runtime.match(/visionForm\.addEventListener\('submit'/g) || []).length, 0);
  assert.equal((runtime.match(/visionTestBtn\.addEventListener\('click'/g) || []).length, 0);
  assert.equal((controller.match(/vision\.form\.addEventListener\('submit', saveVision\)/g) || []).length, 1);
  assert.equal((controller.match(/vision\.testButton\.addEventListener\('click', testVision\)/g) || []).length, 1);
  assert.equal((controller.match(/vision\.form\.removeEventListener\('submit', saveVision\)/g) || []).length, 1);
  assert.equal((controller.match(/vision\.testButton\.removeEventListener\('click', testVision\)/g) || []).length, 1);
  assert.match(source, /visionChannelsList\.insertBefore\(card, first\)/);
  assert.match(source, /runTest\(\{ testImage: true \}\)/);
  assert.match(source, /mask\.addEventListener\('click', close\)/);
});
