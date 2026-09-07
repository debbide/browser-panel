(function exposeSettingsView(global) {
  function renderTelegram(elements, data = {}) {
    const webhookRegistered = data.webhookStatus === 'registered';
    if (elements.status) {
      if (!data.configured) {
        elements.status.textContent = '状态：未配置';
        elements.status.style.color = '#94a3b8';
      } else if (webhookRegistered) {
        elements.status.textContent = '状态：已配置，Webhook 已注册';
        elements.status.style.color = '#86efac';
      } else {
        elements.status.textContent = '状态：已配置，Webhook 未就绪';
        elements.status.style.color = '#fbbf24';
      }
    }
    if (elements.chatId) elements.chatId.value = data.chatId || '';
    if (elements.proxy) elements.proxy.value = data.proxy || '';
    if (elements.webhookUrl) {
      const suggestedOrigin = global.location && global.location.protocol === 'https:' ? global.location.origin : '';
      elements.webhookUrl.value = data.webhookUrl || suggestedOrigin;
    }
    if (elements.botToken) {
      elements.botToken.value = '';
      elements.botToken.setAttribute('aria-describedby', 'tg-token-help');
    }
    if (elements.tokenHelp) {
      elements.tokenHelp.textContent = data.botTokenMasked ? `当前 Token: ${data.botTokenMasked}` : '未设置 Token';
    }
    if (elements.webhookHelp) {
      if (webhookRegistered) {
        elements.webhookHelp.textContent = '已向 Telegram 注册。更换域名、Tunnel 或 Token 后请重新保存。';
      } else if (data.webhookError) {
        elements.webhookHelp.textContent = `Webhook 未就绪：${data.webhookError}`;
      } else {
        elements.webhookHelp.textContent = '保存后自动注册 Telegram 重试按钮的回调地址。';
      }
    }
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
