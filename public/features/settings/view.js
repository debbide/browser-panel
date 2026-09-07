(function exposeSettingsView(global) {
  function renderTelegram(elements, data = {}) {
    const config = data.config || {};
    if (elements.status) elements.status.textContent = data.enabled ? '状态：已启用' : '状态：未启用';
    if (elements.botToken) elements.botToken.value = '';
    if (elements.chatId) elements.chatId.value = config.chatId || '';
    if (elements.proxy) elements.proxy.value = config.proxy || '';
    if (elements.webhookUrl) elements.webhookUrl.value = config.webhookUrl || '';
  }

  function collectTelegram(elements) {
    return {
      botToken: elements.botToken ? elements.botToken.value.trim() : '',
      chatId: elements.chatId ? elements.chatId.value.trim() : '',
      proxy: elements.proxy ? elements.proxy.value.trim() : '',
      webhookUrl: elements.webhookUrl ? elements.webhookUrl.value.trim() : '',
    };
  }

  function renderVisionChannels(view, channels) {
    view.render(Array.isArray(channels) ? channels : []);
  }

  function collectVisionChannels(view) {
    return view.collect();
  }

  function renderGlobalEnv(editor, entries) {
    editor.setRows(Array.isArray(entries) ? entries : []);
  }

  function collectGlobalEnv(editor) {
    return editor.collect();
  }

  global.SettingsView = {
    renderTelegram,
    collectTelegram,
    renderVisionChannels,
    collectVisionChannels,
    renderGlobalEnv,
    collectGlobalEnv,
  };
})(window);
