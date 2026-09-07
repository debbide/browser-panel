const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { read } = require('./helpers');

function createBoundary({ responses = [] } = {}) {
  const dom = new JSDOM(`<!doctype html><body><div id="backup-assets-mask" hidden></div><div id="backup-assets-modal" hidden></div><div id="backup-import-mask" hidden></div><div id="backup-import-modal" hidden></div><div id="cloud-backup-list"></div><div id="cloud-restore-mask" hidden></div><div id="cloud-restore-modal" hidden></div><input id="storage-cleanup-days" value="30"><div id="storage-cleanup-categories"><input type="checkbox" value="screenshots" checked><input type="checkbox" value="logs" checked></div><button id="storage-cleanup-preview-btn"></button><button id="storage-cleanup-run-btn" disabled></button><div id="storage-cleanup-status"></div><div id="storage-cleanup-result"></div></body>`, { url: 'https://panel.test/' });
  const calls = [];
  const toasts = [];
  const order = [];
  let responseIndex = 0;
  const fetchJson = async (path, options) => {
    calls.push([path, options && JSON.parse(JSON.stringify(options))]);
    order.push(`fetch:${path}`);
    const response = responses[responseIndex++];
    if (response instanceof Error) throw response;
    return response || { data: {} };
  };
  const context = vm.createContext({ window: dom.window, URLSearchParams });
  context.window.window = context.window;
  context.window.fetchJson = fetchJson;
  vm.runInContext(read('public/features/backup-storage/api.js'), context);
  vm.runInContext(read('public/features/backup-storage/view.js'), context);
  vm.runInContext(read('public/features/backup-storage/controller.js'), context);
  const byId = (id) => dom.window.document.getElementById(id);
  const elements = {
    backupAssetsMask: byId('backup-assets-mask'), backupAssetsModal: byId('backup-assets-modal'),
    backupImportMask: byId('backup-import-mask'), backupImportModal: byId('backup-import-modal'),
    cloudBackupList: byId('cloud-backup-list'), cloudRestoreMask: byId('cloud-restore-mask'), cloudRestoreModal: byId('cloud-restore-modal'),
    storageCleanupDays: byId('storage-cleanup-days'), storageCleanupCategories: byId('storage-cleanup-categories'),
    storageCleanupPreviewBtn: byId('storage-cleanup-preview-btn'), storageCleanupRunBtn: byId('storage-cleanup-run-btn'),
    storageCleanupStatus: byId('storage-cleanup-status'), storageCleanupResult: byId('storage-cleanup-result'),
  };
  const controller = context.window.BackupStorageController.create({
    api: context.window.BackupStorageApi,
    view: context.window.BackupStorageView,
    elements,
    actions: {
      toast(message, type) { toasts.push([message, type]); order.push(`toast:${message}`); },
      refreshAll: async () => order.push('refreshAll'), loadTasks: async () => order.push('loadTasks'),
      downloadBackup: async (ids, passphrase) => order.push(`download:${ids.join(',')}:${passphrase}`),
      dialogConfirm: (message, action) => action(), escapeHtml: (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
      formatBytes: (value) => `${value} B`, createIcons() {},
    },
  });
  return { controller, elements, calls, toasts, order };
}

async function exportTrace(factory) {
  const boundary = factory({ responses: [{ data: [{ id: 7, name: 'job', script_path: 'tasks/job.js', paths: ['tasks/lib'], declared: ['tasks/lib'] }] }, { data: {} }] });
  await boundary.controller.startBackupExport([7], 'secret');
  boundary.elements.backupAssetsModal.querySelector('[data-assets-confirm]').click();
  await new Promise((resolve) => setImmediate(resolve));
  return { calls: boundary.calls, toasts: boundary.toasts, order: boundary.order, modalHidden: boundary.elements.backupAssetsModal.hidden, maskHidden: boundary.elements.backupAssetsMask.hidden };
}

async function importTrace(factory) {
  const preview = { tasks: [{ name: 'task <x>', action: 'overwrite' }], scripts: [{ path: 'tasks/<x>.js', action: 'skip' }], profiles: [], warnings: ['warn <y>'], names_only: false };
  const boundary = factory({ responses: [{ data: preview }, { data: { created: [{ id: 9 }] } }] });
  await boundary.controller.previewBackupPayload('encoded', 'secret');
  boundary.elements.backupImportModal.querySelector('[data-backup-confirm]').click();
  await new Promise((resolve) => setImmediate(resolve));
  return { calls: boundary.calls, toasts: boundary.toasts, order: boundary.order, modalHidden: boundary.elements.backupImportModal.hidden, maskHidden: boundary.elements.backupImportMask.hidden };
}

async function cloudTrace(factory) {
  const boundary = factory({ responses: [{ data: [{ key: 'daily/<x>.json', name: 'daily/<x>.json', lastModified: '2026-01-02T03:04:05Z', size: 12 }] }, { data: { tasks: [], scripts: [], profiles: [], warnings: [] } }, { data: {} }] });
  await boundary.controller.loadCloudBackupList();
  await boundary.controller.previewCloudBackup('daily/<x>.json');
  boundary.elements.cloudRestoreModal.querySelector('[data-cloud-restore-confirm]').click();
  await new Promise((resolve) => setImmediate(resolve));
  const listHtml = boundary.elements.cloudBackupList.innerHTML.replace(/>\s+</g, '><').trim();
  return { calls: boundary.calls, toasts: boundary.toasts, order: boundary.order, listHtml, modalHidden: boundary.elements.cloudRestoreModal.hidden, maskHidden: boundary.elements.cloudRestoreMask.hidden };
}

async function cleanupTrace(factory) {
  const boundary = factory({ responses: [{ data: { count: 3, bytes: 40, runRows: 2, byCategory: {} } }] });
  await boundary.controller.previewStorageCleanup();
  return { calls: boundary.calls, toasts: boundary.toasts, order: boundary.order, status: boundary.elements.storageCleanupStatus.textContent, result: boundary.elements.storageCleanupResult.textContent, runDisabled: boundary.elements.storageCleanupRunBtn.disabled };
}

const runtimeTraces = {
  export: {
    calls: [
      ['/api/backup/scan-assets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"task_ids":[7]}' }],
      ['/api/backup/save-assets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"tasks":[{"id":7,"paths":["tasks/lib"]}]}' }],
    ],
    toasts: [],
    order: ['fetch:/api/backup/scan-assets', 'fetch:/api/backup/save-assets', 'loadTasks', 'download:7:secret'],
    modalHidden: true,
    maskHidden: true,
  },
  import: {
    calls: [
      ['/api/backup/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"backup":"encoded","passphrase":"secret"}' }],
      ['/api/backup/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"backup":"encoded","passphrase":"secret","task_strategy":"rename","script_strategy":"skip"}' }],
    ],
    toasts: [['备份已导入：新增 1 个任务', 'success']],
    order: ['fetch:/api/backup/preview', 'fetch:/api/backup/import', 'toast:备份已导入：新增 1 个任务', 'refreshAll'],
    modalHidden: true,
    maskHidden: true,
  },
  cloud: {
    calls: [
      ['/api/cloud-backup/list', undefined],
      ['/api/cloud-backup/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"key":"daily/<x>.json"}' }],
      ['/api/cloud-backup/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"key":"daily/<x>.json"}' }],
    ],
    toasts: [['还原完成，请稍候面板重启', 'success']],
    order: ['fetch:/api/cloud-backup/list', 'fetch:/api/cloud-backup/preview', 'fetch:/api/cloud-backup/restore', 'toast:还原完成，请稍候面板重启'],
    listHtml: '<div class="backup-summary-card" style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;"><div style="min-width:0;"><strong style="display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">daily/&lt;x&gt;.json</strong><span class="muted">1/2/2026, 3:04:05 AM · 12 B</span></div><div class="row" style="gap:6px; flex-wrap:nowrap;"><button type="button" class="alt btn-with-icon" data-cloud-preview="0"><i data-lucide="eye" class="icon-sm"></i> 预览</button><button type="button" class="btn-primary btn-with-icon" data-cloud-restore="0"><i data-lucide="download-cloud" class="icon-sm"></i> 恢复</button></div></div>',
    modalHidden: true,
    maskHidden: true,
  },
  cleanup: {
    calls: [['/api/storage/cleanup/preview?retentionDays=30&categories=screenshots%2Clogs', undefined]],
    toasts: [],
    order: ['fetch:/api/storage/cleanup/preview?retentionDays=30&categories=screenshots%2Clogs'],
    status: '预计释放 40 B',
    result: '预计 3 项，约 40 B，运行记录 2 条',
    runDisabled: false,
  },
};

