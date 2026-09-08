const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { read } = require('./helpers');

function loadManagedEnv() {
  const context = vm.createContext({ window: {} });
  context.window.window = context.window;
  vm.runInContext(read('public/features/environment/managed-env.js'), context);
  return context.window.ManagedEnvironment;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('managed environment matching and filtering are case insensitive', () => {
  const managed = loadManagedEnv();
  assert.equal(managed.isManagedEnvKey(' browser_locale '), true);
  assert.equal(managed.isManagedEnvKey('CUSTOM_KEY'), false);
  assert.deepEqual(plain(managed.filterManagedEnvRows([
    { name: 'BROWSER_TIMEZONE', value: 'UTC' },
    { name: 'custom_key', value: 'kept' },
  ])), [{ name: 'custom_key', value: 'kept' }]);
  assert.deepEqual(plain(managed.filterManagedEnvObject({
    browser_proxy: 'hidden',
    CUSTOM_KEY: 'kept',
  })), { CUSTOM_KEY: 'kept' });
});

test('managed environment lookup trims values without mutating inputs', () => {
  const managed = loadManagedEnv();
  const rows = [{ name: ' browser_proxy ', value: ' http://proxy ' }];
  const params = { browser_runtime_stack: ' chrome ' };
  assert.equal(managed.findManagedEnvValue(rows, 'BROWSER_PROXY'), 'http://proxy');
  assert.equal(managed.findManagedParamValue(params, 'BROWSER_RUNTIME_STACK'), 'chrome');
  assert.deepEqual(rows, [{ name: ' browser_proxy ', value: ' http://proxy ' }]);
  assert.deepEqual(params, { browser_runtime_stack: ' chrome ' });
});

test('managed environment deletion handles map and object keys case insensitively', () => {
  const managed = loadManagedEnv();
  const map = new Map([['browser_proxy', 'drop'], ['CUSTOM_KEY', 'keep']]);
  const object = { Browser_Timezone: 'drop', CUSTOM_KEY: 'keep' };
  managed.deleteManagedMapKeys(map, ['BROWSER_PROXY']);
  managed.deleteManagedObjectKeys(object, ['BROWSER_TIMEZONE']);
  assert.deepEqual([...map], [['CUSTOM_KEY', 'keep']]);
  assert.deepEqual(object, { CUSTOM_KEY: 'keep' });
});

test('managed environment module owns the helpers and loads before consumers', () => {
  const runtime = read('public/panel-runtime.js');
  const html = read('public/index.html');
  const moduleIndex = html.indexOf('/features/environment/managed-env.js');
  const taskControllerIndex = html.indexOf('/features/tasks/editor-controller.js');
  const browserControllerIndex = html.indexOf('/features/browser-resources/controller.js');
  const runtimeIndex = html.indexOf('/panel-runtime.js');

  assert.doesNotMatch(runtime, /function isManagedEnvKey\(/);
  assert.doesNotMatch(runtime, /function filterManagedEnvRows\(/);
  assert.doesNotMatch(runtime, /function deleteManagedObjectKeys\(/);
  assert.ok(moduleIndex >= 0);
  assert.ok(taskControllerIndex > moduleIndex);
  assert.ok(browserControllerIndex > moduleIndex);
  assert.ok(runtimeIndex > moduleIndex);
});
