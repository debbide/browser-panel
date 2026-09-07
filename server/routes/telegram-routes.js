function createTelegramRouteHandlers({
  db,
  sendTelegramTestMessage,
  isTelegramConfigured,
  maskTelegramToken,
  answerTelegramCallback,
  buildRetryStartedMessage,
  normalizeWebhookPublicUrl,
  registerTelegramWebhook,
  sendTelegramMessage,
  triggerTaskExecutionInBackground,
}) {
  function normalizeSettingsResponse() {
    const settings = db.getTelegramSettings();
    return {
      configured: isTelegramConfigured(settings),
      chatId: settings.chatId || '',
      botTokenMasked: maskTelegramToken(settings.botToken),
      proxy: settings.proxy || '',
      webhookUrl: settings.webhookUrl || '',
      webhookStatus: settings.webhookStatus || (isTelegramConfigured(settings) ? 'needs_url' : 'unconfigured'),
      webhookError: settings.webhookError || '',
    };
  }

  function resolveSettingValue(incomingValue, existingValue) {
    const value = String(incomingValue || '').trim();
    if (value) return value;
    return existingValue || null;
  }

  function inferWebhookOrigin(req) {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || '')
      .split(',')[0].trim().toLowerCase();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
      .split(',')[0].trim();
    if (proto !== 'https' || !host) return '';
    try {
      return normalizeWebhookPublicUrl(`https://${host}`);
    } catch {
      return '';
    }
  }

  function parseRetryCallbackData(value) {
    const match = /^retry:(\d+):(\d+)$/.exec(String(value || '').trim());
    if (!match) return null;
    return { taskId: Number(match[1]), runId: Number(match[2]) };
  }

  function isConfiguredChat(chatId) {
    const settings = db.getTelegramSettings();
    return Boolean(settings.chatId) && String(settings.chatId) === String(chatId);
  }

  function getSettings(req, res) {
    res.json({ data: normalizeSettingsResponse() });
  }

  async function saveSettings(req, res) {
    try {
      const payload = req.body || {};
      const current = db.getTelegramSettings();
      const botToken = resolveSettingValue(payload.botToken, current.botToken);
      const chatId = resolveSettingValue(payload.chatId, current.chatId);

      if (!botToken || !chatId) {
        return res.status(400).json({ message: 'Bot Token and Chat ID are required' });
      }

      let webhookUrl = '';
      try {
        const rawWebhookUrl = payload.webhookUrl === undefined
          ? (current.webhookUrl || inferWebhookOrigin(req))
          : payload.webhookUrl;
        webhookUrl = normalizeWebhookPublicUrl(rawWebhookUrl);
      } catch (error) {
        return res.status(400).json({ message: error.message || 'Webhook URL is invalid' });
      }

      db.setSetting('telegram_bot_token', botToken);
      db.setSetting('telegram_chat_id', chatId);
      if (payload.proxy !== undefined) {
        db.setSetting('telegram_proxy', String(payload.proxy).trim());
      }
      db.setSetting('telegram_webhook_url', webhookUrl);

      if (!webhookUrl) {
        db.setSetting('telegram_webhook_status', 'needs_url');
        db.setSetting('telegram_webhook_error', '请填写公网 HTTPS 地址后保存，面板会自动注册 Webhook');
        return res.json({ data: normalizeSettingsResponse() });
      }

      try {
        await registerTelegramWebhook(botToken, webhookUrl);
        db.setSetting('telegram_webhook_status', 'registered');
        db.setSetting('telegram_webhook_error', '');
        return res.json({ data: normalizeSettingsResponse() });
      } catch (error) {
        const message = String(error.message || 'Telegram Webhook 注册失败')
          .replace(new RegExp(botToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<redacted>')
          .slice(0, 500);
        db.setSetting('telegram_webhook_status', 'error');
        db.setSetting('telegram_webhook_error', message);
        return res.json({ data: normalizeSettingsResponse() });
      }
    } catch (error) {
      return res.status(500).json({ message: error.message || '保存 Telegram 设置失败' });
    }
  }

  async function testSettings(req, res) {
    try {
      await sendTelegramTestMessage();
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({ message: error.message || 'Failed to send test message' });
    }
  }

  async function receiveWebhook(req, res) {
    const settings = db.getTelegramSettings();
    if (!settings.botToken || req.params.token !== settings.botToken) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const callbackQuery = req.body?.callback_query;
    if (!callbackQuery) return res.json({ ok: true });

    const callbackQueryId = callbackQuery.id;
    const chatId = callbackQuery.message?.chat?.id;
    const parsed = parseRetryCallbackData(callbackQuery.data);
    console.log(`[telegram] callback received chat=${chatId || '-'} action=${parsed ? 'retry' : 'unknown'}`);

    try {
      if (!isConfiguredChat(chatId)) {
        await answerTelegramCallback(settings.botToken, callbackQueryId, '当前 Chat 未被授权执行任务', { showAlert: true });
        return res.json({ ok: true });
      }
      if (!parsed) {
        await answerTelegramCallback(settings.botToken, callbackQueryId, '无法识别这个操作', { showAlert: true });
        return res.json({ ok: true });
      }

      const task = db.getTask(parsed.taskId);
      const run = db.getRun(parsed.runId);
      if (!task || !run || run.task_id !== parsed.taskId || run.status !== 'failed' || Number(run.retryable || 0) !== 1) {
        await answerTelegramCallback(settings.botToken, callbackQueryId, '这次失败已经不可重试', { showAlert: true });
        return res.json({ ok: true });
      }

      const result = await triggerTaskExecutionInBackground(parsed.taskId);
      if (!result.ok) {
        console.warn(`[telegram] retry rejected task#${parsed.taskId} source_run#${parsed.runId}: ${result.message}`);
        await answerTelegramCallback(settings.botToken, callbackQueryId, result.message, { showAlert: true });
        return res.json({ ok: true });
      }

      console.log(`[telegram] retry started task#${parsed.taskId} source_run#${parsed.runId}`);
      await answerTelegramCallback(settings.botToken, callbackQueryId, '重试任务已开始', { showAlert: true });
      void sendTelegramMessage(settings.botToken, settings.chatId, buildRetryStartedMessage(task, run))
        .catch((error) => console.warn('[telegram] retry confirmation message failed:', error.message));
      return res.json({ ok: true });
    } catch (error) {
      try {
        await answerTelegramCallback(settings.botToken, callbackQueryId, error.message || '启动重试任务失败', { showAlert: true });
      } catch (answerError) {
        console.warn('[telegram] failed to answer callback query:', answerError.message);
      }
      return res.json({ ok: true });
    }
  }

  return { getSettings, saveSettings, testSettings, receiveWebhook };
}

module.exports = { createTelegramRouteHandlers };
