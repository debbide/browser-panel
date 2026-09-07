const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { read } = require('./helpers');

function loadApi(fetchJson) {
  const context = vm.createContext({ window: { fetchJson } });
  context.window.window = context.window;
  vm.runInContext(read('public/features/file-browser/api.js'), context);
  return context.window.FileBrowserApi;
}

test('file browser API exposes the tasks filesystem operations', () => {
  const api = loadApi(async () => ({}));
  for (const name of ['list', 'read', 'write', 'remove', 'mkdir', 'createFile', 'upload']) {
    assert.equal(typeof api[name], 'function', `${name} must be exposed`);
  }
});

test('file browser API preserves list, read, write and delete contracts', async () => {
  const calls = [];
  const api = loadApi(async (...args) => { calls.push(args); return { data: {} }; });
  await api.list('sample dir');
  await api.read('sample/file.js');
  await api.write({ path: 'sample/file.js', content: 'ok' });
  await api.remove('sample/file.js');
  assert.deepEqual(calls.map(([path, options]) => [path, options && JSON.parse(JSON.stringify(options))]), [
    ['/api/tasks-fs?path=sample%20dir', undefined],
    ['/api/tasks-fs/read?path=sample%2Ffile.js', undefined],
    ['/api/tasks-fs/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'sample/file.js', content: 'ok' }),
    }],
    ['/api/tasks-fs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'sample/file.js' }),
    }],
  ]);
});

test('file browser API preserves create and upload payloads', async () => {
  const calls = [];
  const api = loadApi(async (...args) => { calls.push(args); return { data: {} }; });
  await api.mkdir({ parent: 'dir', name: 'child' });
  await api.createFile({ parent: 'dir', name: 'script.js', content: '' });
  await api.upload({ parent: 'dir', name: 'a.js', relativePath: 'a.js', encoding: 'base64', content: 'YQ==' });
  assert.deepEqual(calls.map(([path, options]) => [path, JSON.parse(JSON.stringify(options))]), [
    ['/api/tasks-fs/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent: 'dir', name: 'child' }) }],
    ['/api/tasks-fs/create-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent: 'dir', name: 'script.js', content: '' }) }],
    ['/api/tasks-fs/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent: 'dir', name: 'a.js', relativePath: 'a.js', encoding: 'base64', content: 'YQ==' }) }],
  ]);
});
