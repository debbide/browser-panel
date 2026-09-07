const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { read } = require('./helpers');

function loadApi(fetchJson, fetch = async () => ({ ok: true })) {
  const context = vm.createContext({ window: { fetchJson, fetch } });
  context.window.window = context.window;
  vm.runInContext(read('public/features/backup-storage/api.js'), context);
  return context.window.BackupStorageApi;
}

test('backup and storage API exposes local, cloud, and cleanup operations', () => {
  const api = loadApi(async () => ({}));
  for (const name of [
    'scanAssets', 'saveAssets', 'previewImport', 'importBackup',
    'loadCloudSettings', 'saveCloudSettings', 'clearCloudSettings',
    'testCloudConnection', 'runCloudBackup', 'listCloudBackups',
    'previewCloudBackup', 'restoreCloudBackup', 'previewCleanup', 'runCleanup',
  ]) assert.equal(typeof api[name], 'function', name);
});

test('cloud backup API preserves paths, methods, and JSON payloads', async () => {
  const calls = [];
  const api = loadApi(async (...args) => { calls.push(args); return { data: {} }; });
  const settings = { enabled: true, bucket: 'panel' };
  await api.loadCloudSettings();
  await api.saveCloudSettings(settings);
  await api.clearCloudSettings();
  await api.testCloudConnection();
  await api.runCloudBackup({ label: 'manual' });
  await api.listCloudBackups();
  assert.deepEqual(calls.map(([path, options]) => [path, options && JSON.parse(JSON.stringify(options))]), [
    ['/api/cloud-backup/settings', undefined],
    ['/api/cloud-backup/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) }],
    ['/api/cloud-backup/settings', { method: 'DELETE' }],
    ['/api/cloud-backup/test', { method: 'POST' }],
    ['/api/cloud-backup/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'manual' }) }],
    ['/api/cloud-backup/list', undefined],
  ]);
});

test('backup restore and storage cleanup preserve request contracts', async () => {
  const calls = [];
  const api = loadApi(async (...args) => { calls.push(args); return { data: {} }; });
  await api.previewCloudBackup({ key: 'snap.json', passphrase: 'secret' });
  await api.restoreCloudBackup({ key: 'snap.json', mode: 'merge' });
  await api.previewCleanup('include=logs&days=7');
  await api.runCleanup({ include: ['logs'], days: 7 });
  assert.deepEqual(calls.map(([path, options]) => [path, options && JSON.parse(JSON.stringify(options))]), [
    ['/api/cloud-backup/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'snap.json', passphrase: 'secret' }) }],
    ['/api/cloud-backup/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'snap.json', mode: 'merge' }) }],
    ['/api/storage/cleanup/preview?include=logs&days=7', undefined],
    ['/api/storage/cleanup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ include: ['logs'], days: 7 }) }],
  ]);
});
