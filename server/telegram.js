const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const db = require('./db');

const TELEGRAM_TIMEOUT_MS = 5000;
const SUCCESS_STATUSES = new Set(['success', 'failed']);
const TELEGRAM_RETRY_PREFIX = 'retry';
const TELEGRAM_CURL_TIMEOUT_SEC = Math.max(8, Math.ceil(TELEGRAM_TIMEOUT_MS / 1000) + 5);

const I18N = {
  hour: '\u5c0f\u65f6',
  minute: '\u5206\u949f',
  second: '\u79d2',
  ellipsis: '\u2026',
  timeout: '\u8d85\u65f6',
  permission_error: '\u6743\u9650\u9519\u8bef',
  script_error: '\u811a\u672c\u9519\u8bef',
  browser_task_error: '\u6d4f\u89c8\u5668\u4efb\u52a1\u9519\u8bef',
  browser_launch_error: '\u6d4f\u89c8\u5668\u542f\u52a8\u9519\u8bef',
  missing_result: '\u7f3a\u5c11\u7ed3\u679c\u6587\u4ef6',
  stopped: '\u5df2\u505c\u6b62',
  unknown_error: '\u672a\u77e5\u9519\u8bef',
  task_success: '\u2705<b>\u4efb\u52a1\u6267\u884c\u6210\u529f</b>',
  task_failed: '\u274c<b>\u4efb\u52a1\u6267\u884c\u5931\u8d25</b>',
  duration_label: '\u23f1\ufe0f<b>\u8017\u65f6:</b>',
  reason_label: '\u2139\ufe0f <b>\u539f\u56e0:</b>',
  summary_label: '<b>\ud83d\udccb \u5f02\u5e38\u6458\u8981:</b>',
  retry_button: '\u91cd\u8bd5',
  need_config: '\u8bf7\u5148\u4fdd\u5b58 Telegram Bot Token \u548c Chat ID',
  test_title: '\ud83e\uddea <b>Telegram \u6d4b\u8bd5\u6d88\u606f</b>',
  test_time: '\ud83d\udd52<b>\u65f6\u95f4:</b>',
  test_status: '\u2705<b>\u72b6\u6001:</b> <code>\u9762\u677f\u5df2\u8fde\u63a5\uff0cHTML \u89e3\u6790\u6b63\u5e38</code>',
};

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

  if (hours > 0) return `${hours}${I18N.hour}${minutes}${I18N.minute}${seconds}${I18N.second}`;
  if (minutes > 0) return `${minutes}${I18N.minute}${seconds}${I18N.second}`;
  return `${seconds}${I18N.second}`;
}

