const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { read } = require('./helpers');

function loadPresetCustomControl() {
  const dom = new JSDOM(`
    <select id="preset">
      <option value=""></option>
      <option value="known">Known</option>
      <option value="__custom__">Custom</option>
    </select>
    <input id="custom">
  `);
  const context = vm.createContext({ window: dom.window, document: dom.window.document });
  context.window.window = context.window;
  vm.runInContext(read('public/core/preset-custom-control.js'), context);
  return {
    dom,
    control: context.window.PresetCustomControl,
    select: dom.window.document.querySelector('#preset'),
    input: dom.window.document.querySelector('#custom'),
  };
}

test('preset custom control initializes known, custom, and empty values', () => {
  const { control, select, input } = loadPresetCustomControl();

  control.setup(select, input, ' known ');
  assert.equal(select.value, 'known');
  assert.equal(input.value, '');
  assert.equal(input.hidden, true);
  assert.equal(input.disabled, true);

  control.setup(select, input, ' other ');
  assert.equal(select.value, '__custom__');
  assert.equal(input.value, 'other');
  assert.equal(input.hidden, false);
  assert.equal(input.disabled, false);

  control.setup(select, input, '');
  assert.equal(select.value, '');
  assert.equal(input.value, '');
});

test('preset custom control binds once and reports select and input changes', () => {
  const { dom, control, select, input } = loadPresetCustomControl();
  let firstChanges = 0;
  let latestChanges = 0;

  control.setup(select, input, '', () => { firstChanges += 1; });
  control.setup(select, input, '', () => { latestChanges += 1; });
  select.value = '__custom__';
  select.dispatchEvent(new dom.window.Event('change'));
  input.value = ' custom ';
  input.dispatchEvent(new dom.window.Event('input'));

  assert.equal(firstChanges, 0);
  assert.equal(latestChanges, 2);
  assert.equal(input.hidden, false);
  assert.equal(input.disabled, false);
  assert.equal(control.getValue(select, input), 'custom');

  select.value = 'known';
  select.dispatchEvent(new dom.window.Event('change'));
  assert.equal(input.value, '');
  assert.equal(control.getValue(select, input), 'known');
});

test('preset custom control safely handles missing elements', () => {
  const { control } = loadPresetCustomControl();
  assert.doesNotThrow(() => control.setup(null, null, 'value'));
  assert.equal(control.getValue(null, null), '');
});

test('preset custom control module owns helpers and loads before consumers', () => {
  const runtime = read('public/panel-runtime.js');
  const html = read('public/index.html');
  const moduleIndex = html.indexOf('/core/preset-custom-control.js');
  const browserControllerIndex = html.indexOf('/features/browser-resources/controller.js');
  const runtimeIndex = html.indexOf('/panel-runtime.js');

  assert.doesNotMatch(runtime, /function setupPresetCustomControl\(/);
  assert.doesNotMatch(runtime, /function getPresetCustomValue\(/);
  assert.ok(moduleIndex >= 0);
  assert.ok(browserControllerIndex > moduleIndex);
  assert.ok(runtimeIndex > moduleIndex);
});