test('feature export boundary matches the frozen runtime trace', async () => {
  assert.deepEqual(await exportTrace(createBoundary), runtimeTraces.export);
});

test('feature import boundary matches the frozen runtime trace', async () => {
  assert.deepEqual(await importTrace(createBoundary), runtimeTraces.import);
});

test('feature cloud restore boundary matches the frozen runtime trace', async () => {
  assert.deepEqual(await cloudTrace(createBoundary), runtimeTraces.cloud);
});

test('feature cleanup boundary matches the frozen runtime trace', async () => {
  assert.deepEqual(await cleanupTrace(createBoundary), runtimeTraces.cleanup);
});

test('feature boundary owns independent backup-storage state', () => {
  const first = createBoundary().controller;
  const second = createBoundary().controller;
  first.state.selectedTaskIds.add(7);
  first.state.pendingImport = { backup: 'one' };
  assert.deepEqual([...first.state.selectedTaskIds], [7]);
  assert.equal(second.state.selectedTaskIds.size, 0);
  assert.equal(second.state.pendingImport, null);
});

test('feature boundary preserves export payload and refresh order', async () => {
  const boundary = createBoundary({ responses: [{ data: [{ id: 7, name: 'job', script_path: 'tasks/job.js', paths: ['tasks/lib'], declared: ['tasks/lib'] }] }, { data: {} }] });
  await boundary.controller.startBackupExport([7], 'secret');
  boundary.elements.backupAssetsModal.querySelector('[data-assets-confirm]').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(boundary.calls, [
    ['/api/backup/scan-assets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task_ids: [7] }) }],
    ['/api/backup/save-assets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tasks: [{ id: 7, paths: ['tasks/lib'] }] }) }],
  ]);
  assert.deepEqual(boundary.order.slice(-2), ['loadTasks', 'download:7:secret']);
});

test('feature boundary preserves cleanup payload, messages, and refresh order', async () => {
  const boundary = createBoundary({ responses: [{ data: { count: 3, bytes: 40, runRows: 2 } }, { data: { count: 3, bytes: 40, failures: [] } }] });
  boundary.controller.mount();
  await boundary.controller.previewStorageCleanup();
  await boundary.controller.runStorageCleanup();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(boundary.calls[0], ['/api/storage/cleanup/preview?retentionDays=30&categories=screenshots%2Clogs', undefined]);
  assert.deepEqual(boundary.calls[1], ['/api/storage/cleanup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ retentionDays: 30, categories: ['screenshots', 'logs'] }) }]);
  assert.deepEqual(boundary.toasts, [['存储清理完成', 'success']]);
  assert.ok(boundary.order.indexOf('toast:存储清理完成') < boundary.order.indexOf('refreshAll'));
});

test('feature boundary binding lifecycle is idempotent and reversible', () => {
  const boundary = createBoundary();
  let additions = 0;
  let removals = 0;
  const element = boundary.elements.storageCleanupPreviewBtn;
  const add = element.addEventListener.bind(element);
  const remove = element.removeEventListener.bind(element);
  element.addEventListener = (...args) => { additions += 1; return add(...args); };
  element.removeEventListener = (...args) => { removals += 1; return remove(...args); };
  boundary.controller.mount();
  boundary.controller.mount();
  boundary.controller.unmount();
  boundary.controller.unmount();
  assert.equal(additions, 1);
  assert.equal(removals, 1);
});
