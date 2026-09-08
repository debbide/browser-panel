const test = require('node:test');
const assert = require('node:assert/strict');
const { read } = require('./helpers');

test('production page loads panel runtime before the application entry', () => {
  const html = read('public/index.html');
  const runtime = html.indexOf('/panel-runtime.js?v=20260907a');
  const entry = html.indexOf('/app.js?v=20260814c');

  assert.ok(runtime >= 0);
  assert.ok(entry >= 0);
  assert.ok(runtime < entry);
});

test('application entry remains a thin startup composition', () => {
  const source = read('public/app.js');
  const lines = source.trim().split('\n');

  assert.ok(lines.length <= 40, `expected thin entry, received ${lines.length} lines`);
  assert.match(source, /PanelRuntime\.start\(\)/);
  assert.doesNotMatch(source, /fetchJson\(/);
  assert.doesNotMatch(source, /innerHTML/);
  assert.doesNotMatch(source, /addEventListener\(/);
});

test('panel runtime exposes explicit startup without starting on load', () => {
  const source = read('public/panel-runtime.js');

  assert.match(source, /window\.PanelRuntime\s*=\s*\{/);
  assert.match(source, /start:\s*bootPanel/);
  assert.doesNotMatch(source, /\nbootPanel\(\);\s*$/);
});

test('UI feedback owns dialogs and loads before panel runtime', () => {
  const html = read('public/index.html');
  const runtime = read('public/panel-runtime.js');
  const feedback = read('public/core/ui-feedback.js');
  const feedbackIndex = html.indexOf('/core/ui-feedback.js?v=20260908a');
  const runtimeIndex = html.indexOf('/panel-runtime.js?v=20260907a');

  assert.ok(feedbackIndex >= 0);
  assert.ok(feedbackIndex < runtimeIndex);
  assert.match(feedback, /global\.UiFeedback\s*=\s*\{/);
  assert.match(feedback, /function dialogPassphrase\(/);
  assert.match(feedback, /function dialogPassphraseOnce\(/);
  assert.doesNotMatch(runtime, /function dialogPassphrase\(/);
  assert.match(runtime, /const \{ dialogPassphrase, dialogPassphraseOnce \} = UiFeedback;/);
});
