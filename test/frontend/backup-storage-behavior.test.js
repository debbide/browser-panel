const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { read } = require('./helpers');

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createHarness({ responses = [] } = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="backup-assets-mask" hidden></div><div id="backup-assets-modal" hidden></div>
    <div id="backup-import-mask" hidden></div><div id="backup-import-modal" hidden></div>
    <div id="cloud-backup-list"></div><div id="cloud-restore-mask" hidden></div><div id="cloud-restore-modal" hidden></div>
    <input id="storage-cleanup-days" value="30"><div id="storage-cleanup-categories">
      <input type="checkbox" value="screenshots" checked><input type="checkbox" value="logs" checked>
    </div>
    <button id="storage-cleanup-preview-btn"></button><button id="storage-cleanup-run-btn" disabled></button>
    <div id="storage-cleanup-status"></div><div id="storage-cleanup-result"></div>
  </body>`, { url: 'https://panel.test/' });
  const calls = [];
  const toasts = [];
  const confirmations = [];
  const order = [];
  let responseIndex = 0;
  const fetchJson = async (path, options) => {
    calls.push([path, options && JSON.parse(JSON.stringify(options))]);
    order.push(`fetch:${path}`);
    const response = responses[responseIndex++];
    if (response instanceof Error) throw response;
    return response || { data: {} };
  };
  const elements = {
    backupImportModal: dom.window.document.querySelector('#backup-import-modal'),
    backupImportMask: dom.window.document.querySelector('#backup-import-mask'),
    cloudBackupList: dom.window.document.querySelector('#cloud-backup-list'),
    cloudRestoreModal: dom.window.document.querySelector('#cloud-restore-modal'),
    cloudRestoreMask: dom.window.document.querySelector('#cloud-restore-mask'),
    storageCleanupDays: dom.window.document.querySelector('#storage-cleanup-days'),
    storageCleanupCategories: dom.window.document.querySelector('#storage-cleanup-categories'),
    storageCleanupPreviewBtn: dom.window.document.querySelector('#storage-cleanup-preview-btn'),
    storageCleanupRunBtn: dom.window.document.querySelector('#storage-cleanup-run-btn'),
    storageCleanupStatus: dom.window.document.querySelector('#storage-cleanup-status'),
    storageCleanupResult: dom.window.document.querySelector('#storage-cleanup-result'),
  };
  const globals = {
    window: dom.window,
    document: dom.window.document,
    fetchJson,
    toast: (message, type) => { toasts.push([message, type]); order.push(`toast:${message}`); },
    refreshAll: async () => { order.push('refreshAll'); },
    dialogConfirm: (message, action) => { confirmations.push(message); return action(); },
    escapeHtml: (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    formatBytes: (value) => `${value} B`,
    formatDateTime: (value) => `time:${value}`,
    URLSearchParams, JSON, Date, String, Number, Error,
    ...elements,
    pendingBackupPayload: null,
    pendingCloudRestore: null,
    storageCleanupPreview: null,
  };
  dom.window.lucide = { createIcons() {} };
  dom.window.confirm = (message) => { confirmations.push(message); return true; };
  const context = vm.createContext(globals);
  context.window.window = context.window;
  context.window.fetchJson = fetchJson;
  vm.runInContext(read('public/features/backup-storage/api.js'), context);
  vm.runInContext(read('public/features/backup-storage/view.js'), context);
  vm.runInContext(read('public/features/backup-storage/controller.js'), context);
  const actions = {
    toast: (message, type) => context.toast(message, type),
    refreshAll: () => context.refreshAll(),
    loadTasks: () => context.loadTasks?.(),
    downloadBackup: (ids, passphrase) => context.downloadBackup?.(ids, passphrase),
    dialogConfirm: (message, action) => context.dialogConfirm(message, action),
    escapeHtml: context.escapeHtml,
    formatBytes: context.formatBytes,
    createIcons() {},
  };
  const controller = context.window.BackupStorageController.create({
    api: context.window.BackupStorageApi,
    view: context.window.BackupStorageView,
    elements: {
      backupAssetsMask: dom.window.document.querySelector('#backup-assets-mask'),
      backupAssetsModal: dom.window.document.querySelector('#backup-assets-modal'),
      ...elements,
    },
    actions,
  });
  return { ...controller, controller, context, dom, calls, toasts, confirmations, order, elements };
}

test('backup export scans assets, confirms selection, saves exact payload, then refreshes tasks before download', async () => {
  const harness = createHarness({ responses: [
    { data: [{ id: 7, name: 'job', script_path: 'tasks/job.js', paths: ['tasks/lib'], declared: ['tasks/lib'] }] },
    { data: {} },
  ] });
  harness.context.loadTasks = async () => { harness.order.push('loadTasks'); };
  harness.context.downloadBackup = async (ids, passphrase) => { harness.order.push(`download:${ids.join(',')}:${passphrase}`); };
  await harness.startBackupExport([7], 'secret');
  assert.deepEqual(harness.calls[0], ['/api/backup/scan-assets', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task_ids: [7] }),
  }]);
  const modal = harness.dom.window.document.querySelector('#backup-assets-modal');
  const mask = harness.dom.window.document.querySelector('#backup-assets-mask');
  assert.equal(modal.hidden, false);
  assert.equal(mask.hidden, false);
  assert.match(modal.textContent, /勾选的目录会跟主脚本一起打包/);
  modal.querySelector('[data-assets-confirm]').click();
  await flush();
  assert.deepEqual(harness.calls[1], ['/api/backup/save-assets', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tasks: [{ id: 7, paths: ['tasks/lib'] }] }),
  }]);
  assert.equal(modal.hidden, true);
  assert.equal(mask.hidden, true);
  assert.ok(harness.order.indexOf('loadTasks') < harness.order.indexOf('download:7:secret'));
});

test('backup export scan failure warns and falls back directly to download', async () => {
  const harness = createHarness({ responses: [new Error('scan down')] });
  harness.context.downloadBackup = async (ids, passphrase) => { harness.order.push(`download:${ids.join(',')}:${passphrase}`); };
  await harness.startBackupExport([9], null);
  assert.deepEqual(harness.toasts, [['依赖扫描失败：scan down，按已声明的模块导出', 'warn']]);
  assert.deepEqual(harness.order.slice(-1), ['download:9:null']);
});

test('backup import preflight renders modal and confirmation preserves payload and refresh order', async () => {
  const plan = { tasks: [{ name: '<task>', action: 'rename' }], scripts: [{ path: 'a.js', action: 'skip' }], profiles: [], warnings: ['注意'], names_only: true };
  const harness = createHarness({ responses: [{ data: plan }, { data: { created: [1, 2] } }] });
  await harness.previewBackupPayload({ version: 1 }, 'secret');
  const modal = harness.elements.backupImportModal;
  assert.deepEqual(harness.calls[0], ['/api/backup/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backup: { version: 1 }, passphrase: 'secret' }) }]);
  assert.equal(modal.hidden, false);
  assert.equal(harness.elements.backupImportMask.hidden, false);
  assert.ok(modal.classList.contains('open'));
  assert.match(modal.textContent, /恢复任务备份/);
  assert.match(modal.textContent, /此备份只包含变量名/);
  modal.querySelector('#backup-task-strategy').value = 'overwrite';
  modal.querySelector('#backup-script-strategy').value = 'rename';
  modal.querySelector('[data-backup-confirm]').click();
  await flush();
  assert.deepEqual(harness.calls[1], ['/api/backup/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backup: { version: 1 }, passphrase: 'secret', task_strategy: 'overwrite', script_strategy: 'rename' }) }]);
  assert.equal(modal.hidden, true);
  assert.equal(harness.elements.backupImportMask.hidden, true);
  assert.deepEqual(harness.toasts, [['备份已导入：新增 2 个任务', 'success']]);
  assert.ok(harness.order.indexOf('toast:备份已导入：新增 2 个任务') < harness.order.indexOf('refreshAll'));
});

test('backup import failure keeps modal open and re-enables confirmation', async () => {
  const harness = createHarness({ responses: [{ data: { tasks: [], scripts: [], profiles: [] } }, new Error('broken import')] });
  await harness.previewBackupPayload({ version: 1 });
  const button = harness.elements.backupImportModal.querySelector('[data-backup-confirm]');
  button.click();
  await flush();
  assert.equal(button.disabled, false);
  assert.equal(harness.elements.backupImportModal.hidden, false);
  assert.deepEqual(harness.toasts, [['broken import', 'error']]);
  assert.equal(harness.order.includes('refreshAll'), false);
});

test('cloud backup listing renders rows and restore requires preview confirmation', async () => {
  const harness = createHarness({ responses: [
    { data: [{ key: 'daily/<x>.json', name: 'daily/<x>.json', size: 12, lastModified: '2026-01-02T03:04:05Z' }] },
    { data: { name: 'daily/<x>.json', manifest: { counts: { tasks: 1, scripts: 2, profiles: 0, users: 0, envEntries: 0 }, includes: [] } } },
    { data: { created: [1] } },
  ] });
  await harness.loadCloudBackupList();
  assert.deepEqual(harness.calls[0], ['/api/cloud-backup/list', undefined]);
  const list = harness.elements.cloudBackupList;
  assert.match(list.textContent, /daily\/<x>\.json/);
  assert.match(list.textContent, /12 B/);
  assert.equal(list.innerHTML.includes('<x>'), false);
  await harness.previewCloudBackup('daily/<x>.json');
  assert.match(harness.elements.cloudRestoreModal.textContent, /1 个任务、2 个脚本/);
  assert.deepEqual(harness.calls[1], ['/api/cloud-backup/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'daily/<x>.json' }) }]);
  assert.equal(harness.elements.cloudRestoreModal.hidden, false);
  assert.equal(harness.elements.cloudRestoreMask.hidden, false);
  harness.elements.cloudRestoreModal.querySelector('[data-cloud-restore-confirm]').click();
  await flush();
  assert.equal(harness.confirmations.length, 1);
  assert.equal(harness.confirmations[0], '确认还原该快照？当前任务与配置将被覆盖（原数据保留在 pre-restore 目录），面板可能自动重启。');
  assert.deepEqual(harness.calls[2], ['/api/cloud-backup/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'daily/<x>.json' }) }]);
  assert.deepEqual(harness.toasts, [['还原完成，请稍候面板重启', 'success']]);
  assert.equal(harness.order.includes('refreshAll'), false);
  assert.equal(harness.elements.cloudRestoreModal.hidden, true);
});

test('cloud listing failure renders visible error without throwing', async () => {
  const harness = createHarness({ responses: [new Error('cloud offline')] });
  await harness.loadCloudBackupList();
  assert.match(harness.elements.cloudBackupList.textContent, /cloud offline/);
});

test('storage cleanup preview preserves exact query and visible state', async () => {
  const harness = createHarness({ responses: [{ data: { count: 3, bytes: 40, runRows: 2, categories: [] } }] });
  await harness.previewStorageCleanup();
  assert.deepEqual(harness.calls[0], ['/api/storage/cleanup/preview?retentionDays=30&categories=screenshots%2Clogs', undefined]);
  assert.equal(harness.elements.storageCleanupStatus.textContent, '预计释放 40 B');
  assert.equal(harness.elements.storageCleanupRunBtn.disabled, false);
});

test('storage cleanup execution confirms exact preview, posts payload, reports result, and refreshes afterward', async () => {
  const harness = createHarness({ responses: [
    { data: { count: 3, bytes: 40, runRows: 2, categories: [] } },
    { data: { count: 3, bytes: 40, runRows: 2, failures: [] } },
  ] });
  harness.controller.mount();
  await harness.previewStorageCleanup();
  harness.elements.storageCleanupRunBtn.click();
  await flush();
  assert.equal(harness.confirmations[0], '确认清理 3 项（约 40 B）及 2 条旧运行记录？此操作不可撤销。');
  assert.deepEqual(harness.calls[1], ['/api/storage/cleanup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ retentionDays: 30, categories: ['screenshots', 'logs'] }),
  }]);
  assert.deepEqual(harness.toasts, [['存储清理完成', 'success']]);
  assert.ok(harness.order.indexOf('toast:存储清理完成') < harness.order.indexOf('refreshAll'));
  assert.equal(harness.elements.storageCleanupRunBtn.disabled, true);
  assert.match(harness.elements.storageCleanupRunBtn.textContent, /执行清理/);
});

test('storage cleanup validation and failures preserve visible state', async () => {
  const harness = createHarness({ responses: [new Error('preview down')] });
  harness.elements.storageCleanupCategories.querySelectorAll('input').forEach((input) => { input.checked = false; });
  await harness.previewStorageCleanup();
  assert.deepEqual(harness.toasts, [['请至少选择一个清理类别', 'warn']]);
  assert.equal(harness.calls.length, 0);
  harness.elements.storageCleanupCategories.querySelector('input').checked = true;
  await harness.previewStorageCleanup();
  assert.deepEqual(harness.toasts.at(-1), ['preview down', 'error']);
  assert.equal(harness.elements.storageCleanupRunBtn.disabled, true);
  assert.equal(harness.elements.storageCleanupStatus.textContent, '');
});

test('backup storage controller mount remains idempotent', () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(read('public/features/backup-storage/controller.js'), context);
  let mounts = 0;
  let unmounts = 0;
  const controller = context.window.BackupStorageController.create({ api: {}, view: {}, actions: { mount() { mounts += 1; }, unmount() { unmounts += 1; } } });
  controller.mount(); controller.mount(); controller.unmount(); controller.unmount();
  assert.equal(mounts, 1);
  assert.equal(unmounts, 1);
});
