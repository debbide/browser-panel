const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { read } = require('./helpers');

function loadModule(window = {}) {
  const context = vm.createContext({ Date, Number, String, window });
  context.window.window = context.window;
  vm.runInContext(read('public/core/fs-presentation.js'), context);
  return context.window.FsPresentation;
}

test('filesystem presentation preserves byte formatting', () => {
  const presentation = loadModule();
  assert.equal(presentation.formatBytes(0), '0 B');
  assert.equal(presentation.formatBytes(1023), '1023 B');
  assert.equal(presentation.formatBytes(1536), '1.5 KB');
  assert.equal(presentation.formatBytes(1024 * 1024), '1.0 MB');
});

test('filesystem presentation preserves mtime formatting', () => {
  const presentation = loadModule();
  assert.equal(presentation.formatFsMtime(''), '—');
  assert.equal(presentation.formatFsMtime('not-a-date-value'), 'not-a-date-value');
  assert.equal(presentation.formatFsMtime('2026-09-07T13:45:00'), '2026-09-07 13:45');
});

test('filesystem presentation exposes the shared name prompt boundary', () => {
  const presentation = loadModule();
  assert.equal(typeof presentation.promptFsName, 'function');
});

test('production loads filesystem presentation before feature callers', () => {
  const html = read('public/index.html');
  const shared = html.indexOf('/core/fs-presentation.js?v=20260907a');
  const fileBrowser = html.indexOf('/features/file-browser/view.js?v=20260907a');
  const browserResources = html.indexOf('/features/browser-resources/view.js?v=20260907a');
  const runtime = html.indexOf('/panel-runtime.js?v=20260907a');
  assert.ok(shared >= 0);
  assert.ok(fileBrowser > shared);
  assert.ok(browserResources > shared);
  assert.ok(runtime > shared);
});

test('filesystem presentation helpers have one implementation boundary', () => {
  const files = [
    'public/core/fs-presentation.js',
    'public/features/file-browser/view.js',
    'public/features/browser-resources/view.js',
    'public/panel-runtime.js',
  ];
  const source = files.map(read).join('\n');
  assert.equal((source.match(/function formatFsMtime\(/g) || []).length, 1);
  assert.equal((source.match(/function promptFsName\(/g) || []).length, 1);
  assert.equal((source.match(/function formatBytes\(/g) || []).length, 1);
});
