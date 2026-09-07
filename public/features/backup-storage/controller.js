(function exposeBackupStorageController(global) {
  function createState(initial = {}) {
    return {
      selectionMode: false,
      selectedTaskIds: new Set(),
      pendingImport: null,
      pendingCloudRestoreKey: null,
      cleanupPreview: null,
      ...initial,
    };
  }

  function create({ api, view, state = createState(), elements = {}, actions = {} }) {
    let mounted = false;
    const listeners = [];
    const on = (element, event, handler) => {
      if (!element) return;
      element.addEventListener(event, handler);
      listeners.push([element, event, handler]);
    };
    const icons = (root) => actions.createIcons?.(root);

    function setCloudBackupStatus(text, color) {
      if (!elements.cloudBackupStatusText) return;
      elements.cloudBackupStatusText.textContent = text;
      if (color) elements.cloudBackupStatusText.style.color = color;
    }

    function updateCloudBackupTimeFields() {
      if (!elements.cloudBackupTimeFields) return;
      const show = elements.cloudBackupSchedule && elements.cloudBackupSchedule.value !== 'off';
      elements.cloudBackupTimeFields.style.display = show ? 'grid' : 'none';
    }

    async function loadCloudBackupSettings() {
      if (!elements.cloudBackupForm) return;
      setCloudBackupStatus('状态：加载中...', '#94a3b8');
      try {
        const result = await api.loadCloudSettings();
        const data = result.data || {};
        if (elements.cloudBackupEnabled) elements.cloudBackupEnabled.checked = Boolean(data.enabled);
        if (elements.cloudBackupEndpoint) elements.cloudBackupEndpoint.value = data.endpoint || '';
        if (elements.cloudBackupRegion) elements.cloudBackupRegion.value = data.region || '';
        if (elements.cloudBackupBucket) elements.cloudBackupBucket.value = data.bucket || '';
        if (elements.cloudBackupAccessKey) {
          elements.cloudBackupAccessKey.value = '';
          elements.cloudBackupAccessKey.placeholder = data.hasAccessKey ? `已设置 ${data.accessKeyMasked}（留空不修改）` : 'AKIA...';
        }
        if (elements.cloudBackupSecretKey) {
          elements.cloudBackupSecretKey.value = '';
          elements.cloudBackupSecretKey.placeholder = data.hasSecretKey ? `已设置 ${data.secretKeyMasked}（留空不修改）` : '未设置';
        }
        if (elements.cloudBackupToken) {
          elements.cloudBackupToken.value = '';
          elements.cloudBackupToken.placeholder = data.hasToken ? `已设置 ${data.tokenMasked}（留空不修改）` : '临时凭据专用，留空不修改';
        }
        if (elements.cloudBackupProxy) elements.cloudBackupProxy.value = data.proxy || '';
        if (elements.cloudBackupPathStyle) elements.cloudBackupPathStyle.checked = Boolean(data.pathStyle);
        if (elements.cloudBackupPrefix) elements.cloudBackupPrefix.value = data.prefix || '';
        if (elements.cloudBackupRetention) elements.cloudBackupRetention.value = data.retention ?? 7;
        if (elements.cloudBackupSchedule) elements.cloudBackupSchedule.value = data.schedule || 'off';
        if (elements.cloudBackupHour) elements.cloudBackupHour.value = data.hour ?? 3;
        if (elements.cloudBackupMinute) elements.cloudBackupMinute.value = data.minute ?? 0;
        if (elements.cloudBackupPassphrase) {
          elements.cloudBackupPassphrase.value = '';
          elements.cloudBackupPassphrase.placeholder = data.hasPassphrase ? '已设置备份密码（留空不修改）' : '未设置，请填写并离线保存';
        }
        if (elements.cloudBackupPassphraseConfirm) elements.cloudBackupPassphraseConfirm.checked = false;
        updateCloudBackupTimeFields();
        const enabledText = data.enabled ? '已启用' : '未启用';
        const scheduleText = { off: '仅手动', hourly: '每小时', daily: '每天' }[data.schedule] || '仅手动';
        setCloudBackupStatus(`状态：${enabledText} · ${scheduleText}`, '#94a3b8');
        if (elements.cloudBackupNextText) {
          if (data.nextAt) {
            try { elements.cloudBackupNextText.textContent = `下一次自动备份：${new Date(data.nextAt).toLocaleString()}`; }
            catch { elements.cloudBackupNextText.textContent = '下一次自动备份：未排期'; }
          } else elements.cloudBackupNextText.textContent = '下一次自动备份：未排期';
        }
      } catch (error) {
        setCloudBackupStatus('状态：加载失败', '#ef4444');
        actions.error?.('Failed to load cloud backup settings:', error);
      }
    }

    async function saveCloudBackupSettings() {
      if (!elements.cloudBackupForm) return;
      const passphrase = elements.cloudBackupPassphrase?.value || '';
      if (passphrase && !elements.cloudBackupPassphraseConfirm?.checked) {
        actions.toast('设置新密码前请先勾选「我已把备份密码离线保存」', 'warn');
        return;
      }
      if (elements.cloudBackupSaveBtn) elements.cloudBackupSaveBtn.disabled = true;
      try {
        await api.saveCloudSettings({
          enabled: Boolean(elements.cloudBackupEnabled?.checked),
          endpoint: elements.cloudBackupEndpoint?.value || '',
          region: elements.cloudBackupRegion?.value || '',
          bucket: elements.cloudBackupBucket?.value || '',
          accessKey: elements.cloudBackupAccessKey?.value || '',
          secretKey: elements.cloudBackupSecretKey?.value || '',
          token: elements.cloudBackupToken?.value || '',
          proxy: elements.cloudBackupProxy?.value || '',
          pathStyle: Boolean(elements.cloudBackupPathStyle?.checked),
          prefix: elements.cloudBackupPrefix?.value || '',
          retention: Number(elements.cloudBackupRetention?.value || 7),
          schedule: elements.cloudBackupSchedule?.value || 'off',
          hour: Number(elements.cloudBackupHour?.value || 3),
          minute: Number(elements.cloudBackupMinute?.value || 0),
          passphrase,
        });
        actions.toast('云端备份设置已保存', 'success');
        await loadCloudBackupSettings();
      } catch (error) {
        actions.toast(error.message || '保存云端备份设置失败', 'error');
      } finally {
        if (elements.cloudBackupSaveBtn) elements.cloudBackupSaveBtn.disabled = false;
      }
    }

    async function testCloudBackupConnection() {
      if (!elements.cloudBackupTestBtn) return;
      elements.cloudBackupTestBtn.disabled = true;
      elements.cloudBackupTestBtn.textContent = '测试中...';
      try {
        await api.testCloudConnection();
        actions.toast('连接成功：已写入并删除探针对象', 'success');
      } catch (error) {
        actions.toast(error.message || '测试连接失败', 'error');
      } finally {
        elements.cloudBackupTestBtn.disabled = false;
        elements.cloudBackupTestBtn.innerHTML = '<i data-lucide="plug-zap" class="icon-sm"></i> 测试连接';
        icons();
      }
    }

    async function runCloudBackupNow() {
      if (!elements.cloudBackupRunBtn) return;
      const label = elements.cloudBackupLabel?.value.trim() || '';
      elements.cloudBackupRunBtn.disabled = true;
      elements.cloudBackupRunBtn.textContent = '备份中...';
      try {
        const result = await api.runCloudBackup({ label });
        const data = result.data || {};
        const warnings = Array.isArray(data.warnings) ? data.warnings : [];
        const suffix = warnings.length ? `（${warnings.length} 条提示，见控制台）` : '';
        actions.toast(`备份完成：${data.name || data.key || ''}${suffix}`, 'success');
        warnings.forEach((warning) => actions.warn?.('[cloud-backup]', warning));
        if (elements.cloudBackupLabel) elements.cloudBackupLabel.value = '';
        await loadCloudBackupSettings();
        await loadCloudBackupList();
      } catch (error) {
        actions.toast(error.message || '备份失败', 'error');
      } finally {
        elements.cloudBackupRunBtn.disabled = false;
        elements.cloudBackupRunBtn.innerHTML = '<i data-lucide="cloud-upload" class="icon-sm"></i> 立即备份';
        icons();
      }
    }

    async function clearCloudBackupSettings() {
      if (!actions.confirm('确定要清空云端备份的所有配置吗？已填写的密钥、密码等将全部清除。')) return;
      try {
        elements.cloudBackupClearBtn.disabled = true;
        elements.cloudBackupClearBtn.textContent = '清空中...';
        await api.clearCloudSettings();
        actions.toast('云端备份配置已清空', 'success');
        await loadCloudBackupSettings();
      } catch (error) {
        actions.toast(error.message || '清空失败', 'error');
      } finally {
        elements.cloudBackupClearBtn.disabled = false;
        elements.cloudBackupClearBtn.innerHTML = '<i data-lucide="trash-2" class="icon-sm"></i> 清空配置';
        icons();
      }
    }

    function updateBackupSelectionUi() {
      const available = actions.getTasks?.().length || 0;
      const count = state.selectedTaskIds.size;
      if (elements.backupSelectionCount) elements.backupSelectionCount.textContent = `已选择 ${count} 个任务`;
      if (elements.backupExportBtn) elements.backupExportBtn.disabled = count === 0;
      if (elements.backupSelectAll) {
        elements.backupSelectAll.checked = available > 0 && count === available;
        elements.backupSelectAll.indeterminate = count > 0 && count < available;
      }
    }

    function setBackupSelectionMode(enabled) {
      state.selectionMode = Boolean(enabled);
      if (!state.selectionMode) state.selectedTaskIds.clear();
      if (elements.backupSelectionBar) elements.backupSelectionBar.hidden = !state.selectionMode;
      if (elements.backupSelectBtn) {
        elements.backupSelectBtn.innerHTML = state.selectionMode
          ? '<i data-lucide="x" class="icon-sm"></i> 退出选择'
          : '<i data-lucide="archive" class="icon-sm"></i> 备份';
      }
      updateBackupSelectionUi();
      actions.renderTasks?.();
      icons();
    }

    function toggleBackupTask(id, event) {
      if (!state.selectionMode) return;
      if (event?.target?.closest('[data-task-action-area]')) return;
      const taskId = Number(id);
      if (state.selectedTaskIds.has(taskId)) state.selectedTaskIds.delete(taskId);
      else state.selectedTaskIds.add(taskId);
      updateBackupSelectionUi();
      actions.renderTasks?.();
    }

    async function downloadBackup(taskIds, passphrase) {
      try {
        const body = {};
        if (taskIds?.length) body.task_ids = taskIds.join(',');
        if (passphrase) body.passphrase = passphrase;
        const response = await actions.fetch('/api/backup/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (response.status === 401) { actions.goLogin(); return; }
        if (!response.ok) {
          let message = '导出失败';
          try { message = JSON.parse(await response.text()).message || message; } catch {}
          throw new Error(message);
        }
        const blob = await response.blob();
        const disposition = response.headers.get('Content-Disposition') || '';
        const utf8Match = disposition.match(/filename\*=UTF-8''([^;\n]+)/i);
        const basicMatch = disposition.match(/filename="?([^";\n]+)"?/i);
        let filename = passphrase ? 'backup.bpenc' : 'backup.json';
        if (utf8Match) {
          try { filename = decodeURIComponent(utf8Match[1]); }
          catch { filename = basicMatch ? basicMatch[1] : filename; }
        } else if (basicMatch) filename = basicMatch[1];
        actions.downloadBlob(blob, filename);
        setBackupSelectionMode(false);
      } catch (error) {
        actions.toast(error.message || '导出备份失败', 'error');
      }
    }

    async function previewBackupFile(file) {
      const text = await file.text();
      if (!text.trim()) throw new Error('备份文件为空');
      if (text.trimStart().startsWith('bp-enc$')) {
        actions.dialogPassphraseOnce('这是加密备份，请输入导出时设置的密码。', async (passphrase) => {
          try { await previewBackupPayload(text.trim(), passphrase); }
          catch (error) { actions.toast(error.message || '解析加密备份失败', 'error'); }
        });
        return;
      }
      let backup;
      try { backup = JSON.parse(text); }
      catch { throw new Error('备份文件不是合法 JSON 或加密备份'); }
      await previewBackupPayload(backup);
    }

    function closeBackupAssetsModal() {
      const { backupAssetsModal, backupAssetsMask } = elements;
      if (backupAssetsModal) {
        backupAssetsModal.classList.remove('open');
        backupAssetsModal.hidden = true;
        backupAssetsModal.innerHTML = '';
      }
      if (backupAssetsMask) backupAssetsMask.hidden = true;
    }

    function showBackupAssetsModal(rows, onConfirm) {
      const { backupAssetsModal, backupAssetsMask } = elements;
      if (!backupAssetsModal) { onConfirm(null); return; }
      const selectionState = rows.map((row) => ({ ...row, checked: new Set(row.paths) }));
      const render = () => {
        const total = selectionState.reduce((sum, row) => sum + row.checked.size, 0);
        backupAssetsModal.innerHTML = `
          <div class="modal-panel backup-assets-panel">
            <div class="modal-header" style="padding:18px 22px;"><div><h2 style="margin:0;">附加模块</h2><p class="muted" style="margin:3px 0 0;">勾选的目录会跟主脚本一起打包。只影响这次备份，不影响运行。</p></div><button type="button" class="icon-btn" data-assets-close aria-label="关闭">关闭</button></div>
            <div class="modal-body" style="padding:22px;">
              ${selectionState.map((row, rowIndex) => `<div class="backup-assets-task"><div class="backup-assets-task-head"><strong>${actions.escapeHtml(row.name)}</strong><code class="muted">${actions.escapeHtml(row.script_path || '')}</code></div>${row.error ? `<p class="muted" style="margin:4px 0 0;font-size:12px;">扫描失败：${actions.escapeHtml(row.error)}</p>` : ''}${row.paths.length ? `<div class="backup-assets-list">${row.paths.map((path, pathIndex) => `<label class="inline-check"><input type="checkbox" data-assets-row="${rowIndex}" data-assets-path="${pathIndex}" ${row.checked.has(path) ? 'checked' : ''} /><code>${actions.escapeHtml(path)}</code>${row.declared.includes(path) ? '<span class="muted" style="font-size:11px;">已声明</span>' : '<span class="muted" style="font-size:11px;">扫描发现</span>'}</label>`).join('')}</div>` : '<p class="muted" style="margin:4px 0 0;font-size:12px;">没扫到 tasks/ 下的本地模块，只带主脚本。</p>'}</div>`).join('')}
              <div class="backup-import-actions"><span class="muted" style="margin-right:auto;">共选中 ${total} 项</span><button type="button" class="alt" data-assets-close>取消</button><button type="button" data-assets-confirm><i data-lucide="download" class="icon-sm"></i>确认并导出</button></div>
            </div>
          </div>`;
        backupAssetsModal.querySelectorAll('[data-assets-row]').forEach((box) => box.addEventListener('change', () => {
          const row = selectionState[Number(box.dataset.assetsRow)];
          const path = row.paths[Number(box.dataset.assetsPath)];
          if (box.checked) row.checked.add(path); else row.checked.delete(path);
          render();
        }));
        backupAssetsModal.querySelectorAll('[data-assets-close]').forEach((button) => button.addEventListener('click', closeBackupAssetsModal));
        backupAssetsModal.querySelector('[data-assets-confirm]')?.addEventListener('click', () => {
          const selection = selectionState.map((row) => ({ id: row.id, paths: [...row.checked].sort() }));
          closeBackupAssetsModal();
          onConfirm(selection);
        });
        icons(backupAssetsModal);
      };
      render();
      backupAssetsModal.hidden = false;
      backupAssetsModal.classList.add('open');
      if (backupAssetsMask) backupAssetsMask.hidden = false;
    }

    async function persistExtraPaths(selection) {
      const tasks = (selection || []).map((row) => ({ id: Number(row.id), paths: row.paths })).filter((row) => Number.isInteger(row.id) && row.id > 0);
      if (!tasks.length) return;
      try { await api.saveAssets({ tasks }); }
      catch (error) { actions.toast(`附加模块保存失败：${error.message || ''}（本次导出仍会带上勾选内容）`, 'warn'); }
    }

    async function startBackupExport(ids, passphrase) {
      let rows;
      try {
        const data = await api.scanAssets({ task_ids: ids });
        rows = Array.isArray(data.data) ? data.data : [];
      } catch (error) {
        actions.toast(`依赖扫描失败：${error.message || ''}，按已声明的模块导出`, 'warn');
        await (actions.downloadBackup || downloadBackup)(ids, passphrase);
        return;
      }
      if (!rows.some((row) => row.paths.length)) { await (actions.downloadBackup || downloadBackup)(ids, passphrase); return; }
      showBackupAssetsModal(rows, async (selection) => {
        if (!selection) return;
        await persistExtraPaths(selection);
        await actions.loadTasks();
        await (actions.downloadBackup || downloadBackup)(ids, passphrase);
      });
    }

    function closeBackupImportModal() {
      state.pendingImport = null;
      const { backupImportModal, backupImportMask } = elements;
      if (backupImportModal) { backupImportModal.classList.remove('open'); backupImportModal.hidden = true; backupImportModal.innerHTML = ''; }
      if (backupImportMask) backupImportMask.hidden = true;
    }

    function showBackupImportModal(plan, backup, passphrase) {
      const { backupImportModal, backupImportMask } = elements;
      if (!backupImportModal) return;
      state.pendingImport = { backup, passphrase };
      const conflicts = [
        ...plan.scripts.filter((item) => ['overwrite', 'rename', 'skip'].includes(item.action)).map((item) => `脚本 ${item.path}：${item.action}`),
        ...plan.tasks.filter((item) => ['overwrite', 'rename', 'skip'].includes(item.action)).map((item) => `任务「${item.name}」：${item.action}`),
      ];
      const warningList = [...(plan.warnings || []), ...(plan.names_only ? ['此备份只包含变量名，导入后需要手动补填所有变量值'] : [])];
      backupImportModal.innerHTML = `<div class="modal-panel backup-import-panel"><div class="modal-header" style="padding:18px 22px;"><div><h2 style="margin:0;">恢复任务备份</h2><p class="muted" style="margin:3px 0 0;">导入后任务默认停用，请确认冲突处理方式。</p></div><button type="button" class="icon-btn" data-backup-close aria-label="关闭">关闭</button></div><div class="modal-body" style="padding:22px;"><div class="backup-import-summary"><div class="backup-summary-card"><strong>${plan.tasks.length}</strong><span class="muted">任务</span></div><div class="backup-summary-card"><strong>${plan.scripts.length}</strong><span class="muted">脚本</span></div><div class="backup-summary-card"><strong>${plan.profiles.length}</strong><span class="muted">浏览器配置</span></div></div><div class="two-col-modal" style="grid-template-columns:1fr 1fr;"><label>任务重名处理<select id="backup-task-strategy"><option value="rename">重命名导入</option><option value="overwrite">覆盖已有任务</option><option value="skip">跳过重名任务</option></select></label><label>脚本冲突处理<select id="backup-script-strategy"><option value="skip">跳过已有脚本</option><option value="overwrite">覆盖已有脚本</option><option value="rename">重命名脚本</option></select></label></div>${conflicts.length ? `<h4>冲突摘要</h4><ul class="backup-conflict-list">${conflicts.map((item) => `<li>${actions.escapeHtml(item)}</li>`).join('')}</ul>` : '<p class="muted">没有发现文件或任务冲突。</p>'}${warningList.length ? `<h4 class="backup-warning">导入提示</h4><ul class="backup-conflict-list backup-warning">${warningList.map((item) => `<li>${actions.escapeHtml(item)}</li>`).join('')}</ul>` : ''}<div class="backup-import-actions"><button type="button" class="alt" data-backup-close>取消</button><button type="button" data-backup-confirm><i data-lucide="upload" class="icon-sm"></i>确认导入</button></div></div></div>`;
      backupImportModal.hidden = false;
      if (backupImportMask) backupImportMask.hidden = false;
      backupImportModal.classList.add('open');
      backupImportModal.querySelectorAll('[data-backup-close]').forEach((button) => button.addEventListener('click', closeBackupImportModal));
      backupImportModal.querySelector('[data-backup-confirm]')?.addEventListener('click', importPendingBackup);
      icons(backupImportModal);
    }

    async function previewBackupPayload(backup, passphrase = '') {
      try {
        const result = await api.previewImport({ backup, passphrase });
        showBackupImportModal(result.data || {}, backup, passphrase);
      } catch (error) { actions.toast(error.message || '备份预检失败', 'error'); }
    }

    async function importPendingBackup() {
      if (!state.pendingImport) return;
      const { backupImportModal } = elements;
      const confirmButton = backupImportModal?.querySelector('[data-backup-confirm]');
      if (confirmButton) { confirmButton.disabled = true; confirmButton.textContent = '导入中...'; }
      try {
        const task_strategy = backupImportModal.querySelector('#backup-task-strategy').value;
        const script_strategy = backupImportModal.querySelector('#backup-script-strategy').value;
        const result = await api.importBackup({ backup: state.pendingImport.backup, passphrase: state.pendingImport.passphrase, task_strategy, script_strategy });
        closeBackupImportModal();
        actions.toast(`备份已导入：新增 ${result.data.created.length} 个任务`, 'success');
        await actions.refreshAll();
      } catch (error) {
        actions.toast(error.message || '备份导入失败', 'error');
        if (confirmButton) { confirmButton.disabled = false; confirmButton.innerHTML = '<i data-lucide="upload" class="icon-sm"></i>确认导入'; icons(confirmButton); }
      }
    }

    async function loadCloudBackupList() {
      const { cloudBackupList } = elements;
      if (!cloudBackupList) return;
      cloudBackupList.innerHTML = '<p class="muted" style="margin:0;">加载中...</p>';
      try {
        const result = await api.listCloudBackups();
        const items = Array.isArray(result.data) ? result.data : [];
        if (!items.length) { cloudBackupList.innerHTML = '<p class="muted" style="margin:0;">还没有远端备份。点「立即备份」上传第一份。</p>'; return; }
        cloudBackupList._items = items;
        cloudBackupList.innerHTML = items.map((item, index) => {
          const when = view.formatCloudBackupTime(item.lastModified);
          return `
            <div class="backup-summary-card" style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
              <div style="min-width:0;">
                <strong style="display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${actions.escapeHtml(item.name)}</strong>
                <span class="muted">${when} · ${actions.formatBytes(item.size)}</span>
              </div>
              <div class="row" style="gap:6px; flex-wrap:nowrap;">
                <button type="button" class="alt btn-with-icon" data-cloud-preview="${index}"><i data-lucide="eye" class="icon-sm"></i> 预览</button>
                <button type="button" class="btn-primary btn-with-icon" data-cloud-restore="${index}"><i data-lucide="download-cloud" class="icon-sm"></i> 恢复</button>
              </div>
            </div>`;
        }).join('');
        icons(cloudBackupList);
      } catch (error) { cloudBackupList.innerHTML = `<p class="muted" style="margin:0;color:#ef4444;">加载失败：${actions.escapeHtml(error.message)}</p>`; }
    }

    function closeCloudRestoreModal() {
      state.pendingCloudRestoreKey = null;
      const { cloudRestoreModal, cloudRestoreMask } = elements;
      if (cloudRestoreModal) { cloudRestoreModal.classList.remove('open'); cloudRestoreModal.hidden = true; cloudRestoreModal.innerHTML = ''; }
      if (cloudRestoreMask) cloudRestoreMask.hidden = true;
    }

    async function previewCloudBackup(key) {
      const { cloudRestoreModal, cloudRestoreMask } = elements;
      if (!cloudRestoreModal) return;
      state.pendingCloudRestoreKey = key;
      try {
        const result = await api.previewCloudBackup({ key });
        const preview = result.data || {};
        cloudRestoreModal.innerHTML = `<div class="modal-panel"><div class="modal-header"><h2>还原云端备份</h2><button type="button" class="icon-btn" data-cloud-restore-close>关闭</button></div><div class="modal-body"><p>快照包含 ${preview.taskCount || 0} 个任务、${preview.scriptCount || 0} 个脚本。</p><div class="backup-import-actions"><button type="button" class="alt" data-cloud-restore-close>取消</button><button type="button" data-cloud-restore-confirm>确认还原</button></div></div></div>`;
        cloudRestoreModal.hidden = false;
        cloudRestoreModal.classList.add('open');
        if (cloudRestoreMask) cloudRestoreMask.hidden = false;
        cloudRestoreModal.querySelectorAll('[data-cloud-restore-close]').forEach((button) => button.addEventListener('click', closeCloudRestoreModal));
        cloudRestoreModal.querySelector('[data-cloud-restore-confirm]')?.addEventListener('click', confirmCloudRestore);
        icons(cloudRestoreModal);
      } catch (error) { actions.toast(error.message || '读取备份预览失败', 'error'); closeCloudRestoreModal(); }
    }

    async function confirmCloudRestore() {
      if (!state.pendingCloudRestoreKey) return;
      actions.dialogConfirm('确认还原该快照？当前任务与配置将被覆盖（原数据保留在 pre-restore 目录），面板可能自动重启。', async () => {
        const key = state.pendingCloudRestoreKey;
        try {
          await api.restoreCloudBackup({ key });
          closeCloudRestoreModal();
          actions.toast('还原完成，请稍候面板重启', 'success');
        } catch (error) { actions.toast(error.message || '还原失败', 'error'); }
      });
    }

    function getStorageCleanupPayload() {
      const retentionDays = Math.min(3650, Math.max(1, Number(elements.storageCleanupDays?.value) || 30));
      const categories = elements.storageCleanupCategories ? Array.from(elements.storageCleanupCategories.querySelectorAll('input[type="checkbox"]:checked')).map((input) => input.value) : [];
      return { retentionDays, categories };
    }

    function renderStorageCleanupResult(data, executed = false) {
      if (!data || !elements.storageCleanupResult) return;
      const categoryText = Object.values(data.byCategory || {}).filter((item) => item.count > 0).map((item) => `${item.label} ${item.count} 项`).join('，');
      const failureText = data.failures?.length ? `；失败 ${data.failures.length} 项` : '';
      elements.storageCleanupResult.textContent = executed ? `清理完成：处理 ${data.count} 项，约 ${actions.formatBytes(data.bytes)}，删除运行记录 ${data.removedRunRows || 0} 条${failureText}` : `预计 ${data.count} 项，约 ${actions.formatBytes(data.bytes)}，运行记录 ${data.runRows || 0} 条${categoryText ? `；${categoryText}` : ''}`;
      if (elements.storageCleanupStatus) elements.storageCleanupStatus.textContent = executed ? `已清理 ${data.count} 项${failureText}` : `预计释放 ${actions.formatBytes(data.bytes)}`;
    }

    async function previewStorageCleanup() {
      const payload = getStorageCleanupPayload();
      if (!payload.categories.length) { actions.toast('请至少选择一个清理类别', 'warn'); return null; }
      elements.storageCleanupPreviewBtn.disabled = true;
      elements.storageCleanupPreviewBtn.textContent = '预览中...';
      try {
        const query = new URLSearchParams({ retentionDays: String(payload.retentionDays), categories: payload.categories.join(',') });
        const result = await api.previewCleanup(query);
        state.cleanupPreview = result.data || null;
        renderStorageCleanupResult(state.cleanupPreview, false);
        if (elements.storageCleanupRunBtn) elements.storageCleanupRunBtn.disabled = !state.cleanupPreview?.count;
        return state.cleanupPreview;
      } catch (error) {
        state.cleanupPreview = null;
        if (elements.storageCleanupRunBtn) elements.storageCleanupRunBtn.disabled = true;
        actions.toast(error.message || '生成清理预览失败', 'error');
        return null;
      } finally {
        elements.storageCleanupPreviewBtn.disabled = false;
        elements.storageCleanupPreviewBtn.innerHTML = '<i data-lucide="search" class="icon-sm"></i> 预览估算';
        icons(elements.storageCleanupPreviewBtn);
      }
    }

    async function runStorageCleanup() {
      const preview = state.cleanupPreview || await previewStorageCleanup();
      if (!preview?.count) { actions.toast('没有符合条件的可清理产物', 'info'); return; }
      actions.dialogConfirm(`确认清理 ${preview.count} 项（约 ${actions.formatBytes(preview.bytes)}）及 ${preview.runRows || 0} 条旧运行记录？此操作不可撤销。`, async () => {
        elements.storageCleanupRunBtn.disabled = true;
        elements.storageCleanupRunBtn.textContent = '清理中...';
        try {
          const result = await api.runCleanup(getStorageCleanupPayload());
          state.cleanupPreview = null;
          renderStorageCleanupResult(result.data || {}, true);
          actions.toast(result.data?.failures?.length ? '清理完成，部分项目处理失败' : '存储清理完成', result.data?.failures?.length ? 'warn' : 'success');
          await actions.refreshAll();
        } catch (error) { actions.toast(error.message || '存储清理失败', 'error'); }
        finally {
          elements.storageCleanupRunBtn.disabled = true;
          elements.storageCleanupRunBtn.innerHTML = '<i data-lucide="trash-2" class="icon-sm"></i> 执行清理';
          icons(elements.storageCleanupRunBtn);
        }
      });
    }

    function mount() {
      if (mounted) return;
      mounted = true;
      on(elements.backupSelectBtn, 'click', () => setBackupSelectionMode(!state.selectionMode));
      on(elements.backupSelectCancelBtn, 'click', () => setBackupSelectionMode(false));
      on(elements.backupSelectAll, 'change', () => {
        if (elements.backupSelectAll.checked) actions.getTasks().forEach((task) => state.selectedTaskIds.add(Number(task.id)));
        else state.selectedTaskIds.clear();
        updateBackupSelectionUi();
        actions.renderTasks?.();
      });
      on(elements.backupExportBtn, 'click', () => {
        if (!state.selectedTaskIds.size) return;
        const ids = [...state.selectedTaskIds];
        if (elements.backupIncludeSecrets?.checked) {
          actions.dialogPassphrase(
            '导出文件将包含所有环境变量的值，整体加密后保存。密码不会被保存，忘记就无法恢复。',
            (passphrase) => startBackupExport(ids, passphrase),
          );
          return;
        }
        startBackupExport(ids, null);
      });
      on(elements.backupImportBtn, 'click', () => elements.backupFileInput?.click());
      on(elements.backupFileInput, 'change', async () => {
        const file = elements.backupFileInput.files?.[0];
        elements.backupFileInput.value = '';
        if (!file) return;
        try { await previewBackupFile(file); }
        catch (error) { actions.toast(error.message || '读取备份文件失败', 'error'); }
      });
      on(elements.backupImportMask, 'click', closeBackupImportModal);
      on(elements.cloudBackupList, 'click', (event) => {
        const items = elements.cloudBackupList._items || [];
        const button = event.target.closest('[data-cloud-preview], [data-cloud-restore]');
        if (!button) return;
        const index = Number(button.dataset.cloudPreview ?? button.dataset.cloudRestore);
        if (items[index]) previewCloudBackup(items[index].key);
      });
      on(elements.cloudRestoreMask, 'click', closeCloudRestoreModal);
      on(elements.storageCleanupCategories, 'change', () => {
        state.cleanupPreview = null;
        if (elements.storageCleanupRunBtn) elements.storageCleanupRunBtn.disabled = true;
        if (elements.storageCleanupStatus) elements.storageCleanupStatus.textContent = '选项已改变，请重新预览';
      });
      on(elements.storageCleanupDays, 'input', () => {
        state.cleanupPreview = null;
        if (elements.storageCleanupRunBtn) elements.storageCleanupRunBtn.disabled = true;
        if (elements.storageCleanupStatus) elements.storageCleanupStatus.textContent = '保留天数已改变，请重新预览';
      });
      on(elements.storageCleanupPreviewBtn, 'click', previewStorageCleanup);
      on(elements.storageCleanupRunBtn, 'click', runStorageCleanup);
      on(elements.cloudBackupForm, 'submit', async (event) => {
        event.preventDefault();
        if (elements.cloudBackupSaveBtn) {
          elements.cloudBackupSaveBtn.disabled = true;
          elements.cloudBackupSaveBtn.textContent = '保存中...';
        }
        try { await saveCloudBackupSettings(); }
        finally {
          if (elements.cloudBackupSaveBtn) {
            elements.cloudBackupSaveBtn.disabled = false;
            elements.cloudBackupSaveBtn.innerHTML = '<i data-lucide="save" class="icon-sm"></i> 保存设置';
            icons();
          }
        }
      });
      on(elements.cloudBackupTestBtn, 'click', testCloudBackupConnection);
      on(elements.cloudBackupClearBtn, 'click', clearCloudBackupSettings);
      on(elements.cloudBackupRunBtn, 'click', runCloudBackupNow);
      on(elements.cloudBackupRefreshBtn, 'click', loadCloudBackupList);
      on(elements.cloudBackupSchedule, 'change', updateCloudBackupTimeFields);
      on(elements.cloudBackupUploadBtn, 'click', () => elements.cloudBackupUploadInput?.click());
      on(elements.cloudBackupUploadInput, 'change', actions.uploadCloudBackupRestore);
      actions.mount?.({ api, view, state });
    }

    function unmount() {
      if (!mounted) return;
      mounted = false;
      listeners.splice(0).forEach(([element, event, handler]) => element.removeEventListener(event, handler));
      actions.unmount?.();
    }

    function load() {
      loadCloudBackupSettings();
      loadCloudBackupList();
    }

    return {
      state, mount, unmount, load, setBackupSelectionMode, updateBackupSelectionUi, toggleBackupTask,
      closeBackupAssetsModal, showBackupAssetsModal, persistExtraPaths, downloadBackup, previewBackupFile,
      startBackupExport, closeBackupImportModal, showBackupImportModal, previewBackupPayload,
      importPendingBackup, loadCloudBackupList, closeCloudRestoreModal, previewCloudBackup,
      confirmCloudRestore, getStorageCleanupPayload, renderStorageCleanupResult, previewStorageCleanup,
      runStorageCleanup,
      setCloudBackupStatus, updateCloudBackupTimeFields, loadCloudBackupSettings,
      saveCloudBackupSettings, testCloudBackupConnection, runCloudBackupNow,
      clearCloudBackupSettings,
    };
  }

  global.BackupStorageController = { create, createState };
})(window);
