const fs = require('fs');
const path = require('path');
const db = require('./db');

const TELEGRAM_TIMEOUT_MS = 5000;
const SUCCESS_STATUSES = new Set(['success', 'failed']);
const TELEGRAM_RETRY_PREFIX = 'retry';

function isTelegramConfigured(settings = db.getTelegramSettings()) {
  return Boolean(settings?.botToken && settings?.chatId);
}

function maskTelegramToken(token) {
  const value = String(token || '').trim();
  if (!value) return '';
  if (value.length <= 10) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function formatTime(value) {
  if (!value) return '-';
  return String(value).replace('T', ' ').slice(0, 19);
}

function formatDuration(startedAt, endedAt) {
  const start = startedAt ? new Date(startedAt).getTime() : NaN;
  const end = endedAt ? new Date(endedAt).getTime() : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '-';

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}小时${minutes}分钟${seconds}秒`;
  if (minutes > 0) return `${minutes}分钟${seconds}秒`;
  return `${seconds}秒`;
}

function limitText(text, maxLength) {
  const value = String(text || '').trim();
  if (!value) return '';
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function escapeTgHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getMeaningfulLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

function getErrorSummary(run) {
  const lines = getMeaningfulLines(run?.error_text);
  if (!lines.length) return '';
  return limitText(lines[0], 180);
}

function getLogTail(run) {
  const logPath = run?.log_path;
  if (!logPath || !fs.existsSync(logPath)) return '';

  try {
    const lines = getMeaningfulLines(fs.readFileSync(logPath, 'utf8'));
    if (!lines.length) return '';
    const tail = lines.slice(-8).join('\n');
    return limitText(tail, 400);
  } catch (error) {
    console.warn('[telegram] failed to read log tail:', error.message);
    return '';
  }
}

function prettyErrorCode(code) {
  const map = {
    timeout: '超时',
    permission_error: '权限错误',
    script_error: '脚本错误',
    browser_task_error: '浏览器任务错误',
    browser_launch_error: '浏览器启动错误',
    missing_result: '缺少结果文件',
    stopped: '已停止',
  };
  return map[code] || code || '未知错误';
}

function buildSuccessMessage(task, run) {
  return [
    '✅ <b>任务执行成功</b>',
    `<code>${escapeTgHtml(task.name)}</code>`,
    '',
    `⏱ <b>耗时:</b> ${formatDuration(run.started_at, run.ended_at)}`,
  ].join('\n');
}

function buildFailureMessage(task, run) {
  const sections = [
    '❌ <b>任务执行失败</b>',
    `<code>${escapeTgHtml(task.name)}</code>`,
    '',
    `⚠️ <b>原因:</b> ${escapeTgHtml(prettyErrorCode(run.error_code))}`,
    `⏱ <b>耗时:</b> ${formatDuration(run.started_at, run.ended_at)}`,
  ];

  const errorSummary = getErrorSummary(run);
  const logTail = getLogTail(run);
  
  if (errorSummary || logTail) {
    sections.push('', '<b>📝 异常摘要:</b>', '<pre>');
    if (errorSummary) sections.push(escapeTgHtml(errorSummary));
    if (logTail) {
        if (errorSummary) sections.push('---');
        sections.push(escapeTgHtml(logTail));
    }
    sections.push('</pre>');
  }

  return sections.join('\n');
}

function buildTaskRunMessage(task, run) {
  if (run?.status === 'success') return buildSuccessMessage(task, run);
  return buildFailureMessage(task, run);
}

function buildRetryCallbackData(task, run) {
  if (!task?.id || !run?.id || run?.status !== 'failed') return null;
  return `${TELEGRAM_RETRY_PREFIX}:${task.id}:${run.id}`;
}

function buildRetryMarkup(task, run) {
  const callbackData = buildRetryCallbackData(task, run);
  if (!callbackData) return null;
  return {
    inline_keyboard: [[{ text: '重试', callback_data: callbackData }]],
  };
}

async function parseTelegramResponse(response) {
  const rawText = await response.text();
  let payload = null;

  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch (error) {
    payload = null;
  }

  if (!response.ok || !payload?.ok) {
    const message = payload?.description || rawText || `Telegram request failed with ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload.result;
}

async function telegramRequest(method, botToken, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      ...options,
      signal: controller.signal,
    });
    return await parseTelegramResponse(response);
  } finally {
    clearTimeout(timeout);
  }
}

async function sendTelegramMessage(botToken, chatId, text, replyMarkup = null) {
  return telegramRequest('sendMessage', botToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
}

async function sendTelegramPhoto(botToken, chatId, filePath, caption, replyMarkup = null) {
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath) || 'screenshot.png';
  const form = new FormData();

  form.append('chat_id', chatId);
  form.append('photo', new Blob([fileBuffer], { type: 'image/png' }), fileName);
  if (caption) {
    form.append('caption', limitText(caption, 1024));
    form.append('parse_mode', 'HTML');
  }
  if (replyMarkup) {
    form.append('reply_markup', JSON.stringify(replyMarkup));
  }

  return telegramRequest('sendPhoto', botToken, {
    method: 'POST',
    body: form,
  });
}

async function answerTelegramCallback(botToken, callbackQueryId, text) {
  return telegramRequest('answerCallbackQuery', botToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      ...(text ? { text: limitText(text, 200) } : {}),
    }),
  });
}

function getSafeScreenshotPath(run) {
  if (!run?.screenshot_path) return null;
  return fs.existsSync(run.screenshot_path) ? run.screenshot_path : null;
}

async function notifyTaskRun(task, run) {
  if (!task || !run || !SUCCESS_STATUSES.has(run.status)) return false;

  const settings = db.getTelegramSettings();
  if (!isTelegramConfigured(settings)) return false;

  const message = buildTaskRunMessage(task, run);
  const replyMarkup = run.status === 'failed' ? buildRetryMarkup(task, run) : null;
  const screenshotPath = getSafeScreenshotPath(run);

  try {
    if (screenshotPath) {
      try {
        await sendTelegramPhoto(settings.botToken, settings.chatId, screenshotPath, message, replyMarkup);
        return true;
      } catch (error) {
        console.warn('[telegram] photo upload failed, falling back to text:', error.message);
      }
    }

    await sendTelegramMessage(settings.botToken, settings.chatId, message, replyMarkup);
    return true;
  } catch (error) {
    console.warn('[telegram] notification failed:', error.message);
    return false;
  }
}

async function sendTelegramTestMessage() {
  const settings = db.getTelegramSettings();
  if (!isTelegramConfigured(settings)) {
    throw new Error('请先保存 Telegram Bot Token 和 Chat ID');
  }

  const message = [
    '🧪 <b>Telegram 测试消息</b>',
    `⏱ <b>时间:</b> ${formatTime(new Date().toISOString())}`,
    '✅ <b>状态:</b> <code>面板已连接，HTML 解析正常</code>',
  ].join('\n');

  return sendTelegramMessage(settings.botToken, settings.chatId, message);
}

module.exports = {
  isTelegramConfigured,
  maskTelegramToken,
  buildTaskRunMessage,
  buildRetryCallbackData,
  sendTelegramMessage,
  sendTelegramPhoto,
  answerTelegramCallback,
  notifyTaskRun,
  sendTelegramTestMessage,
};
