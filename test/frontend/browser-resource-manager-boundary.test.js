const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function loadApi(fetchJson) {
  const window = { fetchJson };
  vm.runInNewContext(read('public/features/browser-resources/api.js'), { window });
  return window.BrowserResourcesApi;
}

test('resource filesystem API preserves list and mutation request contracts', async () => {
  const calls = [];
  const api = loadApi(async (...args) => {
    calls.push(args);
    return { data: { entries: [] } };
  });

  await api.listResourceEntries('extensions', 'nested folder');
  await api.resourceAction('profiles', 'alpha/file.zip', 'extract', { mode: 'folder', overwrite: false });
  await api.deleteResourceEntry('profiles', 'alpha/file.zip');
  await api.createResourceDirectory('extensions', 'parent', 'child');

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['/api/extensions-fs?path=nested%20folder'],
    ['/api/profiles-fs/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'alpha/file.zip', mode: 'folder', overwrite: false }),
    }],
    ['/api/profiles-fs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'alpha/file.zip' }),
    }],
    ['/api/extensions-fs/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent: 'parent', name: 'child' }),
    }],
  ]);
});

test('resource manager state belongs only to browser-resources controller', () => {
  const runtime = read('public/panel-runtime.js');
  const controller = read('public/features/browser-resources/controller.js');

  assert.doesNotMatch(runtime, /const resourceManagerState\s*=/);
  assert.doesNotMatch(runtime, /function (?:getResourceManager|resourceAction|loadResourceManager)\s*\(/);
  assert.match(controller, /resourceManagerState/);
  assert.match(controller, /function loadResourceManager\s*\(/);
});

test('resource navigation has one controller-owned binding path and static scripts load in order', () => {
  const runtime = read('public/panel-runtime.js');
  const navigation = read('public/core/app-navigation.js');
  const controller = read('public/features/browser-resources/controller.js');
  const html = read('public/index.html');

  assert.equal((runtime.match(/function loadResourceManager\s*\(/g) || []).length, 0);
  assert.equal((runtime.match(/browserResourcesController\.loadResourceManager\(/g) || []).length, 1);
  assert.equal((navigation.match(/loadBrowserResource\(/g) || []).length, 2);
  assert.equal((controller.match(/querySelector\('\.resource-refresh'\)\?\.addEventListener\('click'/g) || []).length, 1);
  assert.equal((controller.match(/querySelector\('\.resource-up'\)\?\.addEventListener\('click'/g) || []).length, 1);
  assert.equal((controller.match(/querySelector\('\.resource-mkdir'\)\?\.addEventListener\('click'/g) || []).length, 1);

  const apiIndex = html.indexOf('/features/browser-resources/api.js');
  const viewIndex = html.indexOf('/features/browser-resources/view.js');
  const controllerIndex = html.indexOf('/features/browser-resources/controller.js');
  const runtimeIndex = html.indexOf('/panel-runtime.js');
  assert.ok(apiIndex < viewIndex && viewIndex < controllerIndex && controllerIndex < runtimeIndex);
});

test('resource manager publishes loading, empty, failure, and escaped breadcrumb rendering', () => {
  const view = read('public/features/browser-resources/view.js');
  assert.match(view, /加载中…/);
  assert.match(view, /空目录/);
  assert.match(view, /加载失败/);
  assert.match(view, /resource-breadcrumb/);
  assert.match(view, /escapeHtml/);
});
