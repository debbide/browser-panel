const test = require('node:test');
const assert = require('node:assert/strict');
const { read } = require('./helpers');

const runtime = read('public/panel-runtime.js');

test('backup selection rendering and event contracts remain stable', () => {
  assert.match(runtime, /backupSelectionBar\.hidden = !backupSelectionMode/);
  assert.match(runtime, /已选择 \$\{count\} 个任务/);
  assert.match(runtime, /backupExportBtn\.disabled = count === 0/);
  assert.match(runtime, /backupSelectAll\.indeterminate = count > 0 && count < available/);
  assert.match(runtime, /window\.toggleBackupTask = function toggleBackupTask/);
  assert.match(runtime, /event\.target\.closest\('\[data-task-action-area\]'\)/);
});

test('local backup export preserves scan, save, download, and modal contracts', () => {
  assert.match(runtime, /\/api\/backup\/scan-assets/);
  assert.match(runtime, /\/api\/backup\/save-assets/);
  assert.match(runtime, /\/api\/backup\/export/);
  assert.match(runtime, /附加模块/);
  assert.match(runtime, /勾选的目录会跟主脚本一起打包。只影响这次备份，不影响运行。/);
  assert.match(runtime, /closeBackupAssetsModal/);
  assert.match(runtime, /data-assets-confirm/);
});

test('backup import preserves preview payload, strategies, errors, modal, and refresh timing', () => {
  assert.match(runtime, /\/api\/backup\/preview/);
  assert.match(runtime, /backup: pendingBackupPayload\.backup/);
  assert.match(runtime, /passphrase: pendingBackupPayload\.passphrase/);
  assert.match(runtime, /task_strategy: taskStrategy/);
  assert.match(runtime, /script_strategy: scriptStrategy/);
  assert.match(runtime, /closeBackupImportModal\(\);[\s\S]*备份已导入：新增 \$\{data\.data\.created\.length\} 个任务[\s\S]*await refreshAll\(\)/);
  assert.match(runtime, /备份文件不是合法 JSON 或加密备份/);
  assert.match(runtime, /解析加密备份失败/);
  assert.match(runtime, /导入备份失败/);
});

test('cloud backup preserves settings, list, restore, confirmation, and error contracts', () => {
  for (const path of [
    '/api/cloud-backup/settings', '/api/cloud-backup/test', '/api/cloud-backup/run',
    '/api/cloud-backup/list', '/api/cloud-backup/preview', '/api/cloud-backup/restore',
  ]) assert.ok(runtime.includes(path), path);
  assert.match(runtime, /closeCloudRestoreModal/);
  assert.match(runtime, /confirmCloudRestore/);
  assert.match(runtime, /dialogConfirm/);
  assert.match(runtime, /loadCloudBackupList/);
});

test('storage cleanup preview preserves query, visible text, invalidation, and run gating', () => {
  assert.match(runtime, /retentionDays: String\(payload\.retentionDays\)/);
  assert.match(runtime, /categories: payload\.categories\.join\(','\)/);
  assert.match(runtime, /\/api\/storage\/cleanup\/preview\?\$\{query\}/);
  assert.match(runtime, /请至少选择一个清理类别/);
  assert.match(runtime, /预计 \$\{data\.count\} 项，约 \$\{formatBytes\(data\.bytes\)\}/);
  assert.match(runtime, /storageCleanupRunBtn\.disabled = !storageCleanupPreview\?\.count/);
  assert.match(runtime, /storageCleanupPreview = null;[\s\S]*选项已改变，请重新预览/);
  assert.match(runtime, /生成清理预览失败/);
  assert.match(runtime, /预览估算/);
});

test('backup storage binding and startup remain single-owner contracts', () => {
  assert.equal((runtime.match(/backupStorageController\.mount\(\)/g) || []).length, 1);
  assert.equal((runtime.match(/backupStorageController\.load\(\)/g) || []).length, 1);
  for (const id of [
    'backup-select-btn', 'backup-import-btn', 'backup-export-btn',
    'cloud-backup-test-btn', 'cloud-backup-run-btn', 'cloud-backup-refresh-btn',
    'storage-cleanup-preview-btn', 'storage-cleanup-run-btn',
  ]) assert.ok(runtime.includes(id), id);
});
