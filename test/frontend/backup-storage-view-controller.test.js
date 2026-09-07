const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { read } = require('./helpers');

function loadModule(path, name, window = {}) {
  const context = vm.createContext({ window });
  context.window.window = context.window;
  vm.runInContext(read(path), context);
  return context.window[name];
}

test('backup and storage view exposes stable formatting and rendering boundaries', () => {
  const view = loadModule('public/features/backup-storage/view.js', 'BackupStorageView');
  assert.equal(typeof view.formatCloudBackupTime, 'function');
  assert.equal(typeof view.renderCloudBackupList, 'function');
  assert.equal(typeof view.renderCleanupPreview, 'function');
  assert.equal(typeof view.updateSelection, 'function');
});

test('backup and storage controller exposes idempotent lifecycle and initial load', () => {
  const controller = loadModule('public/features/backup-storage/controller.js', 'BackupStorageController');
  assert.equal(typeof controller.create, 'function');
  const instance = controller.create({ api: {}, view: {}, actions: {} });
  assert.equal(typeof instance.mount, 'function');
  assert.equal(typeof instance.unmount, 'function');
  assert.equal(typeof instance.load, 'function');
});

test('production page loads backup and storage modules before app', () => {
  const html = read('public/index.html');
  const api = html.indexOf('/features/backup-storage/api.js?v=20260907a');
  const view = html.indexOf('/features/backup-storage/view.js?v=20260907a');
  const controller = html.indexOf('/features/backup-storage/controller.js?v=20260907a');
  const app = html.indexOf('/app.js?v=20260814c');
  assert.ok(api >= 0);
  assert.ok(view > api);
  assert.ok(controller > view);
  assert.ok(app > controller);
});

test('application entry delegates backup and storage startup', () => {
  const source = read('public/panel-runtime.js');
  assert.match(source, /BackupStorageController\.create\(/);
  assert.match(source, /backupStorageController\.mount\(\)/);
  assert.match(source, /backupStorageController\.load\(\)/);
});
