const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function loadControl() {
  const window = {};
  vm.runInNewContext(read('public/core/proxy-mode-control.js'), { window });
  return window.ProxyModeControl;
}

test('proxy mode control exposes launch value input only for launch mode', () => {
  const control = loadControl();
  const mode = { value: 'launch' };
  const value = { value: ' http://proxy.local ', disabled: true };
  const field = { hidden: true };

  control.update(mode, value, field);
  assert.equal(value.value, ' http://proxy.local ');
  assert.equal(value.disabled, false);
  assert.equal(field.hidden, false);

  mode.value = 'direct';
  control.update(mode, value, field);
  assert.equal(value.value, '');
  assert.equal(value.disabled, true);
  assert.equal(field.hidden, true);
});

test('proxy mode control defaults missing mode to direct and tolerates missing elements', () => {
  const control = loadControl();
  const value = { value: 'stale', disabled: false };
  const field = { hidden: false };

  assert.doesNotThrow(() => control.update(null, value, field));
  assert.equal(value.value, '');
  assert.equal(value.disabled, true);
  assert.equal(field.hidden, true);
  assert.doesNotThrow(() => control.update(null, null, null));
});

test('proxy mode control owns the helper and loads before panel runtime', () => {
  const runtime = read('public/panel-runtime.js');
  const html = read('public/index.html');
  const moduleIndex = html.indexOf('/core/proxy-mode-control.js');
  const runtimeIndex = html.indexOf('/panel-runtime.js');

  assert.doesNotMatch(runtime, /function updateProxyModeUI\s*\(/);
  assert.match(runtime, /ProxyModeControl\.update/);
  assert.ok(moduleIndex >= 0);
  assert.ok(runtimeIndex > moduleIndex);
});
