const test = require('node:test');
const assert = require('node:assert/strict');
const { read } = require('./helpers');

test('environment editor has one focused implementation owner', () => {
  const editor = read('public/features/environment/editor.js');
  const runtime = read('public/panel-runtime.js');

  assert.match(editor, /function createEnvEditor\(/);
  assert.match(editor, /function parseEnvText\(/);
  assert.match(editor, /function looksLikeSecretName\(/);
  assert.match(editor, /global\.EnvironmentEditor =/);
  assert.doesNotMatch(runtime, /function createEnvEditor\(/);
  assert.doesNotMatch(runtime, /function parseEnvText\(/);
  assert.doesNotMatch(runtime, /function looksLikeSecretName\(/);
});

test('environment editor loads before browser resources and panel runtime', () => {
  const html = read('public/index.html');
  const editorIndex = html.indexOf('/features/environment/editor.js');
  const browserResourcesIndex = html.indexOf('/features/browser-resources/controller.js');
  const runtimeIndex = html.indexOf('/panel-runtime.js');

  assert.ok(editorIndex >= 0);
  assert.ok(browserResourcesIndex > editorIndex);
  assert.ok(runtimeIndex > editorIndex);
});

test('environment editor preserves secret-safe collection and text import contracts', () => {
  const editor = read('public/features/environment/editor.js');

  assert.match(editor, /has_value: hasValue/);
  assert.match(editor, /valueMasked: e\.valueMasked \|\| ''/);
  assert.match(editor, /if \(!parsed\.length\) throw new Error\('未解析到任何 KEY=value'\)/);
  assert.match(editor, /setRows/);
  assert.match(editor, /addRow/);
  assert.match(editor, /collect/);
  assert.match(editor, /exportText/);
  assert.match(editor, /importText/);
});