function limitText(text, maxLength) {
  const value = String(text || '').trim();
  if (!value) return '';
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}${I18N.ellipsis}`;
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
    timeout: I18N.timeout,
    permission_error: I18N.permission_error,
    script_error: I18N.script_error,
    browser_task_error: I18N.browser_task_error,
    browser_launch_error: I18N.browser_launch_error,
    missing_result: I18N.missing_result,
    stopped: I18N.stopped,
  };
  return map[code] || code || I18N.unknown_error;
}

function buildSuccessMessage(task, run) {
  return [
    I18N.task_success,
    `<code>${escapeTgHtml(task.name)}</code>`,
    '',
    `${I18N.duration_label} ${formatDuration(run.started_at, run.ended_at)}`,
  ].join('\n');
}

function buildFailureMessage(task, run) {
  const sections = [
    I18N.task_failed,
    `<code>${escapeTgHtml(task.name)}</code>`,
    '',
    `${I18N.reason_label} ${escapeTgHtml(prettyErrorCode(run.error_code))}`,
    `${I18N.duration_label} ${formatDuration(run.started_at, run.ended_at)}`,
  ];

  const errorSummary = getErrorSummary(run);
  const logTail = getLogTail(run);

  if (errorSummary || logTail) {
    sections.push('', I18N.summary_label, '<pre>');
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
  if (!task?.id || !run?.id || run?.status !== 'failed' || Number(run.retryable || 0) !== 1) return null;
  return `${TELEGRAM_RETRY_PREFIX}:${task.id}:${run.id}`;
}

function buildRetryMarkup(task, run) {
  const callbackData = buildRetryCallbackData(task, run);
  if (!callbackData) return null;
  return {
    inline_keyboard: [[{ text: I18N.retry_button, callback_data: callbackData }]],
  };
}

function getTelegramProxy() {
  return String(
    process.env.TG_PROXY
      || process.env.TG_PROXY_URL
      || process.env.ALL_PROXY
      || process.env.all_proxy
      || process.env.HTTPS_PROXY
      || process.env.https_proxy
      || process.env.HTTP_PROXY
      || process.env.http_proxy
      || ''
  ).trim();
}

function normalizeProxyForCurl(proxy) {
  const value = String(proxy || '').trim();
  if (!value) return { mode: '', value: '' };
  const lower = value.toLowerCase();
  if (lower.startsWith('socks5h://') || lower.startsWith('socks5://')) {
    return { mode: 'socks5', value: value.replace(/^socks5h?:\/\//i, '') };
  }
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    return { mode: 'http', value };
  }
  return { mode: 'socks5', value };
}

function runCurl(args, timeoutMs = TELEGRAM_TIMEOUT_MS + 7000) {
  return new Promise((resolve, reject) => {
    const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('curl timeout'));
    }, timeoutMs);

    child.stdout.on('data', (buf) => {
      stdout += buf.toString();
    });
    child.stderr.on('data', (buf) => {
      stderr += buf.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const msg = (stderr || stdout || `curl exit ${code}`).trim();
        reject(new Error(msg));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function parseCurlTelegramJson(raw) {
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch (_err) {
    throw new Error(`telegram curl non-json response: ${(raw || '').slice(0, 200)}`);
  }
  if (!payload?.ok) {
    throw new Error(payload?.description || `telegram curl response not ok: ${(raw || '').slice(0, 200)}`);
  }
  return payload.result;
}

async function telegramCurlRequest(method, botToken, argsBuilder) {
  const baseArgs = ['-sS', '--max-time', String(TELEGRAM_CURL_TIMEOUT_SEC)];
  const proxy = normalizeProxyForCurl(getTelegramProxy());
  if (proxy.mode === 'socks5' && proxy.value) {
    baseArgs.push('--socks5-hostname', proxy.value);
  } else if (proxy.mode === 'http' && proxy.value) {
    baseArgs.push('-x', proxy.value);
  }
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  const args = [...baseArgs, ...argsBuilder(url)];
  const raw = await runCurl(args);
  return parseCurlTelegramJson(raw);
}

async function parseTelegramResponse(response) {
  const rawText = await response.text();
  let payload = null;

  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch (_error) {
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
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };
  try {
    return await telegramCurlRequest('sendMessage', botToken, (url) => [
      '-X', 'POST',
      url,
      '-H', 'Content-Type: application/json',
      '--data-raw', JSON.stringify(payload),
    ]);
  } catch (error) {
    console.warn('[telegram] curl sendMessage failed, fallback to fetch:', error.message);
  }
  return telegramRequest('sendMessage', botToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function sendTelegramPhoto(botToken, chatId, filePath, caption, replyMarkup = null) {
  try {
    return await telegramCurlRequest('sendPhoto', botToken, (url) => {
      const args = [
        '-X', 'POST',
        url,
        '-F', `chat_id=${chatId}`,
        '-F', `photo=@${filePath}`,
      ];
      if (caption) {
        args.push('-F', `caption=${limitText(caption, 1024)}`);
        args.push('-F', 'parse_mode=HTML');
      }
      if (replyMarkup) {
        args.push('-F', `reply_markup=${JSON.stringify(replyMarkup)}`);
      }
      return args;
    });
  } catch (error) {
    console.warn('[telegram] curl sendPhoto failed, fallback to fetch:', error.message);
  }

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
  const payload = {
    callback_query_id: callbackQueryId,
    ...(text ? { text: limitText(text, 200) } : {}),
  };
  try {
    return await telegramCurlRequest('answerCallbackQuery', botToken, (url) => [
      '-X', 'POST',
      url,
      '-H', 'Content-Type: application/json',
      '--data-raw', JSON.stringify(payload),
    ]);
  } catch (error) {
    console.warn('[telegram] curl answerCallbackQuery failed, fallback to fetch:', error.message);
  }
  return telegramRequest('answerCallbackQuery', botToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
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
    throw new Error(I18N.need_config);
  }

  const message = [
    I18N.test_title,
    `${I18N.test_time} ${formatTime(new Date().toISOString())}`,
    I18N.test_status,
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
