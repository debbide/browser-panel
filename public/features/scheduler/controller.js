(function exposeSchedulerController(global) {
  function create({ api, view, elements, toast, createIcons }) {
    let mounted = false;

    function setStatus(text, color) {
      if (!elements.statusText) return;
      elements.statusText.textContent = text;
      if (color) elements.statusText.style.color = color;
    }

    async function load() {
      if (!elements.form) return;
      try {
        const res = await api.load();
        const data = res.data || {};
        if (elements.allowParallel) {
          elements.allowParallel.checked = Boolean(data.allowParallel);
        }
        const mode = data.allowParallel ? '浏览器任务并行' : '浏览器任务串行（默认）';
        const running = Array.isArray(data.runningTaskIds) ? data.runningTaskIds : [];
        const runningText = running.length ? `，当前运行：#${running.join(', #')}` : '，当前空闲';
        setStatus(`状态：${mode}${runningText}`, '#94a3b8');
      } catch (error) {
        setStatus('状态：加载失败', '#ef4444');
        console.error('Failed to load scheduler settings:', error);
      }
    }

    async function save() {
      const allowParallel = Boolean(elements.allowParallel && elements.allowParallel.checked);
      await api.save({ allowParallel });
      await load();
    }

    async function handleSubmit(event) {
      event.preventDefault();
      if (elements.saveBtn) {
        elements.saveBtn.disabled = true;
        elements.saveBtn.textContent = '保存中...';
      }
      try {
        await save();
        toast('调度设置已保存', 'success');
      } catch (error) {
        toast(error.message || '保存调度设置失败', 'error');
      } finally {
        if (elements.saveBtn) {
          elements.saveBtn.disabled = false;
          elements.saveBtn.innerHTML = '<i data-lucide="save" class="icon-sm"></i> 保存调度设置';
          if (createIcons) createIcons();
        }
      }
    }

    function mount() {
      if (mounted) return;
      mounted = true;
      if (elements.form) elements.form.addEventListener('submit', handleSubmit);
    }

    function unmount() {
      if (!mounted) return;
      mounted = false;
      if (elements.form) elements.form.removeEventListener('submit', handleSubmit);
    }

    return { mount, unmount, load };
  }

  global.SchedulerController = { create };
})(window);
