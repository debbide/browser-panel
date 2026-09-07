(function exposeBrowserResourcesController(global) {
  function createState(initial = {}) {
    return {
      browserSessionOpen: false,
      browserOpenedAt: null,
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

    function renderBrowserControls() {
      if (elements.openBrowserBtn) {
        elements.openBrowserBtn.disabled = state.browserSessionOpen;
        elements.openBrowserBtn.innerHTML = state.browserSessionOpen
          ? '<i data-lucide="monitor-check" class="icon-sm"></i> 已启动'
          : '<i data-lucide="monitor-play" class="icon-sm"></i> 启动';
        actions.createIcons?.(elements.openBrowserBtn);
      }
      if (elements.closeBrowserBtn) {
        elements.closeBrowserBtn.disabled = !state.browserSessionOpen;
        elements.closeBrowserBtn.innerHTML = state.browserSessionOpen
          ? '<i data-lucide="monitor-stop" class="icon-sm"></i> 关闭浏览器'
          : '<i data-lucide="monitor-off" class="icon-sm"></i> 未启动';
        actions.createIcons?.(elements.closeBrowserBtn);
      }
      if (elements.addTaskBtn) {
        elements.addTaskBtn.title = state.browserSessionOpen && state.browserOpenedAt
          ? `浏览器已打开：${actions.shortTime(state.browserOpenedAt)}`
          : '';
      }
    }

    async function loadBrowserStatus() {
      const data = await api.loadBrowser();
      state.browserSessionOpen = Boolean(data.data?.open);
      state.browserOpenedAt = data.data?.openedAt || null;
      renderBrowserControls();
    }

    async function openBrowserSession() {
      if (elements.openBrowserBtn) elements.openBrowserBtn.disabled = true;
      try {
        const profileId = elements.browserProfileSelect ? elements.browserProfileSelect.value : '';
        actions.toast('正在启动浏览器…', 'info');
        await api.openBrowser({ profile_id: profileId || null });
        await loadBrowserStatus();
        actions.toast('浏览器已成功启动（常驻，手动关闭或点「关闭浏览器」）', 'success');
      } catch (error) {
        await loadBrowserStatus().catch(() => {});
        actions.toast(error.message || '浏览器启动失败', 'error');
      } finally {
        renderBrowserControls();
      }
    }

    async function closeBrowserSession() {
      try {
        await api.closeBrowser();
        await loadBrowserStatus();
        actions.toast('浏览器会话已安全关闭', 'success');
      } catch (error) {
        actions.toast(error.message || '浏览器关闭失败', 'error');
      }
    }

    function mount() {
      if (mounted) return;
      mounted = true;
      on(elements.openBrowserBtn, 'click', openBrowserSession);
      on(elements.closeBrowserBtn, 'click', closeBrowserSession);
      actions.mount?.({ api, view });
    }

    function unmount() {
      if (!mounted) return;
      listeners.splice(0).forEach(([element, event, handler]) => element.removeEventListener(event, handler));
      mounted = false;
      actions.unmount?.();
    }

    function load() {
      return actions.load?.();
    }

    return {
      state,
      mount,
      unmount,
      load,
      renderBrowserControls,
      loadBrowserStatus,
      openBrowserSession,
      closeBrowserSession,
    };
  }

  global.BrowserResourcesController = { createState, create };
})(window);
