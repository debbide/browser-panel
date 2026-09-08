(function exposeTaskEditorController(global) {
  function createTaskEditorController({ dependencies, getTasks, getScripts, setScripts }) {
    const escapeHtml = dependencies.escapeHtml;
    let editingId = null;
    let selectedScriptPath = '';
    let mounted = false;

    with (dependencies) {
    function openModal(mode = 'create') {
      modal.classList.add('open');
      modalMask.hidden = false;
      modalTitle.textContent = mode === 'edit' ? '编辑任务' : '新建任务';
      updateScheduleDetailsUI();
      updateConditionFieldsUI();
      updateTaskFormSummary();
      if (typeof window.__onTaskModalShow === 'function') {
        window.__onTaskModalShow();
      }
    }

    function closeModal() {
      modal.classList.remove('open');
      modalMask.hidden = true;
    }

    function resetTaskForm() {
      form.reset();
      editingId = null;
      selectedScriptPath = '';
      saveBtn.textContent = '保存任务';
      formTitle.textContent = '任务信息';
      formHint.textContent = '只填任务名和定时规则。';
      form.elements.name.value = '';
      form.elements.type.value = 'javascript';
      form.elements.script_path.value = '';
      form.elements.timeout_sec.value = '300';
      if (form.elements.browser_profile_id) form.elements.browser_profile_id.value = '';
      if (taskUsePersistentInput) taskUsePersistentInput.value = '0';
      setTaskBrowserProxyInput('');
      setTaskProfileMode('temp');
      if (taskProfileSelect) browserResourcesController.renderProfileOptions(taskProfileSelect, '');
      // form.reset() 会退回带 selected 的那个 option，也就是上次编辑的分组，
      // 所以这里必须重画一遍，让新任务默认落在"未分组"。
      renderTaskGroupOptions(document.getElementById('task-group-select'), '');
      form.elements.enabled.checked = false;
      scheduleModeSelect.value = 'fixed';
      fixedDaysEl.value = '0';
      fixedHoursEl.value = '4';
      fixedMinutesEl.value = '0';
      intervalMinEl.value = '5';
      intervalMaxEl.value = '10';
      intervalUnitEl.value = 'minutes';
      if (dailyTimeStartEl) dailyTimeStartEl.value = '08:00';
      if (dailyTimeEndEl) dailyTimeEndEl.value = '12:00';
      if (dailyDayMinEl) dailyDayMinEl.value = '1';
      if (dailyDayMaxEl) dailyDayMaxEl.value = '1';
      updateScheduleModeUI();
      resetConditionForm();
      syncTaskParamsUI('', {});
    }

    function resetScriptEditor() {
      modalImportForm.reset();
      modalImportForm.elements.type.value = 'javascript';
    }

    function slugifyName(input) {
      return String(input || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
    }

    function getScriptLabel(scriptPath) {
      const value = String(scriptPath || '').trim();
      if (!value) return '未绑定脚本';
      const parts = value.split('/');
      return parts[parts.length - 1] || value;
    }

    function resetAllModalState() {
      resetTaskForm();
      resetScriptEditor();
    }

    function deleteTask(id) {
      dialogConfirm('确定要删除这个任务及其所有运行记录吗？', async () => {
        try {
          await TasksApi.deleteTask(id);
          toast('任务已删除', 'success');
          if (editingId === id) {
            resetAllModalState();
            closeModal();
          }
          await loadTasks();
        } catch (e) {
          toast(e.message || '删除失败', 'error');
        }
      });
    }

    function fillTaskForm(task) {
      form.name.value = task.name;
      form.type.value = TasksModel.resolveTaskType(task.script_path, task.type);
      form.script_path.value = task.script_path;
      form.timeout_sec.value = task.timeout_sec;
      // host2play 默认至少 900；已保存的更大值（如 1200）原样保留
      if (isHost2PlayScript(task.script_path) && Number(form.timeout_sec.value || 0) < 600) {
        form.timeout_sec.value = '900';
      }
      const schedule = parseTaskSchedule(task);
      form.elements.enabled.checked = schedule.enabled;
      scheduleModeSelect.value = schedule.mode;
      fixedDaysEl.value = schedule.fixedDays;
      fixedHoursEl.value = schedule.fixedHours;
      fixedMinutesEl.value = schedule.fixedMinutes;
      intervalMinEl.value = schedule.intervalMin;
      intervalMaxEl.value = schedule.intervalMax;
      intervalUnitEl.value = schedule.intervalUnit;
      if (dailyTimeStartEl) dailyTimeStartEl.value = schedule.dailyTimeStart;
      if (dailyTimeEndEl) dailyTimeEndEl.value = schedule.dailyTimeEnd;
      if (dailyDayMinEl) dailyDayMinEl.value = schedule.dailyDayMin;
      if (dailyDayMaxEl) dailyDayMaxEl.value = schedule.dailyDayMax;
      updateScheduleModeUI();
      fillConditionForm(task);
      // use_persistent=1 → 持久；否则默认临时（含历史任务字段缺失）
      setTaskProfileMode(Number(task.use_persistent) ? 'persistent' : 'temp');
      if (taskProfileSelect) {
        browserResourcesController.renderProfileOptions(taskProfileSelect, task.browser_profile_id || '');
      }
      if (form.elements.browser_profile_id) form.elements.browser_profile_id.value = task.browser_profile_id || '';
      renderTaskGroupOptions(document.getElementById('task-group-select'), task.group_id || '');
      let proxyValue = '';
      let proxyMode = 'inherit';
      let runtimeStack = '';
      if (Array.isArray(task.env) && task.env.length) {
        proxyValue = findManagedEnvValue(task.env, 'BROWSER_PROXY_VALUE') || findManagedEnvValue(task.env, 'BROWSER_PROXY');
        proxyMode = findManagedEnvValue(task.env, 'BROWSER_PROXY_MODE') || (proxyValue ? 'launch' : 'inherit');
        runtimeStack = findManagedEnvValue(task.env, 'BROWSER_RUNTIME_STACK');
        // Keep managed values available to dedicated controls; the editor itself
        // filters them from the ordinary variable list.
        syncTaskParamsUI(task.script_path, task.env);
      } else {
        const params = task.params || parseParamsJson(task.params_json);
        proxyValue = findManagedParamValue(params, 'BROWSER_PROXY_VALUE') || findManagedParamValue(params, 'BROWSER_PROXY');
        proxyMode = findManagedParamValue(params, 'BROWSER_PROXY_MODE') || (proxyValue ? 'launch' : 'inherit');
        runtimeStack = findManagedParamValue(params, 'BROWSER_RUNTIME_STACK');
        // Keep managed values available to dedicated controls; the editor itself
        // filters them from the ordinary variable list.
        syncTaskParamsUI(task.script_path, params);
      }
      setTaskBrowserProxyInput(proxyValue, runtimeStack, proxyMode);
      updateTaskProfileModeUI();
    }

    async function editTask(id) {
      const task = tasksCache.find(item => item.id === id);
      if (!task) return;
      editingId = id;
      fillTaskForm(task);
      selectedScriptPath = task.script_path;
      saveBtn.textContent = `保存修改 #${id}`;
      formTitle.textContent = `正在编辑任务 #${id}`;
      formHint.textContent = task.script_path ? `任务脚本：${getScriptLabel(task.script_path)}` : '只填任务名和定时规则。';
      renderScripts();
      openModal('edit');

      if (task.script_path) {
        try {
          await loadScriptIntoEditor(task.script_path, { preserveHint: true, reopenModal: false });
        } catch (error) {
          toast(error.message || '脚本读取失败', 'error');
        }
      }
    }

    function useScript(scriptPath, type) {
      selectedScriptPath = scriptPath;
      form.script_path.value = scriptPath;
      const resolvedType = TasksModel.resolveTaskType(scriptPath, type);
      form.type.value = resolvedType;
      if (isHost2PlayScript(scriptPath) && Number(form.elements.timeout_sec?.value || 0) < 600) {
        form.elements.timeout_sec.value = '900';
      }
      if (!form.name.value.trim()) form.name.value = scriptPath.split('/').pop().replace(/\.(js|py|php|sh)$/i, '');
      formHint.textContent = `已选脚本：${getScriptLabel(scriptPath)}`;
      // Must pass full env rows (array), not flat params — secrets have empty value in UI
      syncTaskParamsUI(scriptPath, collectSafeCurrentEnvRows());
      renderScripts();
      updateTaskFormSummary();
      openModal(editingId ? 'edit' : 'create');
    }

    function collectSafeCurrentParams() {
      try {
        return collectTaskParamsFromForm();
      } catch {
        return {};
      }
    }

    function getSelectedScript() {
      const scriptPath = scriptSelectEl?.value || '';
      if (!scriptPath) {
        toast('操作前请先在列表中选中一个脚本', 'warn');
        return null;
      }
      return scriptsCache.find(item => item.path === scriptPath) || null;
    }

    async function loadScriptIntoEditor(scriptPath, options = {}) {
      const { preserveHint = false, reopenModal = true } = options;
      const script = scriptsCache.find(item => item.path === scriptPath);
      if (!script) return;
      const response = await fetch(`/${scriptPath.replace(/^\/+/, '')}`);
      if (!response.ok) throw new Error('脚本读取失败');
      const content = await response.text();
      selectedScriptPath = scriptPath;
      form.script_path.value = scriptPath;
      form.type.value = script.type;
      modalImportForm.elements.type.value = script.type;
      modalImportForm.elements.content.value = content;
      if (!preserveHint) formHint.textContent = `正在编辑脚本：${getScriptLabel(scriptPath)}`;
      renderScripts();
      updateTaskFormSummary();
      if (reopenModal) openModal(editingId ? 'edit' : 'create');
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!form.elements.script_path.value) {
        toast('请先在下方选择或导入要运行的脚本文件', 'warn');
        return;
      }
      let env;
      let params;
      try {
        env = collectTaskEnvFromForm();
        params = collectTaskParamsFromForm();
      } catch (error) {
        toast(error.message || 'Invalid task env', 'error');
        return;
      }

      const schedule = buildSchedulePayloadFromForm();
      let conditionPayload;
      try {
        conditionPayload = buildConditionPayloadFromForm();
      } catch (error) {
        toast(error.message || '条件配置无效', 'error');
        return;
      }
      const formData = new FormData(form);
      const payload = Object.fromEntries(formData.entries());
      Object.assign(payload, schedule, conditionPayload);
      // FormData may stringify checkboxes; force boolean flags from builders
      payload.enabled = Boolean(schedule.enabled);
      payload.condition_enabled = Boolean(conditionPayload.condition_enabled);
      payload.type = TasksModel.resolveTaskType(payload.script_path, payload.type);
      const existingTask = editingId ? getTasks().find((task) => task.id === editingId) : null;
      payload.use_browser = Boolean(existingTask && existingTask.use_browser);
      // 默认临时；仅当用户明确选「持久配置」才写 use_persistent=1
      const wantPersistent = !isTaskTempProfileMode();
      payload.use_persistent = wantPersistent;
      payload.timeout_sec = Number(payload.timeout_sec || 300);
      if (isHost2PlayScript(payload.script_path) && payload.timeout_sec < 600) {
        payload.timeout_sec = 900;
      }
      payload.browser_profile_id = taskProfileSelect && taskProfileSelect.value ? Number(taskProfileSelect.value) : null;
      payload.group_id = payload.group_id ? Number(payload.group_id) : null;
      // 临时/持久只走 use_persistent 字段，不再写入可见 env 列表
      const envByName = new Map(env.map((e) => [e.name, e]));
      deleteManagedMapKeys(envByName, [
        'USE_TEMP_PROFILE',
        'BROWSER_PROXY',
        'BROWSER_RUNTIME_STACK',
        'BROWSER_PROXY_MODE',
        'BROWSER_PROXY_VALUE',
        'BROWSER_RUYI_FPFILE',
        ...PROXY_ENV_ALIAS_KEYS,
        'BROWSER_LOCALE',
        'BROWSER_TIMEZONE',
      ]);

      // 全局 Telegram 开关：只存内部键，列表展示时会过滤掉
      const useGlobalTg = taskUseGlobalTelegram ? taskUseGlobalTelegram.checked : true;
      envByName.set('USE_GLOBAL_TELEGRAM', {
        name: 'USE_GLOBAL_TELEGRAM',
        value: useGlobalTg ? '1' : '0',
        is_secret: 0,
      });
      if (useGlobalTg) {
        for (const k of ['TG_TOKEN', 'TG_BOT_TOKEN', 'TG_CHAT_ID', 'CHAT_ID', 'TG_PROXY', 'TG_PROXY_URL']) {
          const cur = envByName.get(k);
          if (cur && !String(cur.value || '').trim()) envByName.delete(k);
        }
      }

      // Dedicated browser controls are stored as canonical, non-secret env entries.
      const taskBrowserProxy = getTaskBrowserProxyFromForm();
      for (const [name, value] of [
        ['BROWSER_RUNTIME_STACK', taskBrowserProxy.runtimeStack],
        ['BROWSER_PROXY_MODE', taskBrowserProxy.mode],
        ['BROWSER_PROXY_VALUE', taskBrowserProxy.value],
      ]) {
        if (value) {
          envByName.set(name, { name, value, is_secret: 0 });
        }
      }

      payload.env = [...envByName.values()].filter((e) => {
        const n = String(e.name || '').toUpperCase();
        return n !== 'USE_TEMP_PROFILE';
      });
      payload.params = {
        ...params,
        USE_GLOBAL_TELEGRAM: useGlobalTg ? '1' : '0',
      };
      deleteManagedObjectKeys(payload.params, [
        'USE_TEMP_PROFILE',
        'BROWSER_PROXY',
        'BROWSER_RUNTIME_STACK',
        'BROWSER_PROXY_MODE',
        'BROWSER_PROXY_VALUE',
        'BROWSER_RUYI_FPFILE',
        'BROWSER_LOCALE',
        'BROWSER_TIMEZONE',
      ]);
      if (taskBrowserProxy.runtimeStack) payload.params.BROWSER_RUNTIME_STACK = taskBrowserProxy.runtimeStack;
      if (taskBrowserProxy.mode) payload.params.BROWSER_PROXY_MODE = taskBrowserProxy.mode;
      if (taskBrowserProxy.value) payload.params.BROWSER_PROXY_VALUE = taskBrowserProxy.value;
      await TasksApi.saveTask(editingId, payload);
      toast(editingId ? '任务已更新' : '任务已成功添加', 'success');
      resetAllModalState();
      closeModal();
      await loadTasks();
    });

    async function saveScriptFromForm(sourceForm) {
      const formData = new FormData(sourceForm);
      const type = String(formData.get('type') || 'javascript');
      const content = String(formData.get('content') || '');
      const extensionByType = {
        javascript: '.js',
        python: '.py',
        php: '.php',
        shell: '.sh',
      };
      const extension = extensionByType[type] || '.js';
      // Prefer currently selected/bound script name so re-import overwrites the same file
      const currentBound = String(form.elements.script_path?.value || selectedScriptPath || '').replace(/\\/g, '/');
      let name = '';
      if (currentBound.startsWith('tasks/')) {
        name = pathBasename(currentBound);
      }
      if (!name) {
        const taskName = String(form.elements.name.value || '').trim();
        if (!taskName) throw new Error('请先填写任务名，或先选中要覆盖的脚本');
        const baseName = slugifyName(taskName);
        name = baseName;
      }
      // Always replace the existing suffix so a bound file with any extension can
      // be converted to the selected interpreter without sending an invalid name.
      name = name.replace(/\.[^./]+$/i, '') + extension;
      return fetchJson('/api/scripts/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type, content, overwrite: true }),
      });
    }

    function pathBasename(p) {
      const s = String(p || '').replace(/\\/g, '/');
      const i = s.lastIndexOf('/');
      return i >= 0 ? s.slice(i + 1) : s;
    }

    async function deleteSelectedScript() {
      const script = getSelectedScript();
      if (!script) return;
      dialogConfirm(`确定删除脚本「${script.name}」？\n（有任务绑定该脚本时会拒绝删除）`, async () => {
        try {
          await fetchJson('/api/scripts', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: script.path }),
          });
          if (selectedScriptPath === script.path) {
            selectedScriptPath = '';
            if (form.elements.script_path) form.elements.script_path.value = '';
          }
          await loadScripts();
          toast('脚本已删除', 'success');
        } catch (error) {
          toast(error.message || '删除失败', 'error');
        }
      });
    }

    modalImportForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (modalImportBtn) {
        modalImportBtn.disabled = true;
        modalImportBtn.textContent = '保存中...';
      }

      try {
        const result = await saveScriptFromForm(modalImportForm);
        selectedScriptPath = result.data.path;
        form.script_path.value = result.data.path;
        form.type.value = result.data.type;
        // BUGFIX: previously used collectSafeCurrentParams() (flat object). Secret values are
        // always '' in the UI, so entriesFromParamsObject dropped PASSWORD_* etc. Then Save
        // called replaceEnvEntries and deleted those keys from DB. Keep full env rows instead.
        syncTaskParamsUI(result.data.path, collectSafeCurrentEnvRows());
        if (!form.name.value.trim()) form.name.value = result.data.name.replace(/\.(js|py|php|sh)$/i, '');
        updateTaskFormSummary();
        openModal(editingId ? 'edit' : 'create');
        formHint.textContent = result.data.overwritten
          ? `已覆盖脚本：${getScriptLabel(result.data.path)}`
          : `已保存脚本：${getScriptLabel(result.data.path)}`;
        try {
          await loadScripts();
        } catch (error) {
          scriptsCache = [
            ...scriptsCache.filter(item => item.path !== result.data.path),
            { name: result.data.name, path: result.data.path, type: result.data.type },
          ];
        }
        renderScripts();
        toast(result.data.overwritten ? '脚本已覆盖保存' : '脚本已导入', 'success');
      } catch (error) {
        toast(error.message || '脚本保存失败', 'error');
      } finally {
        if (modalImportBtn) {
          modalImportBtn.disabled = false;
          modalImportBtn.textContent = '导入脚本';
        }
      }
    });

    resetBtn.addEventListener('click', () => { resetAllModalState(); closeModal(); });
    modalCloseBtn.addEventListener('click', closeModal);
    modalMask.addEventListener('click', closeModal);
    refreshScriptsModalBtn.addEventListener('click', loadScripts);
    addTaskBtn.addEventListener('click', () => { resetAllModalState(); renderScripts(); openModal('create'); });
    useScriptBtn.addEventListener('click', () => {
      const script = getSelectedScript();
      if (!script) return;
      useScript(script.path, script.type);
    });
    editScriptBtn.addEventListener('click', async () => {
      const script = getSelectedScript();
      if (!script) return;
      try {
        await loadScriptIntoEditor(script.path);
      } catch (error) {
        toast(error.message || '脚本读取失败', 'error');
      }
    });
    const deleteScriptBtn = document.getElementById('delete-script-btn');
    if (deleteScriptBtn) {
      deleteScriptBtn.addEventListener('click', () => {
        deleteSelectedScript();
      });
    }
    scheduleModeSelect.addEventListener('change', () => {
      updateScheduleModeUI();
      updateTaskFormSummary();
    });

    const scheduleEnabledEl = form?.elements?.enabled || document.getElementById('schedule-enabled');
    if (scheduleEnabledEl) {
      scheduleEnabledEl.addEventListener('change', updateScheduleDetailsUI);
    }

    if (conditionEnabledEl) {
      conditionEnabledEl.addEventListener('change', updateConditionFieldsUI);
    }
    if (conditionTypeEl) {
      conditionTypeEl.addEventListener('change', updateConditionFieldsUI);
    }
    [
      conditionWindowValueEl,
      conditionWindowUnitEl,
      conditionJitterMinEl,
      conditionJitterMaxEl,
      conditionJitterUnitEl,
    ].forEach((el) => {
      if (!el) return;
      el.addEventListener('input', updateRemainingThresholdPreview);
      el.addEventListener('change', updateRemainingThresholdPreview);
    });

    // Keep footer summary in sync with common fields
    ['name', 'timeout_sec'].forEach((name) => {
      const el = form?.elements?.[name];
      if (el) el.addEventListener('input', updateTaskFormSummary);
    });

    if (conditionTestBtn) {
      conditionTestBtn.addEventListener('click', async () => {
        try {
          let conditionPayload;
          try {
            // Force enabled for test payload construction
            const was = conditionEnabledEl ? conditionEnabledEl.checked : true;
            if (conditionEnabledEl) conditionEnabledEl.checked = true;
            try {
              conditionPayload = buildConditionPayloadFromForm();
            } finally {
              if (conditionEnabledEl) conditionEnabledEl.checked = was;
            }
          } catch (err) {
            // allow test with URL even if checkbox off (http only)
            if (getConditionType() === 'remaining_callback') throw err;
            const url = String(conditionUrlEl?.value || '').trim();
            if (!url) throw err;
            conditionPayload = {
              condition_enabled: true,
              condition: {
                type: 'http_check',
                check_interval_sec: unitValueToSec(conditionCheckIntervalEl?.value || 5, conditionCheckUnitEl?.value || 'minutes', 30),
                cooldown_sec: unitValueToSec(conditionCooldownEl?.value || 10, conditionCooldownUnitEl?.value || 'minutes', 0),
                config: {
                  url,
                  method: conditionMethodEl?.value || 'GET',
                  timeout_ms: Math.min(60000, Math.max(1000, (Number(conditionTimeoutEl?.value) || 10) * 1000)),
                  success_statuses: String(conditionSuccessStatusesEl?.value || '200-399').trim() || '200-399',
                  expect_body_includes: String(conditionExpectBodyEl?.value || '').trim(),
                  proxy: String(conditionProxyEl?.value || '').trim(),
                },
              },
            };
          }
          if (!conditionPayload.condition) {
            toast(getConditionType() === 'remaining_callback' ? '请先配置剩余时间回调' : '请先填写检测 URL', 'warn');
            return;
          }
          conditionTestBtn.disabled = true;
          conditionTestBtn.textContent = '检测中...';
          const body = { condition: conditionPayload.condition };
          let result;
          if (editingId) {
            result = await TasksApi.testCondition(editingId, body.condition);
          } else {
            // create mode: temporary evaluate via a lightweight path — call types not available;
            // reuse test endpoint requires id; fall back to fetch probe message
            toast('请先保存任务后再测试，或保存后编辑里点测试', 'warn');
            return;
          }
          const triggerHint = result.shouldTrigger ? '（将触发任务）' : '（不触发）';
          toast(`${result.status}: ${result.detail || ''} ${triggerHint}`, result.shouldTrigger ? 'warn' : 'success');
          if (conditionLastStatusText) {
            conditionLastStatusText.textContent = `最近：${result.status}${result.detail ? ` · ${result.detail}` : ''}`;
          }
        } catch (error) {
          toast(error.message || '检测失败', 'error');
        } finally {
          if (conditionTestBtn) {
            conditionTestBtn.disabled = false;
            conditionTestBtn.innerHTML = '<i data-lucide="radar" class="icon-sm"></i> 测试检测';
            if (window.lucide) window.lucide.createIcons();
          }
        }
      });
    }
    fixedDaysEl.addEventListener('input', updateFixedSummary);
    fixedHoursEl.addEventListener('input', updateFixedSummary);
    fixedMinutesEl.addEventListener('input', updateFixedSummary);
    intervalMinEl.addEventListener('input', updateIntervalSummary);
    intervalMaxEl.addEventListener('input', updateIntervalSummary);
    intervalUnitEl.addEventListener('change', updateIntervalSummary);
    dailyTimeStartEl?.addEventListener('input', updateDailyWindowSummary);
    dailyTimeEndEl?.addEventListener('input', updateDailyWindowSummary);
    dailyDayMinEl?.addEventListener('input', updateDailyWindowSummary);
    dailyDayMaxEl?.addEventListener('input', updateDailyWindowSummary);

      function mount() {
        if (mounted) return;
        mounted = true;
      }

      function isSelectedScript(scriptPath) {
        return selectedScriptPath === scriptPath;
      }

      global.deleteTask = deleteTask;
      global.editTask = editTask;
      global.useScript = useScript;
      global.loadScriptIntoEditor = loadScriptIntoEditor;

      return { mount, reset: resetAllModalState, closeModal, isSelectedScript, escapeHtml };
    }
  }

  global.TaskEditorController = { createTaskEditorController };
})(window);
