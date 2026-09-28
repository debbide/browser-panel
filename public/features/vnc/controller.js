(function exposeVncController(global) {
  // noVNC 客户端页：同源直连面板的 /vnc/websockify，encrypt 按页面协议自动选 wss/ws。
  const VNC_PAGE_URL = '/vnc/vnc.html?autoconnect=true&path=vnc/websockify';

  function create({ api, elements, toast, createIcons }) {
    let mounted = false;

    function setStatus(text, color) {
      if (!elements.statusText) return;
      elements.statusText.textContent = text;
      if (color) elements.statusText.style.color = color;
    }

    function refreshOpenButton(enabled) {
      if (!elements.openBtn) return;
      elements.openBtn.hidden = !enabled;
      if (createIcons) createIcons();
    }

    async function load() {
      try {
        const res = await api.load();
        const data = res.data || {};
        if (elements.enabled) elements.enabled.checked = Boolean(data.enabled);
        if (elements.host) elements.host.value = data.host || '';
        if (elements.port) elements.port.value = data.port || '';
        setStatus(
          data.enabled
            ? `状态：已启用（${data.host}:${data.port}），主页右上角可进入远程桌面`
            : '状态：未启用',
          '#94a3b8',
        );
        refreshOpenButton(Boolean(data.enabled));
      } catch (error) {
        setStatus('状态：加载失败', '#ef4444');
        console.error('Failed to load vnc settings:', error);
      }
    }

    function collect() {
      return {
        enabled: Boolean(elements.enabled && elements.enabled.checked),
        host: elements.host ? elements.host.value.trim() : '',
        port: elements.port ? elements.port.value.trim() : '',
      };
    }

    async function handleSubmit(event) {
      event.preventDefault();
      if (elements.saveBtn) {
        elements.saveBtn.disabled = true;
        elements.saveBtn.textContent = '保存中...';
      }
      try {
        await api.save(collect());
        await load();
        toast('远程桌面设置已保存', 'success');
      } catch (error) {
        toast(error.message || '保存远程桌面设置失败', 'error');
      } finally {
        if (elements.saveBtn) {
          elements.saveBtn.disabled = false;
          elements.saveBtn.innerHTML = '<i data-lucide="save" class="icon-sm"></i> 保存远程桌面设置';
          if (createIcons) createIcons();
        }
      }
    }

    async function handleTest() {
      if (elements.testBtn) {
        elements.testBtn.disabled = true;
        elements.testBtn.textContent = '测试中...';
      }
      setStatus('状态：正在测试连接...', '#94a3b8');
      try {
        const res = await api.test(collect());
        const data = res.data || {};
        if (data.ok) {
          setStatus(`状态：连接成功（${data.host}:${data.port}，${data.latencyMs}ms）`, '#86efac');
        } else {
          setStatus(`状态：连接失败（${data.host}:${data.port}）：${data.error || '未知错误'}`, '#ef4444');
        }
      } catch (error) {
        setStatus(`状态：测试失败：${error.message || '未知错误'}`, '#ef4444');
      } finally {
        if (elements.testBtn) {
          elements.testBtn.disabled = false;
          elements.testBtn.innerHTML = '<i data-lucide="plug-zap" class="icon-sm"></i> 测试连接';
          if (createIcons) createIcons();
        }
      }
    }

    function handleOpen() {
      global.open(VNC_PAGE_URL, '_blank', 'noopener');
    }

    function mount() {
      if (mounted) return;
      mounted = true;
      if (elements.form) elements.form.addEventListener('submit', handleSubmit);
      if (elements.testBtn) elements.testBtn.addEventListener('click', handleTest);
      if (elements.openBtn) elements.openBtn.addEventListener('click', handleOpen);
    }

    function unmount() {
      if (!mounted) return;
      mounted = false;
      if (elements.form) elements.form.removeEventListener('submit', handleSubmit);
      if (elements.testBtn) elements.testBtn.removeEventListener('click', handleTest);
      if (elements.openBtn) elements.openBtn.removeEventListener('click', handleOpen);
    }

    return { mount, unmount, load };
  }

  global.VncController = { create };
})(window);
