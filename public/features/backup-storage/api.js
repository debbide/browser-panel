(function exposeBackupStorageApi(global) {
  const json = (body) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const api = {
    scanAssets: (body) => global.fetchJson('/api/backup/scan-assets', json(body)),
    saveAssets: (body) => global.fetchJson('/api/backup/save-assets', json(body)),
    previewImport: (body) => global.fetchJson('/api/backup/preview', json(body)),
    importBackup: (body) => global.fetchJson('/api/backup/import', json(body)),
    loadCloudSettings: () => global.fetchJson('/api/cloud-backup/settings'),
    saveCloudSettings: (body) => global.fetchJson('/api/cloud-backup/settings', json(body)),
    clearCloudSettings: () => global.fetchJson('/api/cloud-backup/settings', { method: 'DELETE' }),
    testCloudConnection: () => global.fetchJson('/api/cloud-backup/test', { method: 'POST' }),
    runCloudBackup: (body) => global.fetchJson('/api/cloud-backup/run', json(body)),
    listCloudBackups: () => global.fetchJson('/api/cloud-backup/list'),
    previewCloudBackup: (body) => global.fetchJson('/api/cloud-backup/preview', json(body)),
    restoreCloudBackup: (body) => global.fetchJson('/api/cloud-backup/restore', json(body)),
    previewCleanup: (query) => global.fetchJson(`/api/storage/cleanup/preview?${query}`),
    runCleanup: (body) => global.fetchJson('/api/storage/cleanup', json(body)),
  };

  global.BackupStorageApi = api;
})(window);
