(function exposeBackupStorageView(global) {
  function formatCloudBackupTime(iso) {
    if (!iso) return '-';
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString();
  }

  function renderCloudBackupList(render, rows) {
    return render(rows);
  }

  function renderCleanupPreview(render, preview) {
    return render(preview);
  }

  function updateSelection(update, state) {
    return update(state);
  }

  global.BackupStorageView = {
    formatCloudBackupTime,
    renderCloudBackupList,
    renderCleanupPreview,
    updateSelection,
  };
})(window);
