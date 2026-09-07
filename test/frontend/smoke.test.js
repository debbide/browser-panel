const test = require('node:test');
const assert = require('node:assert/strict');
const { read } = require('./helpers');

test('production page keeps the existing application entry path', () => {
  const html = read('public/index.html');
  assert.match(html, /<script src="\/app\.js\?v=20260814c"><\/script>/);
});

test('boot checks authentication before panel requests', () => {
  const source = read('public/app.js');
  const auth = source.indexOf("fetch('/api/auth/state')");
  const refresh = source.indexOf('refreshAll();', auth);
  assert.ok(auth >= 0);
  assert.ok(refresh > auth);
});

test('authenticated startup request sequence remains stable', () => {
  const source = read('public/app.js');
  const order = [
    'wireAuthUi(state.username);',
    'fileBrowserController.mount();',
    'wireResourceManagers();',
    'refreshAll();',
    'startStatusStream();',
    'loadSchedulerSettings();',
    'loadSuccessHeuristicsSettings();',
    'loadBrowserRuntimeSettings();',
    'settingsController.load();',
    'backupStorageController.load();',
    'fileBrowserController.load(fsCurrentPath);',
  ];
  let cursor = source.indexOf('async function bootPanel()');
  for (const statement of order) {
    const next = source.indexOf(statement, cursor);
    assert.ok(next > cursor, `${statement} must retain startup order`);
    cursor = next;
  }
});
