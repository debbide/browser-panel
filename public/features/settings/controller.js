(function exposeSettingsController(global) {
  function create(deps = {}) {
    const api = deps.api || {};
    const view = deps.view || {};
    const actions = deps.actions || {};
    let mounted = false;
    const elements = deps.elements || {};
    const toast = deps.toast || (() => {});

    async function loadTelegram() {
      try {
        const response = await api.loadTelegram();
        view.renderTelegram(elements.telegram || {}, response.data || {});
      } catch (error) {
        const status = elements.telegram && elements.telegram.status;
        if (status) status.textContent = '状态：加载失败';
        if (global.console) global.console.error('Failed to load Telegram settings:', error);
      }
    }

    async function saveTelegram(event) {
      event.preventDefault();
      const telegram = elements.telegram || {};
      const button = telegram.saveButton;
      if (button) {
        button.disabled = true;
        button.textContent = '保存中...';
      }
      try {
        const response = await api.saveTelegram(view.collectTelegram(telegram));
        const settings = response.data || {};
        if (settings.webhookStatus === 'registered') {
          toast('Telegram 设置已保存，Webhook 已注册', 'success');
        } else {
          toast(`Telegram 设置已保存，Webhook 未就绪：${settings.webhookError || '请检查公网 HTTPS 地址'}`, 'error');
        }
        await loadTelegram();
      } catch (error) {
        toast(error.message || '保存设置遇到了错误', 'error');
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = '保存设置';
        }
      }
    }

    async function testTelegram() {
      const telegram = elements.telegram || {};
      const button = telegram.testButton;
      if (button) {
        button.disabled = true;
        button.textContent = '发送中...';
      }
      try {
        await api.testTelegram();
        toast('一条测试用推送已发往你的 Telegram', 'success');
      } catch (error) {
        toast(error.message || '发送推送到 Telegram 失败', 'error');
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = '发送测试消息';
        }
      }
    }

    async function loadVision() {
      const vision = elements.vision || {};
      if (!vision.form) return;
      try {
        const response = await api.loadVision();
        const data = response.data || {};
        view.renderVisionChannels(vision, data.channelList);
        vision.updateStatus?.(data);
      } catch (error) {
        if (vision.status) {
          vision.status.textContent = 'Status: load failed';
          vision.status.style.color = '#ef4444';
        }
        global.console?.error('Failed to load vision settings:', error);
      }
    }

    async function saveVision(event) {
      event.preventDefault();
      const vision = elements.vision || {};
      const channelList = view.collectVisionChannels(vision);
      if (!channelList.length) {
        toast('请至少配置一个视觉通道', 'error');
        return;
      }
      for (let index = 0; index < channelList.length; index += 1) {
        const channel = channelList[index];
        if (!channel.baseUrl || !channel.model) {
          toast(`${index === 0 ? '主通道' : `备用通道 ${index}`} 需要填写 Base URL 和 Model`, 'error');
          return;
        }
      }
      const button = vision.saveButton;
      if (button) {
        button.disabled = true;
        button.textContent = 'Saving...';
      }
      try {
        await api.saveVision({ channelList });
        toast('Vision settings saved', 'success');
        await loadVision();
      } catch (error) {
        toast(error.message || 'Failed to save vision settings', 'error');
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = 'Save Vision Settings';
        }
      }
    }

    function testVision() {
      elements.vision?.openTestModal?.();
    }

    function mount() {
      if (mounted) return;
      mounted = true;
      const telegram = elements.telegram || {};
      const vision = elements.vision || {};
      if (telegram.form) telegram.form.addEventListener('submit', saveTelegram);
      if (telegram.testButton) telegram.testButton.addEventListener('click', testTelegram);
      if (vision.form) vision.form.addEventListener('submit', saveVision);
      if (vision.testButton) vision.testButton.addEventListener('click', testVision);
      if (typeof actions.mount === 'function') actions.mount({ api, view });
    }

    function unmount() {
      if (!mounted) return;
      mounted = false;
      const telegram = elements.telegram || {};
      const vision = elements.vision || {};
      if (telegram.form) telegram.form.removeEventListener('submit', saveTelegram);
      if (telegram.testButton) telegram.testButton.removeEventListener('click', testTelegram);
      if (vision.form) vision.form.removeEventListener('submit', saveVision);
      if (vision.testButton) vision.testButton.removeEventListener('click', testVision);
      if (typeof actions.unmount === 'function') actions.unmount();
    }

    async function load() {
      await loadTelegram();
      await loadVision();
      if (typeof actions.load === 'function') return actions.load({ api, view });
      return undefined;
    }

    return { mount, unmount, load };
  }

  global.SettingsController = { create };
})(window);
