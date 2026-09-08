const test = require('node:test');
const assert = require('node:assert/strict');
const { read } = require('./helpers');

test('auth UI owns account dialogs and wiring before panel runtime', () => {
  const html = read('public/index.html');
  const runtime = read('public/panel-runtime.js');
  const authUi = read('public/features/auth/ui.js');
  const authIndex = html.indexOf('/features/auth/ui.js?v=20260908a');
  const runtimeIndex = html.indexOf('/panel-runtime.js?v=20260907a');

  assert.ok(authIndex >= 0);
  assert.ok(authIndex < runtimeIndex);
  assert.match(authUi, /global\.AuthUi\s*=\s*\{ create \}/);
  assert.match(authUi, /function openChangePasswordDialog\(/);
  assert.match(authUi, /function open2faDialog\(/);
  assert.match(authUi, /function wire\(username\)/);
  assert.doesNotMatch(runtime, /function openChangePasswordDialog\(/);
  assert.doesNotMatch(runtime, /function open2faDialog\(/);
  assert.doesNotMatch(runtime, /function wireAuthUi\(/);
  assert.match(runtime, /const authUi = AuthUi\.create\(/);
  assert.match(runtime, /authUi\.wire\(state\.username\);/);
});
