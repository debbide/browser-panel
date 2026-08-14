const fs = require('fs');
const path = require('path');
const express = require('express');
const { spawnSync } = require('child_process');
const config = require('../config');
const db = require('./db');
const { getVersion, refreshTags } = require('./version');
const { runTask, stopTask, prepareLogForTask } = require('./task-runner');
const {
  stopAllJobs,
  reloadJobs,
  isTaskRunning,
  isAnyBrowserTaskRunning,
  getRunningTaskIds,
  canStartTask,
  runTaskSafely,
  computeNextRun,
  evaluateTaskCondition,
} = require('./scheduler');
const {
  normalizeConditionPayload,
  parseConditionJson,
  listTypes: listConditionTypes,
} = require('./conditions');
const remainingCallback = require('./conditions/types/remaining_callback');
const { router: authRouter, requireAuth } = require('./auth');
const events = require('./events');
const logStream = require('./log-stream');
const { openManualBrowser, closeManualBrowser, getManualBrowserStatus, prepareBrowserWorkspace } = require('./browser');
const { cleanupStorage, normalizeCategories, normalizeRetentionDays } = require('./storage-cleanup');
const backup = require('./backup');
const {
  notifyTaskRun,
  sendTelegramTestMessage,
  isTelegramConfigured,
  maskTelegramToken,
  answerTelegramCallback,
  buildRetryStartedMessage,
  normalizeWebhookPublicUrl,
  registerTelegramWebhook,
  sendTelegramMessage,
} = require('./telegram');
const { PROXY_MODES } = require('./runtime/runtime-contract');
const { resolveEffectiveProxyContract } = require('./runtime/env-builder');
const { manager: warpManager, cleanError: cleanWarpError } = require('./warp/manager');
const { createWarpRouter } = require('./warp/routes');
const cloudBackup = require('./cloud/backup-service');
const { createCloudBackupRouter } = require('./cloud/routes');

fs.mkdirSync(config.paths.tasksDir, { recursive: true });
fs.mkdirSync(config.paths.publicDir, { recursive: true });

function refreshNextRunAfterSuccessfulManualRun(task) {
  if (!task?.enabled) return;

  const latestTask = db.getTask(task.id);
  if (!latestTask?.enabled) return;

  const nextRunAt = computeNextRun(latestTask, new Date(), true);
  const updatedTask = db.updateTask(task.id, {
    ...latestTask,
    next_run_at: nextRunAt,
  });

  reloadJobs(executeTask);
  return updatedTask;
}

async function executeTask(id, options = {}) {
  const { refreshScheduleOnSuccess = false, profileId = null } = options;
  const task = db.getTask(id);
  if (!task) throw new Error('Task not found');
  let effectiveTask = task;
  if (profileId) {
    const profile = db.getBrowserProfile(Number(profileId));
    if (!profile) throw new Error('Browser profile not found');
    effectiveTask = { ...task, browser_profile_id: Number(profileId) };
  }

  const run = db.createRun(id, {
    status: 'running',
    started_at: new Date().toISOString(),
    ended_at: null,
    exit_code: null,
    log_path: prepareLogForTask(id),
    screenshot_path: null,
    screenshots_dir: null,
    error_text: null,
  });
  const sessionId = `task-run:${run.id}`;
  let lease = null;
  let completedRun = null;
  try {
    const contract = resolveEffectiveProxyContract(effectiveTask, effectiveTask._profile || null);
    if (contract.mode === 'warp') {
      lease = warpManager.acquireProxy(sessionId);
      db.setRunProxySnapshot(run.id, lease.snapshot);
      effectiveTask = { ...effectiveTask, _managedProxyUrl: lease.proxyUrl };
    }
    const result = await runTask(effectiveTask, { logPath: run.log_path });
    const stoppedByUser = result.errorCode === 'stopped';
    completedRun = db.updateRun(run.id, {
      status: stoppedByUser ? 'stopped' : result.status,
      ended_at: result.endedAt,
      exit_code: result.exitCode,
      log_path: result.logPath,
      screenshot_path: result.screenshotPath,
      screenshots_dir: result.screenshotsDir || null,
      error_text: result.errorText,
      error_code: result.errorCode || null,
      retryable: result.retryable == null ? null : (result.retryable ? 1 : 0),
      retry_reason: result.retryReason ?? null,
    });
    if (refreshScheduleOnSuccess && completedRun.status === 'success') {
      refreshNextRunAfterSuccessfulManualRun(task);
    }
    void notifyTaskRun(task, completedRun);
    return completedRun;
  } catch (error) {
    const isWarpError = Boolean(error && typeof error.code === 'string' && error.code);
    const safe = isWarpError
      ? cleanWarpError(error)
      : {
        code: 'task_failed',
        message: String(error && error.message || 'Task failed').replace(/[\r\n]+/g, ' ').slice(0, 1000),
      };
    completedRun = db.updateRun(run.id, {
      status: 'failed',
      ended_at: new Date().toISOString(),
      exit_code: null,
      log_path: run.log_path,
      screenshot_path: null,
      screenshots_dir: null,
      error_text: safe.message,
      error_code: safe.code,
      retryable: 0,
      retry_reason: null,
    });
    void notifyTaskRun(task, completedRun);
    throw error;
  } finally {
    if (lease) warpManager.releaseProxy(sessionId);
    logStream.end(run.log_path, { status: completedRun ? completedRun.status : 'failed' });
  }
}

function buildSchedulerBusyPayload(taskId) {
  const ids = getRunningTaskIds();
  const browserTask = ids
    .map((id) => db.getTask(id))
    .find((task) => task && task.use_browser);
  const label = browserTask
    ? `#${browserTask.id} ${browserTask.name || ''}`.trim()
    : '未知浏览器任务';
  return {
    ok: false,
    status: 409,
    payload: {
      message: `当前有浏览器任务执行中（${label}），请稍后再试`,
      code: 'scheduler_busy',
      runningTaskIds: ids,
    },
  };
}

async function triggerTaskExecution(taskId, options = {}) {
  const idNum = Number(taskId);
  const task = db.getTask(idNum);
  if (!task) {
    return { ok: false, status: 404, payload: { message: 'Task not found', code: 'task_not_found' } };
  }
  if (task.use_browser && getManualBrowserStatus().open) {
    return { ok: false, status: 409, payload: { message: 'Browser is open manually, close it before running tasks', code: 'browser_already_open' } };
  }

  const profileId = options && options.profileId ? Number(options.profileId) : null;
  if (profileId && !db.getBrowserProfile(profileId)) {
    return { ok: false, status: 400, payload: { message: 'Selected browser profile not found', code: 'invalid_browser_profile' } };
  }

  const result = await runTaskSafely(
    idNum,
    (id) => executeTask(id, { refreshScheduleOnSuccess: true, profileId }),
    { task }
  );
  if (result?.skipped) {
    if (result.reason === 'browser_busy') {
      return buildSchedulerBusyPayload(idNum);
    }
    return { ok: false, status: 409, payload: { message: 'Task is already running', code: result.reason || 'already_running' } };
  }

  return { ok: true, status: 200, payload: { data: result } };
}

function isConfiguredTelegramChat(chatId) {
  const settings = db.getTelegramSettings();
  return Boolean(settings.chatId) && String(settings.chatId) === String(chatId);
}

function parseRetryCallbackData(value) {
  const match = /^retry:(\d+):(\d+)$/.exec(String(value || '').trim());
  if (!match) return null;
  return { taskId: Number(match[1]), runId: Number(match[2]) };
}

async function triggerTaskExecutionInBackground(taskId) {
  const taskIdNum = Number(taskId);
  const task = db.getTask(taskIdNum);
  if (!task) {
    return { ok: false, message: '任务不存在或已被删除' };
  }
  if (task.use_browser && getManualBrowserStatus().open) {
    return { ok: false, message: '手动浏览器仍在运行，请先关闭后重试' };
  }
  const gate = canStartTask(taskIdNum, { task });
  if (!gate.ok) {
    if (gate.reason === 'browser_busy') {
      return { ok: false, message: '另一个浏览器任务正在运行，请稍后重试' };
    }
    return { ok: false, message: '这个任务已经在运行' };
  }

  // Calling runTaskSafely immediately reserves the task/browser channel before
  // this webhook responds. The promise remains detached from the HTTP request.
  runTaskSafely(
    taskIdNum,
    (id) => executeTask(id, { refreshScheduleOnSuccess: true }),
    { task }
  )
    .then((result) => {
      if (result?.skipped) {
        console.warn('[telegram] retry skipped:', result.reason);
      }
    })
    .catch((error) => {
      console.warn('[telegram] retry trigger failed:', error.message);
    });

  return { ok: true, message: '重试任务已开始' };
}

function normalizeTelegramSettingsResponse() {
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

function resolveTelegramSettingValue(incomingValue, existingValue) {
  const value = String(incomingValue || '').trim();
  if (value) return value;
  return existingValue || null;
}

function inferTelegramWebhookOrigin(req) {
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

async function ensureTelegramWebhook() {
  const settings = db.getTelegramSettings();
  if (!settings.botToken || !settings.webhookUrl) return false;

  try {
    await registerTelegramWebhook(settings.botToken, settings.webhookUrl);
    db.setSetting('telegram_webhook_status', 'registered');
    db.setSetting('telegram_webhook_error', '');
    console.log(`[telegram] webhook registered: ${settings.webhookUrl}`);
    return true;
  } catch (error) {
    const message = String(error.message || 'Telegram Webhook 注册失败')
      .replace(new RegExp(settings.botToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<redacted>')
      .slice(0, 500);
    db.setSetting('telegram_webhook_status', 'error');
    db.setSetting('telegram_webhook_error', message);
    console.warn(`[telegram] webhook registration failed: ${message}`);
    return false;
  }
}

function normalizeTaskParams(input) {
  if (input === undefined || input === null || input === '') return {};
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) return {};
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('params must be a JSON object');
      }
      return parsed;
    } catch (error) {
      throw new Error(error.message || 'Invalid params JSON');
    }
  }
  if (typeof input === 'object' && !Array.isArray(input)) {
    return input;
  }
  throw new Error('params must be a JSON object');
}

function serializeTaskParams(input) {
  return JSON.stringify(normalizeTaskParams(input));
}

/** Default temp (0). Only explicit true/1/'true' enables persistent profile. */
function parseUsePersistentFlag(value, defaultValue = 0) {
  if (value === undefined || value === null || value === '') return defaultValue ? 1 : 0;
  if (value === true || value === 1 || value === '1') return 1;
  const text = String(value).trim().toLowerCase();
  if (['true', 'yes', 'on'].includes(text)) return 1;
  return 0;
}

function normalizeEnvEntriesPayload(input) {
  if (!Array.isArray(input)) {
    throw new Error('env must be an array of {name, value, is_secret}');
  }
  return input.map((item) => ({
    name: item && item.name,
    value: item && item.value !== undefined ? item.value : '',
    is_secret: item && (item.is_secret === true || item.is_secret === 1 || item.is_secret === '1') ? 1 : 0,
  }));
}

function normalizeManagedTaskEnvValue(name, value) {
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  if (!normalized) return '';
  if (name === 'BROWSER_TIMEZONE' && !isValidTimeZone(normalized)) {
    throw new Error('Invalid timezone, use IANA format like Asia/Shanghai');
  }
  return normalized;
}

function normalizeTaskEnvPayload(payload = {}) {
  if (Array.isArray(payload.env)) {
    const entries = normalizeEnvEntriesPayload(payload.env);
    const managed = new Map();
    const ordinary = [];
    for (const entry of entries) {
      const upperName = String(entry.name || '').trim().toUpperCase();
      if (upperName !== 'BROWSER_LOCALE' && upperName !== 'BROWSER_TIMEZONE') {
        ordinary.push(entry);
        continue;
      }
      const value = normalizeManagedTaskEnvValue(upperName, entry.value);
      if (value) {
        managed.set(upperName, { name: upperName, value, is_secret: 0 });
      } else {
        managed.delete(upperName);
      }
    }
    return { env: [...ordinary, ...managed.values()] };
  }

  if (payload.params !== undefined || payload.params_json !== undefined) {
    const source = normalizeTaskParams(payload.params ?? payload.params_json);
    const params = {};
    const managed = new Map();
    for (const [name, rawValue] of Object.entries(source)) {
      const upperName = String(name || '').trim().toUpperCase();
      if (upperName !== 'BROWSER_LOCALE' && upperName !== 'BROWSER_TIMEZONE') {
        params[name] = rawValue;
        continue;
      }
      const value = normalizeManagedTaskEnvValue(upperName, rawValue);
      if (value) managed.set(upperName, value);
      else managed.delete(upperName);
    }
    for (const [name, value] of managed) params[name] = value;
    return { params };
  }

  return null;
}

function applyTaskEnvPayload(taskId, payload = {}) {
  const normalized = normalizeTaskEnvPayload(payload);
  if (normalized && Array.isArray(normalized.env)) {
    db.replaceEnvEntries('task', taskId, normalized.env);
    return db.syncTaskParamsJsonFromEnv(taskId);
  }
  // Legacy: flat params / params_json object
  if (normalized && normalized.params) {
    db.setTaskEnvFromParams(taskId, normalized.params);
    return db.syncTaskParamsJsonFromEnv(taskId);
  }
  return db.getTask(taskId);
}

function decorateTaskForApi(task) {
  if (!task) return task;
  try {
    db.migrateTaskParamsToEnvIfNeeded(task);
  } catch {
    // ignore
  }
  const env = db.listEnvEntriesPublic('task', task.id);
  const params = db.getTaskEnvMap(task);
  const condition = parseConditionJson(task.condition_json);
  return {
    ...task,
    env,
    params,
    params_json: JSON.stringify(params),
    // 库里存 JSON 字符串,前端直接当数组用。
    extra_paths: backup.normalizeExtraPaths(task.extra_paths),
    condition_enabled: Number(task.condition_enabled) ? 1 : 0,
    condition,
    condition_last_status: task.condition_last_status || null,
    condition_last_detail: task.condition_last_detail || null,
    condition_last_checked_at: task.condition_last_checked_at || null,
    condition_next_check_at: task.condition_next_check_at || null,
    condition_cooldown_until: task.condition_cooldown_until || null,
    callback_remaining_sec: task.callback_remaining_sec ?? null,
    callback_reported_at: task.callback_reported_at || null,
    callback_trigger_at: task.callback_trigger_at || null,
    callback_threshold_sec: task.callback_threshold_sec ?? null,
    callback_valid_until: task.callback_valid_until || null,
    callback_action: task.callback_action || null,
  };
}

function buildConditionFieldsFromPayload(payload = {}, existing = null) {
  const enabled = payload.condition_enabled ? 1 : 0;
  if (!enabled) {
    return {
      condition_enabled: 0,
      condition_json: existing?.condition_json || '{}',
      condition_next_check_at: null,
      condition_last_status: existing?.condition_last_status || null,
      condition_last_detail: existing?.condition_last_detail || null,
      condition_last_checked_at: existing?.condition_last_checked_at || null,
      condition_cooldown_until: null,
    };
  }

  const raw = payload.condition !== undefined
    ? payload.condition
    : (payload.condition_json !== undefined
      ? (typeof payload.condition_json === 'string'
        ? parseConditionJson(payload.condition_json)
        : payload.condition_json)
      : parseConditionJson(existing?.condition_json));

  const normalized = normalizeConditionPayload(raw || {});
  let nextCheck = existing?.condition_next_check_at || new Date().toISOString();

  // When enabling remaining_callback with an existing remaining report, recompute trigger once.
  const extraCallback = {};
  if (
    normalized.type === 'remaining_callback'
    && existing
    && existing.callback_remaining_sec != null
    && existing.callback_reported_at
  ) {
    const computed = remainingCallback.computeTriggerFromReport(
      existing.callback_remaining_sec,
      normalized.config || {},
      existing.callback_reported_at
    );
    extraCallback.callback_trigger_at = computed.trigger_at;
    extraCallback.callback_threshold_sec = computed.threshold_sec;
    if (computed.trigger_at) {
      const triggerMs = new Date(computed.trigger_at).getTime();
      if (Number.isFinite(triggerMs)) {
        nextCheck = new Date(Math.max(Date.now() + 30_000, triggerMs - 30_000)).toISOString();
      }
    }
  }

  return {
    condition_enabled: 1,
    condition_json: JSON.stringify(normalized),
    condition_next_check_at: nextCheck,
    condition_last_status: existing?.condition_last_status || null,
    condition_last_detail: existing?.condition_last_detail || null,
    condition_last_checked_at: existing?.condition_last_checked_at || null,
    condition_cooldown_until: existing?.condition_cooldown_until || null,
    ...extraCallback,
  };
}

function normalizeVisionSettingsPayload(payload = {}) {
  const out = {
    baseUrl: payload.baseUrl !== undefined ? String(payload.baseUrl || '').trim() : undefined,
    model: payload.model !== undefined ? String(payload.model || '').trim() : undefined,
    apiKey: payload.apiKey !== undefined ? String(payload.apiKey || '').trim() : undefined,
    channels: payload.channels !== undefined ? String(payload.channels || '').trim() : undefined,
  };
  // 动态通道卡片：[{id?, baseUrl, apiKey, model}]（apiKey 留空=不改）。第 1 项为主通道。
  if (Array.isArray(payload.channelList)) {
    out.channelList = payload.channelList.map((c) => ({
      id: c && c.id !== undefined ? String(c.id || '').trim() : '',
      baseUrl: String((c && c.baseUrl) || '').trim(),
      apiKey: c && c.apiKey !== undefined ? String(c.apiKey || '').trim() : '',
      model: String((c && c.model) || '').trim(),
    }));
  }
  return out;
}

function slugifyScriptName(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function isValidTimeZone(value) {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: String(value || '') });
    return true;
  } catch {
    return false;
  }
}

function normalizeProfileLocale(value) {
  return String(value || '').trim();
}

function normalizeProfileUserDataDir(value) {
  return String(value || '').trim();
}

function normalizeProfileProxy(value) {
  return String(value || '').trim();
}

function normalizeProfileTimezone(value) {
  const timezone = String(value || '').trim();
  if (!timezone) return '';
  if (!isValidTimeZone(timezone)) {
    throw new Error('Invalid timezone, use IANA format like Asia/Shanghai');
  }
  return timezone;
}

function normalizeProfileProxyMode(value, legacyProxy = '') {
  const mode = String(value || '').trim().toLowerCase();
  if (!mode) return legacyProxy ? 'launch' : 'inherit';
  if (PROXY_MODES.includes(mode)) return mode;
  throw new Error(`Invalid proxy mode: ${mode}`);
}

function normalizeProfileRuntimeStack(value) {
  const stack = String(value || '').trim().toLowerCase();
  if (!stack) return '';
  if (stack === 'playwright' || stack === 'seleniumbase' || stack === 'ruyipage') return stack;
  throw new Error('Invalid runtime stack, use playwright, seleniumbase, or ruyipage');
}

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function normalizeRuntimeStack(value) {
  const stack = String(value || '').trim().toLowerCase();
  if (stack === 'seleniumbase' || stack === 'ruyipage') return stack;
  return 'playwright';
}

function normalizePluginPackages(value) {
  return String(value || '')
    .split(/[\r\n,;]+/g)
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((pkg) => {
      if (pkg === 'playwright-extra-plugin-stealth') {
        return 'puppeteer-extra-plugin-stealth';
      }
      return pkg;
    });
}

function validatePluginPackageName(pkg) {
  return /^(?:@[\w.-]+\/)?[\w.-]+$/.test(pkg);
}

function normalizeBrowserRuntimeSettingsPayload(payload = {}, fallback = null) {
  const base = fallback || db.getBrowserRuntimeSettings();
  const runtimeStack = normalizeRuntimeStack(payload.runtimeStack === undefined ? base.runtimeStack : payload.runtimeStack);
  const usePlaywrightExtra = parseBooleanFlag(payload.usePlaywrightExtra, Boolean(base.usePlaywrightExtra));
  const pluginPackages = normalizePluginPackages(payload.pluginPackages === undefined ? base.pluginPackages : payload.pluginPackages);
  const chromePath = payload.chromePath === undefined
    ? (base.chromePath || '')
    : String(payload.chromePath || '').trim().slice(0, 512);
  const extensionDirs = payload.extensionDirs === undefined
    ? (base.extensionDirs || '')
    : String(payload.extensionDirs || '').trim().slice(0, 4096);
  const ruyiPath = payload.ruyiPath === undefined
    ? (base.ruyiPath || '')
    : String(payload.ruyiPath || '').trim().slice(0, 512);
  const proxyMode = String(payload.proxyMode === undefined ? base.proxyMode : payload.proxyMode).trim().toLowerCase();
  const proxyValue = String(payload.proxyValue === undefined ? base.proxyValue : payload.proxyValue || '').trim().slice(0, 2048);
  const ruyiFpfile = String(payload.ruyiFpfile === undefined ? base.ruyiFpfile : payload.ruyiFpfile || '').trim().slice(0, 512);

  if (pluginPackages.includes('playwright-stealth')) {
    throw new Error('playwright-stealth 这个包是占位包，请改用 puppeteer-extra-plugin-stealth');
  }

  const invalidPackage = pluginPackages.find(item => !validatePluginPackageName(item));
  if (invalidPackage) {
    throw new Error(`插件包名不合法: ${invalidPackage}`);
  }

  if (chromePath && /[\r\n\0]/.test(chromePath)) {
    throw new Error('Chrome 路径含非法字符');
  }

  if (extensionDirs && /[\r\n\0]/.test(extensionDirs)) {
    throw new Error('扩展目录含非法字符');
  }

  if ([ruyiPath, ruyiFpfile].some(value => /[\r\n\0]/.test(value))) {
    throw new Error('RuyiPage path contains invalid characters');
  }

  if (!PROXY_MODES.includes(proxyMode)) {
    throw new Error(`Invalid global proxy mode: ${proxyMode}`);
  }
  const safeProxyValue = proxyMode === 'warp' ? '' : proxyValue;

  return {
    runtimeStack,
    usePlaywrightExtra: runtimeStack === 'playwright' && (usePlaywrightExtra || pluginPackages.length > 0),
    pluginPackages: pluginPackages.join(','),
    chromePath,
    ruyiPath,
    proxyMode,
    proxyValue: safeProxyValue,
    ruyiFpfile,
    extensionDirs,
  };
}

function resolveNpmCommand() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);

  for (const cliPath of candidates) {
    if (fs.existsSync(cliPath)) {
      return { command: process.execPath, args: [cliPath], nodeDir };
    }
  }

  return { command: 'npm', args: [], nodeDir };
}

function runBashCommand(command, timeout = 10 * 60 * 1000) {
  return spawnSync('bash', ['-lc', command], {
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function buildTaskScriptFilename(taskName, type) {
  const ext = type === 'python' ? '.py' : '.js';
  const base = slugifyScriptName(taskName) || 'task-script';
  return `${base}${ext}`;
}

function reserveUniqueScriptFilename(taskName, type, ignoreTaskId = null, preferredCurrentPath = '') {
  const desiredFileName = buildTaskScriptFilename(taskName, type);
  const ext = path.extname(desiredFileName);
  const base = desiredFileName.slice(0, -ext.length);
  const preferredFileName = path.basename(String(preferredCurrentPath || '').replace(/\\/g, '/'));

  for (let index = 1; index < 1000; index += 1) {
    const candidateFileName = index === 1 ? desiredFileName : `${base}-${index}${ext}`;
    const candidatePath = path.join(config.paths.tasksDir, candidateFileName);
    const owner = db.listTasks().find(task => task.script_path === `tasks/${candidateFileName}` && task.id !== ignoreTaskId);
    const fileExists = fs.existsSync(candidatePath);
    const canReuseSameFile = preferredFileName && candidateFileName === preferredFileName;

    if (!owner && (!fileExists || canReuseSameFile)) {
      return candidateFileName;
    }
  }

  throw new Error('Unable to allocate an available script filename');
}

function resolveTaskScriptPath(taskName, type, currentScriptPath = '', existingTaskId = null) {
  const normalizedCurrent = String(currentScriptPath || '').replace(/\\/g, '/');
  if (!normalizedCurrent.startsWith('tasks/')) return normalizedCurrent;

  // Task names are labels only. Binding a task to an existing script must never
  // rename that script; otherwise editing/saving a task can unexpectedly move
  // shared files such as tasks/agentrouter_checkin.py to tasks/<task-name>.py.
  // Filename allocation belongs to /api/scripts/import.
  return normalizedCurrent;
}

const app = express();
// 备份包含脚本正文,可能明显大于普通设置请求;仍限制上限避免无限制内存占用。
app.use(express.json({ limit: '20mb' }));

// --- 鉴权分界线 -------------------------------------------------------------
// 顺序有讲究，别把 requireAuth 往下挪：
// express.static(publicDir) 一旦排在前面，index.html 会在鉴权之前就被送出去，
// 中间件等于没挂。同理 /tasks /logs /screenshots 三个静态目录必须在线下方——
// 它们分别暴露任务脚本源码、日志里的 token、以及可能含已登录账号页面的截图。
app.use('/api/auth', authRouter);
// 版本号不含任何敏感信息,放鉴权之前 —— 登录页也能显示,排查"哪台机器跑着哪个版本"不用登录
app.get('/api/version', (req, res) => {
  res.json({ data: getVersion() });
});
app.use(requireAuth);
app.use('/api/warp', createWarpRouter(warpManager));
// 云端备份快照里含全部密钥（代理凭据、面板账号、WARP），必须挂在 requireAuth 之后。
app.use('/api/cloud-backup', createCloudBackupRouter(cloudBackup));
// --- 以下全部需要登录 -------------------------------------------------------

// 状态推送（SSE）。放在鉴权之后，所以未登录连不上；放在 express.static 之前，
// 免得将来 public/ 下真出现同名文件把它顶掉。
//
// 事件只是"某某变了，自己去拉"的信号，不带状态本体：前端复用已有的 loadTasks /
// loadRuns / loadBrowserStatus，服务端不用再维护一份序列化逻辑，而且拉取走
// fetchJson，会话过期时能正常走 401 跳登录页那条路（长连接本身只在建立时鉴权，
// 之后哪怕会话过期了连接也不会自己断）。
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // nginx 反代默认会缓冲响应，缓冲了 SSE 就没有"实时"可言。CF Tunnel 不需要
    // 这个头，但加着不碍事，用户换 nginx 方案时不用再想起来补。
    'X-Accel-Buffering': 'no',
  });
  // Nagle 算法会把小包攒一会儿再发，SSE 要的就是小包立刻出去
  if (res.socket && typeof res.socket.setNoDelay === 'function') {
    res.socket.setNoDelay(true);
  }
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  events.addClient(res);
});

// Avoid stale panel UI after deploys (especially app.js / styles.css / index.html)
app.use(express.static(config.paths.publicDir, {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (/\.(html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));
app.use('/tasks', express.static(config.paths.tasksDir));
app.use('/logs', express.static(config.paths.logsDir));
app.use('/screenshots', express.static(config.paths.screenshotsDir));

app.get('/api/browser', (req, res) => {
  res.json({ data: getManualBrowserStatus() });
});

app.get('/api/settings/telegram', (req, res) => {
  res.json({ data: normalizeTelegramSettingsResponse() });
});

app.get('/api/settings/browser-runtime', (req, res) => {
  res.json({ data: db.getBrowserRuntimeSettings() });
});

app.post('/api/settings/browser-runtime', (req, res) => {
  try {
    const settings = normalizeBrowserRuntimeSettingsPayload(req.body || {});
    const updated = db.setBrowserRuntimeSettings(settings);
    res.json({ data: updated });
  } catch (error) {
    res.status(400).json({ message: error.message || '保存浏览器运行时配置失败' });
  }
});

app.post('/api/settings/browser-runtime/install', (req, res) => {
  try {
    const settings = normalizeBrowserRuntimeSettingsPayload(req.body || {});
    if (settings.runtimeStack !== 'playwright') {
      return res.status(400).json({ message: '当前运行栈不是 Playwright，请使用“安装浏览器环境”按钮' });
    }

    const packageSet = new Set();
    if (settings.usePlaywrightExtra) packageSet.add('playwright-extra');
    for (const pkg of normalizePluginPackages(settings.pluginPackages)) {
      packageSet.add(pkg);
    }
    const installList = Array.from(packageSet);
    if (!installList.length) {
      return res.status(400).json({ message: '请先配置至少一个插件包名' });
    }

    const npmCommand = resolveNpmCommand();
    const env = { ...process.env };
    if (npmCommand.nodeDir) {
      env.PATH = `${npmCommand.nodeDir}:${env.PATH || ''}`;
    }
    const result = spawnSync(npmCommand.command, [...npmCommand.args, 'install', '--no-audit', '--no-fund', ...installList], {
      cwd: config.paths.root,
      encoding: 'utf8',
      timeout: 5 * 60 * 1000,
      env,
    });

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      const output = `${result.stderr || ''}\n${result.stdout || ''}`.trim();
      return res.status(500).json({
        message: `npm 安装失败（退出码 ${result.status}）`,
        output: output.slice(-3000),
      });
    }

    const updated = db.setBrowserRuntimeSettings(settings);
    res.json({
      data: {
        settings: updated,
        installed: installList,
        output: String(result.stdout || '').trim().slice(-3000),
      },
    });
  } catch (error) {
    res.status(400).json({ message: error.message || '安装插件包失败' });
  }
});

app.post('/api/settings/browser-runtime/install-browser', (req, res) => {
  try {
    const settings = normalizeBrowserRuntimeSettingsPayload(req.body || {});
    const steps = [];

    if (settings.runtimeStack === 'seleniumbase') {
      steps.push({
        name: '检查 Chrome（缺失时自动安装）',
        command: [
          'if command -v google-chrome >/dev/null 2>&1 || command -v google-chrome-stable >/dev/null 2>&1; then',
          '  echo "google-chrome already installed";',
          'else',
          '  export DEBIAN_FRONTEND=noninteractive;',
          '  apt-get update;',
          '  apt-get install -y wget ca-certificates;',
          '  wget -q -O /tmp/google-chrome-stable_current_amd64.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb;',
          '  apt-get install -y /tmp/google-chrome-stable_current_amd64.deb || apt-get -f install -y;',
          'fi',
        ].join('\n'),
      });
      steps.push({
        name: '安装 xvfb',
        command: 'if command -v xvfb-run >/dev/null 2>&1; then echo "xvfb already installed"; else apt-get update && apt-get install -y xvfb; fi',
      });
      steps.push({
        name: '安装 pip3',
        command: 'if command -v pip3 >/dev/null 2>&1; then echo "pip3 already installed"; else apt-get update && apt-get install -y python3-pip; fi',
      });
      steps.push({
        name: '安装 SeleniumBase',
        command: [
          '/usr/bin/python3 -m pip install --break-system-packages --upgrade pip setuptools wheel',
          '/usr/bin/python3 -m pip install --break-system-packages --upgrade --ignore-installed urllib3 requests selenium',
          '/usr/bin/python3 -m pip install --break-system-packages --upgrade --ignore-installed seleniumbase',
        ].join('\n'),
      });
      steps.push({
        name: '安装 ChromeDriver',
        command: '/usr/bin/python3 -m seleniumbase install chromedriver',
      });
      steps.push({
        name: '验证 SeleniumBase',
        command: '/usr/bin/python3 -c "import seleniumbase; print(seleniumbase.__version__)"',
      });
    } else {
      steps.push({
        name: '检查 Chrome（缺失时自动安装）',
        command: [
          'if command -v google-chrome >/dev/null 2>&1 || command -v google-chrome-stable >/dev/null 2>&1; then',
          '  echo "google-chrome already installed";',
          'else',
          '  export DEBIAN_FRONTEND=noninteractive;',
          '  apt-get update;',
          '  apt-get install -y wget ca-certificates;',
          '  wget -q -O /tmp/google-chrome-stable_current_amd64.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb;',
          '  apt-get install -y /tmp/google-chrome-stable_current_amd64.deb || apt-get -f install -y;',
          'fi',
        ].join('\n'),
      });
    }

    const logs = [];
    for (const step of steps) {
      const result = runBashCommand(step.command, 15 * 60 * 1000);
      const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
      logs.push({
        step: step.name,
        exitCode: result.status ?? (result.error ? 1 : 0),
        output: output.slice(-3000),
      });

      if (result.error || result.status !== 0) {
        return res.status(500).json({
          message: `安装失败：${step.name}`,
          output: output.slice(-3000),
          logs,
        });
      }
    }

    const updated = db.setBrowserRuntimeSettings(settings);
    res.json({
      data: {
        settings: updated,
        logs,
      },
    });
  } catch (error) {
    res.status(400).json({ message: error.message || '安装浏览器环境失败' });
  }
});

app.post('/api/settings/telegram', async (req, res) => {
  try {
    const payload = req.body || {};
    const current = db.getTelegramSettings();
    const botToken = resolveTelegramSettingValue(payload.botToken, current.botToken);
    const chatId = resolveTelegramSettingValue(payload.chatId, current.chatId);

    if (!botToken || !chatId) {
      return res.status(400).json({ message: 'Bot Token and Chat ID are required' });
    }

    let webhookUrl = '';
    try {
      const rawWebhookUrl = payload.webhookUrl === undefined
        ? (current.webhookUrl || inferTelegramWebhookOrigin(req))
        : payload.webhookUrl;
      webhookUrl = normalizeWebhookPublicUrl(rawWebhookUrl);
    } catch (error) {
      return res.status(400).json({ message: error.message || 'Webhook URL is invalid' });
    }

    // Save the transport settings first so setWebhook uses the latest proxy configuration.
    db.setSetting('telegram_bot_token', botToken);
    db.setSetting('telegram_chat_id', chatId);
    if (payload.proxy !== undefined) {
      db.setSetting('telegram_proxy', String(payload.proxy).trim());
    }
    db.setSetting('telegram_webhook_url', webhookUrl);

    if (!webhookUrl) {
      db.setSetting('telegram_webhook_status', 'needs_url');
      db.setSetting('telegram_webhook_error', '请填写公网 HTTPS 地址后保存，面板会自动注册 Webhook');
      return res.json({ data: normalizeTelegramSettingsResponse() });
    }

    try {
      await registerTelegramWebhook(botToken, webhookUrl);
      db.setSetting('telegram_webhook_status', 'registered');
      db.setSetting('telegram_webhook_error', '');
      return res.json({ data: normalizeTelegramSettingsResponse() });
    } catch (error) {
      const message = String(error.message || 'Telegram Webhook 注册失败')
        .replace(new RegExp(botToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<redacted>')
        .slice(0, 500);
      db.setSetting('telegram_webhook_status', 'error');
      db.setSetting('telegram_webhook_error', message);
      return res.json({ data: normalizeTelegramSettingsResponse() });
    }
  } catch (error) {
    res.status(500).json({ message: error.message || '保存 Telegram 设置失败' });
  }
});

app.post('/api/settings/telegram/test', async (req, res) => {
  try {
    await sendTelegramTestMessage();
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to send test message' });
  }
});

app.get('/api/settings/scheduler', (req, res) => {
  res.json({
    data: {
      allowParallel: db.isTaskParallelAllowed(),
      runningTaskIds: getRunningTaskIds(),
    },
  });
});

app.post('/api/settings/scheduler', (req, res) => {
  try {
    const body = req.body || {};
    const allowParallel = Boolean(body.allowParallel);
    const updated = db.setTaskParallelAllowed(allowParallel);
    console.log(`[scheduler] allowParallel=${updated ? '1' : '0'}`);
    res.json({
      data: {
        allowParallel: updated,
        runningTaskIds: getRunningTaskIds(),
      },
    });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to save scheduler settings' });
  }
});

app.get('/api/settings/success-heuristics', (req, res) => {
  const { getSuccessHeuristicSettings } = require('./runtime/success-heuristics');
  res.json({ data: getSuccessHeuristicSettings() });
});

app.post('/api/settings/success-heuristics', (req, res) => {
  try {
    const { setSuccessHeuristicSettings } = require('./runtime/success-heuristics');
    const body = req.body || {};
    const updated = setSuccessHeuristicSettings({
      enabled: body.enabled,
      successPatternsText: body.successPatternsText,
      failurePatternsText: body.failurePatternsText,
      graceSec: body.graceSec,
    });
    res.json({ data: updated });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to save success heuristics' });
  }
});

app.get('/api/settings/vision', (req, res) => {
  res.json({ data: db.getVisionSettingsPublic() });
});

app.post('/api/settings/vision', (req, res) => {
  try {
    const payload = normalizeVisionSettingsPayload(req.body || {});
    const updated = db.setVisionSettings(payload);
    res.json({ data: updated });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to save vision settings' });
  }
});

/**
 * 只切某个通道的 model，其他字段（尤其是 key）原样保留。
 * 给前端「模型下拉点选即生效」用：走全量保存会连带写入用户还在编辑、并不想保存的字段。
 */
app.post('/api/settings/vision/model', (req, res) => {
  try {
    const body = req.body || {};
    const id = String(body.id || '').trim();
    const model = String(body.model || '').trim();
    if (!id) return res.status(400).json({ message: '缺少通道 id' });
    if (!model) return res.status(400).json({ message: '缺少 model' });
    const updated = db.setVisionChannelModel(id, model);
    res.json({ data: updated });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to switch vision model' });
  }
});

/**
 * Test Vision channel: connectivity (/models) + optional image chat/completions.
 * Body may include draft channel from the form (apiKey empty → use THAT channel's saved key).
 * Never fall back to primary key for a non-primary baseUrl (causes false INVALID_API_KEY).
 */
app.post('/api/settings/vision/test', async (req, res) => {
  try {
    const { testVisionChannel } = require('./runtime/vision-test');
    const body = req.body || {};
    const saved = db.getVisionSettings();
    const channelsInternal = typeof db.getVisionChannelsInternal === 'function'
      ? db.getVisionChannelsInternal()
      : [];

    const norm = (s) => String(s || '').trim().replace(/\/+$/, '').toLowerCase();
    const id = String(body.id || '').trim();
    const baseUrl = String(body.baseUrl || '').trim();
    const model = String(body.model || '').trim();
    let apiKey = String(body.apiKey || '').trim();

    if (!apiKey && baseUrl) {
      // 与保存路径共用同一个解析器（显式 key → id → baseUrl+model），避免两边规则各自漂移。
      if (typeof db.resolveVisionChannelKey === 'function') {
        apiKey = db.resolveVisionChannelKey({ incomingKey: '', id, baseUrl, model }, channelsInternal);
      }
      // 解析器不含「只匹配 baseUrl」这一档：改了 model 但没带 id 时（老前端）仍要能测通。
      if (!apiKey) {
        const sameBase = channelsInternal.find(
          (ch) => norm(ch.baseUrl) === norm(baseUrl) && ch.apiKey
        );
        apiKey = String((sameBase || {}).apiKey || '').trim();
      }
    }

    // Only if still empty and caller omitted baseUrl entirely, allow primary (legacy).
    if (!apiKey && !baseUrl) {
      const primarySaved = channelsInternal[0] || {
        baseUrl: saved.baseUrl,
        apiKey: saved.apiKey,
        model: saved.model,
      };
      apiKey = String(primarySaved.apiKey || saved.apiKey || '').trim();
    }

    const effectiveBase = baseUrl
      || String((channelsInternal[0] || {}).baseUrl || saved.baseUrl || '').trim();
    const effectiveModel = model
      || String((channelsInternal.find((ch) => norm(ch.baseUrl) === norm(effectiveBase)) || {}).model
        || (channelsInternal[0] || {}).model
        || saved.model
        || '').trim();

    if (!effectiveBase) {
      return res.status(400).json({ message: '请填写 Base URL' });
    }
    if (!apiKey) {
      return res.status(400).json({
        message: '该通道没有可用的 API Key：请在输入框粘贴 Key，或先保存该通道后再测（不会用主通道的 Key 顶替）',
      });
    }

    const data = await testVisionChannel(
      { baseUrl: effectiveBase, apiKey, model: effectiveModel },
      {
        fetchModels: body.fetchModels !== false,
        testImage: body.testImage !== false,
        model: effectiveModel,
      }
    );
    // Help debug without leaking full secret
    data.usedKeyHint = apiKey.length > 8
      ? `${apiKey.slice(0, 4)}***${apiKey.slice(-4)}`
      : '(short)';
    data.usedBaseUrl = effectiveBase;
    res.json({ data });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Vision test failed' });
  }
});

app.post('/api/telegram/webhook/:token', async (req, res) => {
  const settings = db.getTelegramSettings();
  if (!settings.botToken || req.params.token !== settings.botToken) {
    return res.status(403).json({ message: 'Forbidden' });
  }

  const callbackQuery = req.body?.callback_query;
  if (!callbackQuery) {
    return res.json({ ok: true });
  }

  const callbackQueryId = callbackQuery.id;
  const chatId = callbackQuery.message?.chat?.id;
  const parsed = parseRetryCallbackData(callbackQuery.data);
  console.log(
    `[telegram] callback received chat=${chatId || '-'} action=${parsed ? 'retry' : 'unknown'}`
  );

  try {
    if (!isConfiguredTelegramChat(chatId)) {
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
      console.warn(
        `[telegram] retry rejected task#${parsed.taskId} source_run#${parsed.runId}: ${result.message}`
      );
      await answerTelegramCallback(settings.botToken, callbackQueryId, result.message, { showAlert: true });
      return res.json({ ok: true });
    }

    console.log(`[telegram] retry started task#${parsed.taskId} source_run#${parsed.runId}`);
    await answerTelegramCallback(settings.botToken, callbackQueryId, '重试任务已开始', { showAlert: true });
    void sendTelegramMessage(
      settings.botToken,
      settings.chatId,
      buildRetryStartedMessage(task, run)
    ).catch((error) => {
      console.warn('[telegram] retry confirmation message failed:', error.message);
    });
    return res.json({ ok: true });
  } catch (error) {
    try {
      await answerTelegramCallback(
        settings.botToken,
        callbackQueryId,
        error.message || '启动重试任务失败',
        { showAlert: true }
      );
    } catch (answerError) {
      console.warn('[telegram] failed to answer callback query:', answerError.message);
    }
    return res.json({ ok: true });
  }
});

app.post('/api/browser/open', async (req, res) => {
  try {
    if (isAnyBrowserTaskRunning()) {
      const busy = buildSchedulerBusyPayload();
      return res.status(busy.status).json(busy.payload);
    }
    const profileId = req.body && req.body.profile_id ? Number(req.body.profile_id) : null;
    const profile = profileId ? db.getBrowserProfile(profileId) : null;
    const session = await openManualBrowser(profile);
    res.json({ data: { open: true, openedAt: session.openedAt, profileId } });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Failed to open browser' });
  }
});

app.get('/api/browser-profiles', (req, res) => {
  res.json({ data: db.listBrowserProfiles() });
});

app.post('/api/browser-profiles', (req, res) => {
  try {
    const { name, user_data_dir, proxy } = req.body || {};
    const legacyProxy = normalizeProfileProxy(proxy);
    const proxy_mode = normalizeProfileProxyMode(req.body?.proxy_mode ?? req.body?.proxyMode, legacyProxy);
    const proxy_value = proxy_mode === 'warp' ? '' : normalizeProfileProxy(req.body?.proxy_value ?? req.body?.proxyValue ?? legacyProxy);
    const ruyi_fpfile = normalizeProfileUserDataDir(req.body?.ruyi_fpfile ?? req.body?.ruyiFpfile);
    const runtime_stack = normalizeProfileRuntimeStack(req.body?.runtime_stack ?? req.body?.runtimeStack);
    const locale = normalizeProfileLocale(req.body?.locale);
    const timezone_id = normalizeProfileTimezone(req.body?.timezone_id ?? req.body?.timezoneId);
    if (!name) return res.status(400).json({ message: 'Profile name is required' });
    const profile = db.createBrowserProfile({
      name: String(name),
      user_data_dir: normalizeProfileUserDataDir(user_data_dir),
      proxy: legacyProxy,
      proxy_mode,
      proxy_value,
      ruyi_fpfile,
      runtime_stack,
      locale,
      timezone_id,
    });
    res.json({ data: profile });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});
app.put('/api/browser-profiles/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, user_data_dir, proxy } = req.body || {};
    const legacyProxy = normalizeProfileProxy(proxy);
    const proxy_mode = normalizeProfileProxyMode(req.body?.proxy_mode ?? req.body?.proxyMode, legacyProxy);
    const proxy_value = proxy_mode === 'warp' ? '' : normalizeProfileProxy(req.body?.proxy_value ?? req.body?.proxyValue ?? legacyProxy);
    const ruyi_fpfile = normalizeProfileUserDataDir(req.body?.ruyi_fpfile ?? req.body?.ruyiFpfile);
    const runtime_stack = normalizeProfileRuntimeStack(req.body?.runtime_stack ?? req.body?.runtimeStack);
    const locale = normalizeProfileLocale(req.body?.locale);
    const timezone_id = normalizeProfileTimezone(req.body?.timezone_id ?? req.body?.timezoneId);
    if (!name) return res.status(400).json({ message: 'Profile name is required' });
    const profile = db.updateBrowserProfile(id, {
      name: String(name),
      user_data_dir: normalizeProfileUserDataDir(user_data_dir),
      proxy: legacyProxy,
      proxy_mode,
      proxy_value,
      ruyi_fpfile,
      runtime_stack,
      locale,
      timezone_id,
    });
    res.json({ data: profile });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.delete('/api/browser-profiles/:id', (req, res) => {
  try {
    db.deleteBrowserProfile(Number(req.params.id));
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.post('/api/browser/close', async (req, res) => {
  try {
    const result = await closeManualBrowser();
    res.json({ data: result });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Failed to close browser' });
  }
});

app.get('/api/env', (req, res) => {
  try {
    const scope = String(req.query.scope || 'global');
    const ownerId = req.query.owner_id !== undefined ? Number(req.query.owner_id) : null;
    const data = db.listEnvEntriesPublic(scope, ownerId);
    res.json({
      data,
      githubCompat: db.isGithubCompatEnabled(),
    });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to list env' });
  }
});

app.put('/api/env', (req, res) => {
  try {
    const payload = req.body || {};
    const scope = String(payload.scope || 'global');
    const ownerId = payload.owner_id !== undefined ? payload.owner_id : null;
    const entries = normalizeEnvEntriesPayload(payload.env || payload.entries || []);
    const data = db.replaceEnvEntries(scope, ownerId, entries);
    if (scope === 'task' && ownerId) {
      db.syncTaskParamsJsonFromEnv(Number(ownerId));
    }
    if (payload.githubCompat !== undefined) {
      db.setGithubCompatEnabled(Boolean(payload.githubCompat));
    }
    res.json({ data, githubCompat: db.isGithubCompatEnabled() });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to save env' });
  }
});

app.get('/api/settings/github-compat', (req, res) => {
  res.json({ data: { enabled: db.isGithubCompatEnabled() } });
});

app.post('/api/settings/github-compat', (req, res) => {
  try {
    const enabled = req.body && req.body.enabled !== undefined
      ? Boolean(req.body.enabled)
      : true;
    res.json({ data: { enabled: db.setGithubCompatEnabled(enabled) } });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to save setting' });
  }
});

app.get('/api/browser-profiles/:id/env', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!db.getBrowserProfile(id)) return res.status(404).json({ message: 'Profile not found' });
    res.json({ data: db.listEnvEntriesPublic('profile', id) });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to list profile env' });
  }
});

app.put('/api/browser-profiles/:id/env', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!db.getBrowserProfile(id)) return res.status(404).json({ message: 'Profile not found' });
    const entries = normalizeEnvEntriesPayload((req.body || {}).env || (req.body || {}).entries || []);
    res.json({ data: db.replaceEnvEntries('profile', id, entries) });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to save profile env' });
  }
});

function resolveTaskGroupId(value) {
  if (value === null || value === undefined || value === '') return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error('分组 ID 不合法');
  if (!db.getTaskGroup(id)) throw new Error('分组不存在');
  return id;
}

function normalizeExtraPathsPayload(value) {
  if (value === undefined || value === null) return null;
  const list = backup.normalizeExtraPaths(value);
  return JSON.stringify(list);
}

// 扫描主脚本依赖的本地模块,预填任务的附加模块勾选。
app.post('/api/tasks/scan-deps', (req, res) => {
  try {
    const scriptPath = String((req.body || {}).script_path || '');
    if (!scriptPath) throw new Error('请先选择脚本');
    res.json({ data: backup.scanTaskDependencies(scriptPath) });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to scan dependencies' });
  }
});

/**
 * 导出前批量扫描:附加模块只在打包这一刻才有意义,所以入口放在导出流程里,
 * 而不是让用户逐个任务去配。已声明过的合并进来,用户手工补的条目不会被扫描冲掉。
 */
app.post('/api/backup/scan-assets', (req, res) => {
  try {
    const raw = (req.body || {}).task_ids;
    const ids = (Array.isArray(raw) ? raw : String(raw || '').split(','))
      .map((item) => Number(String(item).trim()))
      .filter((item) => Number.isInteger(item) && item > 0);
    if (!ids.length) throw new Error('请先选择任务');

    const data = [];
    for (const id of ids) {
      const task = db.getTask(id);
      if (!task) continue;
      const declared = backup.normalizeExtraPaths(task.extra_paths);
      let found = [];
      let error = null;
      try {
        found = backup.scanTaskDependencies(task.script_path).map((item) => item.path);
      } catch (err) {
        error = err.message || '扫描失败';
      }
      // 扫到的和已声明的合并:静态分析看不见动态 import,之前手工补的必须留着。
      const paths = [...new Set([...declared, ...found])].sort();
      data.push({
        id: task.id,
        name: task.name,
        script_path: task.script_path,
        declared,
        found,
        paths,
        error,
      });
    }
    res.json({ data });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to scan assets' });
  }
});

/**
 * 只写 extra_paths 一列。不能复用 PUT /api/tasks/:id —— 那条是整行替换语义,
 * 只发一个字段会把任务名写成 Untitled Task、清掉定时和浏览器配置。
 */
app.post('/api/backup/save-assets', (req, res) => {
  try {
    const list = Array.isArray((req.body || {}).tasks) ? req.body.tasks : [];
    const saved = [];
    for (const item of list) {
      const id = Number((item || {}).id);
      if (!Number.isInteger(id) || id <= 0) continue;
      if (!db.getTask(id)) continue;
      const json = normalizeExtraPathsPayload((item || {}).paths) || '[]';
      db.updateTaskExtraPaths(id, json);
      saved.push(id);
    }
    res.json({ data: { saved } });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to save assets' });
  }
});

app.get('/api/task-groups', (req, res) => {
  res.json({ data: db.listTaskGroups() });
});

app.post('/api/task-groups', (req, res) => {
  try {
    res.json({ data: db.createTaskGroup((req.body || {}).name) });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to create task group' });
  }
});

app.put('/api/task-groups/order', (req, res) => {
  try {
    res.json({ data: db.updateTaskGroupOrder((req.body || {}).ids) });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to reorder task groups' });
  }
});

app.put('/api/task-groups/:id', (req, res) => {
  try {
    const group = db.updateTaskGroup(Number(req.params.id), (req.body || {}).name);
    if (!group) return res.status(404).json({ message: 'Task group not found' });
    res.json({ data: group });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to update task group' });
  }
});

app.delete('/api/task-groups/:id', (req, res) => {
  try {
    const group = db.deleteTaskGroup(Number(req.params.id));
    if (!group) return res.status(404).json({ message: 'Task group not found' });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to delete task group' });
  }
});

app.get('/api/tasks', (req, res) => {
  // Latest run is looked up per task, not sliced out of the global recent-runs
  // window — otherwise an infrequent task drops off the list and its card
  // regresses to "未运行" while its history is still intact.
  const latestByTask = new Map();
  for (const run of db.listLatestRunPerTask()) latestByTask.set(run.task_id, run);
  const tasks = db.listTasks().map((task) => ({
    ...decorateTaskForApi(task),
    is_running: isTaskRunning(task.id),
    latest_run: latestByTask.get(task.id) || null,
  }));
  res.json({ data: tasks });
});

app.post('/api/tasks', (req, res) => {
  try {
    const payload = req.body || {};
    normalizeTaskEnvPayload(payload);
    const type = payload.type === 'python' ? 'python' : 'javascript';
    const name = String(payload.name || 'Untitled Task');
    const conditionFields = buildConditionFieldsFromPayload(payload, null);
    let task = db.createTask({
      name,
      type,
      script_path: resolveTaskScriptPath(name, type, String(payload.script_path || '')),
      cron_expr: String(payload.cron_expr || ''),
      schedule_mode: payload.schedule_mode === 'daily_window' ? 'daily_window' : (payload.schedule_mode === 'interval' ? 'interval' : 'fixed'),
      interval_min: payload.interval_min ? Number(payload.interval_min) : null,
      interval_max: payload.interval_max ? Number(payload.interval_max) : null,
      interval_unit: payload.interval_unit ? String(payload.interval_unit) : null,
      daily_time_start: payload.daily_time_start ? String(payload.daily_time_start) : null,
      daily_time_end: payload.daily_time_end ? String(payload.daily_time_end) : null,
      daily_day_min: payload.daily_day_min ? Number(payload.daily_day_min) : null,
      daily_day_max: payload.daily_day_max ? Number(payload.daily_day_max) : null,
      next_run_at: payload.next_run_at ? String(payload.next_run_at) : null,
      enabled: payload.enabled ? 1 : 0,
      use_browser: payload.use_browser === false ? 0 : 1,
      use_persistent: parseUsePersistentFlag(payload.use_persistent, 0),
      timeout_sec: Number(payload.timeout_sec || 300),
      params_json: '{}',
      browser_profile_id: payload.browser_profile_id ? Number(payload.browser_profile_id) : null,
      group_id: resolveTaskGroupId(payload.group_id),
      extra_paths: normalizeExtraPathsPayload(payload.extra_paths) || '[]',
      ...conditionFields,
    });
    task = applyTaskEnvPayload(task.id, payload) || task;
    reloadJobs(executeTask);
    res.json({ data: decorateTaskForApi(task) });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to save task' });
  }
});

app.put('/api/tasks/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const payload = req.body || {};
    normalizeTaskEnvPayload(payload);
    const existing = db.getTask(id);
    if (!existing) return res.status(404).json({ message: 'Task not found' });
    const type = payload.type === 'python' ? 'python' : 'javascript';
    const name = String(payload.name || 'Untitled Task');
    const requestedScriptPath = String(payload.script_path || existing?.script_path || '');
    const conditionFields = buildConditionFieldsFromPayload(payload, existing);
    let task = db.updateTask(id, {
      name,
      type,
      script_path: resolveTaskScriptPath(name, type, requestedScriptPath, id),
      cron_expr: String(payload.cron_expr || ''),
      schedule_mode: payload.schedule_mode === 'daily_window' ? 'daily_window' : (payload.schedule_mode === 'interval' ? 'interval' : 'fixed'),
      interval_min: payload.interval_min ? Number(payload.interval_min) : null,
      interval_max: payload.interval_max ? Number(payload.interval_max) : null,
      interval_unit: payload.interval_unit ? String(payload.interval_unit) : null,
      daily_time_start: payload.daily_time_start ? String(payload.daily_time_start) : null,
      daily_time_end: payload.daily_time_end ? String(payload.daily_time_end) : null,
      daily_day_min: payload.daily_day_min ? Number(payload.daily_day_min) : null,
      daily_day_max: payload.daily_day_max ? Number(payload.daily_day_max) : null,
      next_run_at: payload.next_run_at ? String(payload.next_run_at) : existing?.next_run_at || null,
      enabled: payload.enabled ? 1 : 0,
      use_browser: payload.use_browser === false ? 0 : 1,
      use_persistent: parseUsePersistentFlag(
        payload.use_persistent,
        Number(existing.use_persistent) ? 1 : 0
      ),
      timeout_sec: Number(payload.timeout_sec || 300),
      params_json: existing.params_json || '{}',
      browser_profile_id: payload.browser_profile_id ? Number(payload.browser_profile_id) : null,
      group_id: Object.prototype.hasOwnProperty.call(payload, 'group_id')
        ? resolveTaskGroupId(payload.group_id)
        : existing.group_id,
      extra_paths: Object.prototype.hasOwnProperty.call(payload, 'extra_paths')
        ? (normalizeExtraPathsPayload(payload.extra_paths) || '[]')
        : existing.extra_paths,
      // preserve script callback state across form saves
      callback_remaining_sec: existing.callback_remaining_sec ?? null,
      callback_reported_at: existing.callback_reported_at || null,
      callback_trigger_at: existing.callback_trigger_at || null,
      callback_threshold_sec: existing.callback_threshold_sec ?? null,
      callback_valid_until: existing.callback_valid_until || null,
      callback_action: existing.callback_action || null,
      ...conditionFields,
    });
    if (payload.env !== undefined || payload.params !== undefined || payload.params_json !== undefined) {
      task = applyTaskEnvPayload(id, payload) || task;
    }
    reloadJobs(executeTask);
    res.json({ data: decorateTaskForApi(task) });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to update task' });
  }
});

app.get('/api/conditions/types', (req, res) => {
  res.json({ data: listConditionTypes() });
});

app.post('/api/tasks/:id/condition/test', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const task = db.getTask(id);
    if (!task) return res.status(404).json({ message: 'Task not found' });

    // Optional body.condition overrides stored config for dry-run without save
    let evalTask = task;
    if (req.body && (req.body.condition || req.body.condition_json)) {
      const raw = req.body.condition || req.body.condition_json;
      const normalized = normalizeConditionPayload(
        typeof raw === 'string' ? parseConditionJson(raw) : raw
      );
      evalTask = { ...task, condition_enabled: 1, condition_json: JSON.stringify(normalized) };
    } else if (!Number(task.condition_enabled)) {
      // allow test using form draft even if not yet enabled — require condition in body
      if (req.body && req.body.condition) {
        const normalized = normalizeConditionPayload(req.body.condition);
        evalTask = { ...task, condition_enabled: 1, condition_json: JSON.stringify(normalized) };
      }
    }

    const result = await evaluateTaskCondition(evalTask);
    // Persist last_* only when testing the task's currently saved condition
    const testingSaved = !req.body?.condition && !req.body?.condition_json;
    if (testingSaved && Number(task.condition_enabled)) {
      db.updateTask(id, {
        ...task,
        condition_last_status: result.status || null,
        condition_last_detail: String(result.detail || '').slice(0, 500) || null,
        condition_last_checked_at: new Date().toISOString(),
      });
    }
    res.json({ data: result });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Condition test failed' });
  }
});

app.delete('/api/tasks/:id', (req, res) => {
  try {
    const result = db.deleteTask(Number(req.params.id));
    if (!result.changes) {
      return res.status(404).json({ message: 'Task not found or already deleted' });
    }
    reloadJobs(executeTask);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to delete task' });
  }
});

const TASKS_TEXT_EXTS = new Set([
  '.js', '.py', '.json', '.txt', '.md', '.env', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.sh', '.css', '.html', '.xml', '.csv',
]);
const TASKS_MAX_TEXT = 2 * 1024 * 1024;
const TASKS_MAX_UPLOAD = 15 * 1024 * 1024;

function resolveUnderTasks(relPath = '') {
  const raw = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/^tasks\//, '');
  if (raw.split('/').some((p) => p === '..')) {
    throw new Error('Invalid path');
  }
  const abs = path.resolve(config.paths.tasksDir, raw);
  const root = path.resolve(config.paths.tasksDir);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('Path escapes tasks directory');
  }
  return { abs, rel: raw.replace(/\\/g, '/'), root };
}

function isTextExt(name) {
  const ext = path.extname(name || '').toLowerCase();
  if (!ext) return true;
  return TASKS_TEXT_EXTS.has(ext);
}

function listTasksBoundToPath(relFromTasks) {
  const needle = `tasks/${String(relFromTasks || '').replace(/\\/g, '/')}`;
  return db.listTasks().filter((t) => {
    const sp = String(t.script_path || '').replace(/\\/g, '/');
    return sp === needle || sp.startsWith(`${needle}/`);
  });
}

// Task picker: entry scripts only.
// Default: top-level tasks/*.js|*.py (subfolders like host2play_dp/ are libraries, not task entries).
// Optional: ?recursive=1 to include nested files (file manager / advanced).
app.get('/api/scripts', (req, res) => {
  const allowedExts = new Set(['.js', '.py']);
  const recursive = ['1', 'true', 'yes', 'on'].includes(
    String(req.query.recursive || '').trim().toLowerCase()
  );
  // Never offer package internals as runnable task scripts
  const skipNames = new Set([
    '__init__.py',
    '__main__.py',
    'conftest.py',
    'setup.py',
  ]);
  const out = [];
  function pushFile(rel, name) {
    if (skipNames.has(name)) return;
    if (name.startsWith('.') || name.endsWith('.pyc')) return;
    const ext = path.extname(name).toLowerCase();
    if (!allowedExts.has(ext)) return;
    out.push({
      name: rel,
      path: `tasks/${rel}`,
      type: ext === '.py' ? 'python' : 'javascript',
    });
  }
  function walk(dirAbs, relBase) {
    let entries = [];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '__pycache__' || entry.name.startsWith('.')) continue;
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      const abs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      pushFile(rel, entry.name);
    }
  }
  // Top-level only by default
  walk(config.paths.tasksDir, '');
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  res.json({ data: out });
});

// Recursive-aware file manager for tasks/
app.get('/api/tasks-fs', (req, res) => {
  try {
    const dirRel = String(req.query.path || '');
    const { abs, rel } = resolveUnderTasks(dirRel);
    if (!fs.existsSync(abs)) return res.status(404).json({ message: 'Directory not found' });
    if (!fs.statSync(abs).isDirectory()) return res.status(400).json({ message: 'Not a directory' });

    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.name !== '.' && e.name !== '..' && e.name !== '__pycache__' && !e.name.endsWith('.pyc'))
      .map((e) => {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        const childAbs = path.join(abs, e.name);
        let size = 0;
        let mtime = null;
        try {
          const st = fs.statSync(childAbs);
          size = st.isFile() ? st.size : 0;
          mtime = st.mtime.toISOString();
        } catch {
          // ignore
        }
        return {
          name: e.name,
          path: childRel,
          type: e.isDirectory() ? 'dir' : 'file',
          size,
          mtime,
          text: e.isFile() ? isTextExt(e.name) : false,
        };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });

    res.json({ data: { path: rel, entries } });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to list' });
  }
});

app.get('/api/tasks-fs/read', (req, res) => {
  try {
    const { abs, rel } = resolveUnderTasks(req.query.path || '');
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return res.status(404).json({ message: 'File not found' });
    }
    const st = fs.statSync(abs);
    if (st.size > TASKS_MAX_TEXT) {
      return res.status(400).json({ message: 'File too large to edit in browser' });
    }
    if (!isTextExt(path.basename(abs))) {
      return res.status(400).json({ message: 'Binary file — use download' });
    }
    const content = fs.readFileSync(abs, 'utf8');
    res.json({ data: { path: rel, name: path.basename(abs), content, size: st.size } });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to read' });
  }
});

app.get('/api/tasks-fs/download', (req, res) => {
  try {
    const { abs } = resolveUnderTasks(req.query.path || '');
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return res.status(404).json({ message: 'File not found' });
    }
    res.download(abs, path.basename(abs));
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to download' });
  }
});

app.put('/api/tasks-fs/write', (req, res) => {
  try {
    const payload = req.body || {};
    const { abs, rel } = resolveUnderTasks(payload.path || '');
    if (!rel) return res.status(400).json({ message: 'path required' });
    const content = payload.content == null ? '' : String(payload.content);
    if (Buffer.byteLength(content, 'utf8') > TASKS_MAX_TEXT) {
      return res.status(400).json({ message: 'Content too large' });
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    res.json({ ok: true, data: { path: rel, name: path.basename(abs) } });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to write' });
  }
});

app.post('/api/tasks-fs/mkdir', (req, res) => {
  try {
    const payload = req.body || {};
    const parent = String(payload.parent || payload.path || '');
    const name = String(payload.name || '').trim();
    if (!name || name.includes('/') || name.includes('\\') || name === '..') {
      return res.status(400).json({ message: 'Invalid folder name' });
    }
    const { abs: parentAbs, rel: parentRel } = resolveUnderTasks(parent);
    if (!fs.existsSync(parentAbs)) fs.mkdirSync(parentAbs, { recursive: true });
    if (!fs.statSync(parentAbs).isDirectory()) {
      return res.status(400).json({ message: 'Parent is not a directory' });
    }
    const target = path.join(parentAbs, name);
    if (fs.existsSync(target)) return res.status(409).json({ message: 'Already exists' });
    fs.mkdirSync(target, { recursive: false });
    const rel = parentRel ? `${parentRel}/${name}` : name;
    res.json({ ok: true, data: { path: rel, name, type: 'dir' } });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to mkdir' });
  }
});

app.post('/api/tasks-fs/create-file', (req, res) => {
  try {
    const payload = req.body || {};
    const parent = String(payload.parent || payload.path || '');
    let name = String(payload.name || '').trim();
    if (!name || name.includes('/') || name.includes('\\') || name === '..') {
      return res.status(400).json({ message: 'Invalid file name' });
    }
    if (!path.extname(name)) name = `${name}.py`;
    const { abs: parentAbs, rel: parentRel } = resolveUnderTasks(parent);
    fs.mkdirSync(parentAbs, { recursive: true });
    const target = path.join(parentAbs, name);
    if (fs.existsSync(target)) return res.status(409).json({ message: 'Already exists' });
    const content = payload.content != null ? String(payload.content) : '';
    fs.writeFileSync(target, content, 'utf8');
    const rel = parentRel ? `${parentRel}/${name}` : name;
    res.json({ ok: true, data: { path: rel, name, type: 'file' } });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to create file' });
  }
});

app.post('/api/tasks-fs/upload', (req, res) => {
  try {
    const payload = req.body || {};
    const parent = String(payload.parent || '');
    // Relative path under parent, e.g. "pkg/util.py" or just "a.py".
    // Folder upload sends webkitRelativePath-style paths so we mkdir -p.
    const rawRel = String(payload.relativePath || payload.path || payload.name || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .trim();
    if (!rawRel) return res.status(400).json({ message: 'Invalid file name' });
    const parts = rawRel.split('/').filter(Boolean);
    if (!parts.length || parts.some((p) => p === '..' || p === '.' || !p)) {
      return res.status(400).json({ message: 'Invalid relative path' });
    }
    // Skip junk that browsers sometimes include from folder pick
    if (parts.some((p) => p === '__pycache__' || p === '.git' || p === 'node_modules')) {
      return res.status(400).json({ message: 'Skipped system/cache path' });
    }
    const fileName = parts[parts.length - 1];
    if (!fileName || fileName === '..') {
      return res.status(400).json({ message: 'Invalid file name' });
    }
    const encoding = String(payload.encoding || 'utf8').toLowerCase();
    let buf;
    if (encoding === 'base64') {
      buf = Buffer.from(String(payload.content || ''), 'base64');
    } else {
      buf = Buffer.from(String(payload.content || ''), 'utf8');
    }
    if (buf.length > TASKS_MAX_UPLOAD) {
      return res.status(400).json({ message: `File too large (max ${TASKS_MAX_UPLOAD} bytes)` });
    }
    const { rel: parentRel } = resolveUnderTasks(parent);
    // Full path under tasks/: parent + relativePath (with intermediate dirs)
    const underParent = parts.join('/');
    const fullRel = parentRel ? `${parentRel}/${underParent}` : underParent;
    const { abs: target } = resolveUnderTasks(fullRel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buf);
    res.json({
      ok: true,
      data: {
        path: fullRel.replace(/\\/g, '/'),
        name: fileName,
        size: buf.length,
        relativePath: underParent,
      },
    });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to upload' });
  }
});

app.post('/api/tasks-fs/rename', (req, res) => {
  try {
    const payload = req.body || {};
    const { abs: fromAbs, rel: fromRel } = resolveUnderTasks(payload.path || '');
    const newName = path.basename(String(payload.newName || payload.name || '').trim());
    if (!newName || newName === '..') return res.status(400).json({ message: 'Invalid name' });
    if (!fs.existsSync(fromAbs)) return res.status(404).json({ message: 'Not found' });
    const toAbs = path.join(path.dirname(fromAbs), newName);
    const root = path.resolve(config.paths.tasksDir);
    if (!toAbs.startsWith(root + path.sep) && toAbs !== root) {
      return res.status(400).json({ message: 'Invalid target' });
    }
    if (fs.existsSync(toAbs)) return res.status(409).json({ message: 'Target exists' });
    const bound = listTasksBoundToPath(fromRel);
    if (bound.length) {
      return res.status(409).json({
        message: `仍被 ${bound.length} 个任务引用，请先改任务脚本路径`,
        tasks: bound.map((t) => ({ id: t.id, name: t.name })),
      });
    }
    fs.renameSync(fromAbs, toAbs);
    const parentRel = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/')) : '';
    const toRel = parentRel ? `${parentRel}/${newName}` : newName;
    res.json({ ok: true, data: { path: toRel, name: newName } });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to rename' });
  }
});

app.delete('/api/tasks-fs', (req, res) => {
  try {
    const raw = String((req.body && req.body.path) || req.query.path || '').trim();
    const { abs, rel } = resolveUnderTasks(raw);
    if (!rel) return res.status(400).json({ message: 'Cannot delete tasks root' });
    if (!fs.existsSync(abs)) return res.status(404).json({ message: 'Not found' });
    const bound = listTasksBoundToPath(rel);
    if (bound.length) {
      return res.status(409).json({
        message: `仍被 ${bound.length} 个任务使用，请先改任务或删任务`,
        tasks: bound.map((t) => ({ id: t.id, name: t.name })),
      });
    }
    fs.rmSync(abs, { recursive: true, force: true });
    res.json({ ok: true, data: { path: rel } });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to delete' });
  }
});

app.post('/api/scripts/import', (req, res) => {
  try {
    const payload = req.body || {};
    const name = path.basename(String(payload.name || '')).trim();
    const content = String(payload.content || '');
    const ext = path.extname(name).toLowerCase();
    if (!name) return res.status(400).json({ message: 'Script name is required' });
    if (!['.js', '.py'].includes(ext)) return res.status(400).json({ message: 'Only .js and .py scripts are supported' });
    if (!content.trim()) return res.status(400).json({ message: 'Script content is required' });
    fs.mkdirSync(config.paths.tasksDir, { recursive: true });
    const fileType = ext === '.py' ? 'python' : 'javascript';
    const overwrite = payload.overwrite === false || payload.overwrite === 0 || payload.overwrite === '0'
      ? false
      : true;
    let finalName = name;
    if (!overwrite) {
      finalName = reserveUniqueScriptFilename(name.slice(0, -ext.length), fileType);
    }
    const target = path.join(config.paths.tasksDir, finalName);
    const existed = fs.existsSync(target);
    fs.writeFileSync(target, content, 'utf8');
    res.json({
      data: {
        name: finalName,
        path: `tasks/${finalName}`,
        type: fileType,
        overwritten: Boolean(existed),
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Failed to save script' });
  }
});

app.delete('/api/scripts', (req, res) => {
  try {
    const raw = String((req.body && (req.body.path || req.body.name)) || req.query.path || req.query.name || '').trim();
    if (!raw) return res.status(400).json({ message: 'Script path is required' });
    const fileName = path.basename(raw.replace(/^tasks[\\/]/, ''));
    const ext = path.extname(fileName).toLowerCase();
    if (!['.js', '.py'].includes(ext)) {
      return res.status(400).json({ message: 'Only .js and .py scripts can be deleted' });
    }
    const target = path.join(config.paths.tasksDir, fileName);
    if (!fs.existsSync(target)) {
      return res.status(404).json({ message: 'Script not found' });
    }
    const rel = `tasks/${fileName}`;
    const bound = db.listTasks().filter((t) => String(t.script_path || '').replace(/\\/g, '/') === rel);
    if (bound.length) {
      return res.status(409).json({
        message: `脚本仍被 ${bound.length} 个任务使用，请先改任务脚本或删任务`,
        tasks: bound.map((t) => ({ id: t.id, name: t.name })),
      });
    }
    fs.unlinkSync(target);
    res.json({ ok: true, data: { name: fileName, path: rel } });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Failed to delete script' });
  }
});

app.post('/api/tasks/:id/run', async (req, res) => {
  try {
    const profileId = req.body && req.body.profile_id ? Number(req.body.profile_id) : null;
    const response = await triggerTaskExecution(Number(req.params.id), { profileId });
    res.status(response.status).json(response.payload);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.post('/api/tasks/:id/stop', (req, res) => {
  const id = Number(req.params.id);
  const stopped = stopTask(id);
  if (!stopped) {
    return res.status(404).json({ message: 'No running task can be stopped right now' });
  }
  res.json({ ok: true, stopped: true });
});


function classifyScreenshotName(name) {
  const lower = String(name || '').toLowerCase().replace(/\\/g, '/');
  if (lower.includes('yolo_hard/miss/') || lower.includes('/miss/')) return 'hard_miss';
  if (lower.includes('yolo_hard/wrong/') || lower.includes('/wrong/')) return 'hard_wrong';
  if (lower.includes('yolo_hard/grids/')) return 'hard_grid';
  if (lower.includes('yolo_hard/')) return 'hard';
  if (lower.includes('yolo_tile')) return 'tile';
  if (lower.startsWith('instr_')) return 'instr';
  if (lower.includes('_grid.png') || lower.includes('yolo_grid')) return 'grid';
  if (lower.startsWith('table_')) return 'table';
  if (lower.includes('host2play') || lower.includes('success') || lower.includes('fail')) return 'final';
  return 'other';
}

function toPublicAssetPath(absPath, kind) {
  if (!absPath) return '';
  const normalized = String(absPath).replace(/\\/g, '/');
  if (kind === 'screenshots') {
    const marker = '/screenshots/';
    const idx = normalized.lastIndexOf(marker);
    if (idx >= 0) return normalized.slice(idx + 1);
  }
  if (kind === 'logs') {
    const marker = '/logs/';
    const idx = normalized.lastIndexOf(marker);
    if (idx >= 0) return normalized.slice(idx + 1);
  }
  return '';
}

// Task-name slugs can contain non-ASCII (e.g. Chinese), so percent-encode each
// segment before it becomes an <img src>. Slashes stay as separators.
function toPublicAssetUrl(relPath) {
  return `/${String(relPath).split('/').map(encodeURIComponent).join('/')}`;
}

function listImageFilesRecursive(rootDir, subDir = '') {
  const abs = subDir ? path.join(rootDir, subDir) : rootDir;
  if (!abs || !fs.existsSync(abs)) return [];
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = subDir ? path.join(subDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      out.push(...listImageFilesRecursive(rootDir, rel));
    } else if (entry.isFile() && /\.(png|jpe?g|webp|gif)$/i.test(entry.name)) {
      out.push(rel.replace(/\\/g, '/'));
    }
  }
  return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

function listRunScreenshots(run) {
  const items = [];
  const dir = run && run.screenshots_dir ? String(run.screenshots_dir) : '';
  if (dir && fs.existsSync(dir)) {
    // Include nested yolo_hard/ so train samples show up in the gallery.
    const names = listImageFilesRecursive(dir);
    for (const name of names) {
      const abs = path.join(dir, name);
      let stat = null;
      try { stat = fs.statSync(abs); } catch { stat = null; }
      const rel = toPublicAssetPath(abs, 'screenshots');
      if (!rel) continue;
      items.push({
        name,
        kind: classifyScreenshotName(name),
        url: toPublicAssetUrl(rel),
        size: stat ? stat.size : 0,
        mtime: stat ? stat.mtime.toISOString() : null,
      });
    }
  }

  if (!items.length && run && run.screenshot_path && fs.existsSync(run.screenshot_path)) {
    const abs = run.screenshot_path;
    let stat = null;
    try { stat = fs.statSync(abs); } catch { stat = null; }
    const rel = toPublicAssetPath(abs, 'screenshots');
    if (rel) {
      items.push({
        name: path.basename(abs),
        kind: 'final',
        url: toPublicAssetUrl(rel),
        size: stat ? stat.size : 0,
        mtime: stat ? stat.mtime.toISOString() : null,
      });
    }
  }
  return items;
}

app.get('/api/runs/:id/screenshots', (req, res) => {
  const run = db.getRun(Number(req.params.id));
  if (!run) return res.status(404).json({ message: 'Run not found' });
  const items = listRunScreenshots(run);
  res.json({
    data: {
      runId: run.id,
      taskId: run.task_id,
      screenshotsDir: run.screenshots_dir || null,
      count: items.length,
      items,
    },
  });
});

/** 按字节读取 UTF-8 文本块，nextOffset 始终落在完整字符边界。 */
function readUtf8Chunk(filePath, offset, limit, size) {
  const start = Math.min(Math.max(Number(offset) || 0, 0), size);
  const length = Math.min(Math.max(Number(limit) || 256 * 1024, 1024), 1024 * 1024, size - start);
  if (!length) return { content: '', offset: start, nextOffset: start, eof: true };
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(length);
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  let validLength = length;
  while (validLength > 0) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, validLength));
      break;
    } catch {
      validLength -= 1;
      if (length - validLength > 3) {
        validLength = length;
        break;
      }
    }
  }
  return {
    content: buffer.subarray(0, validLength).toString('utf8'),
    offset: start,
    nextOffset: start + validLength,
    eof: start + validLength >= size,
  };
}

/** 读取任务运行日志：默认返回末尾 tail 行；offset/limit 用于分段加载全文。 */
app.get('/api/runs/:id/log', (req, res) => {
  const run = db.getRun(Number(req.params.id));
  if (!run) return res.status(404).json({ message: 'Run not found' });

  const logPath = run.log_path;
  if (!logPath || !fs.existsSync(logPath)) {
    return res.status(404).json({ message: 'Log file not found' });
  }

  const full = String(req.query.full || '') === '1' || String(req.query.full || '') === 'true';
  const tail = Math.min(Math.max(Number(req.query.tail) || 120, 20), 2000);
  const stat = fs.statSync(logPath);
  const hasOffset = req.query.offset !== undefined;
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const limit = Math.min(Math.max(Number(req.query.limit) || 256 * 1024, 1024), 1024 * 1024);

  let content = '';
  let totalLines = 0;
  let chunk = null;
  let snapshotSize = stat.size;
  try {
    if (hasOffset) {
      chunk = readUtf8Chunk(logPath, offset, limit, stat.size);
      content = chunk.content;
      // Segment responses only need a stable byte range; line count is loaded lazily by the UI.
      totalLines = null;
    } else {
      // content / line count / size 必须来自同一个快照。若先 stat 再 readFile，
      // 并发追加会使正文比返回的 size 更新，客户端字节游标随后就会重复读取。
      const snapshot = fs.readFileSync(logPath);
      snapshotSize = snapshot.length;
      const snapshotText = snapshot.toString('utf8');
      const allLines = snapshotText.split(/\r?\n/);
      totalLines = allLines.length;
      content = full ? snapshotText : allLines.slice(Math.max(0, totalLines - tail)).join('\n');
    }
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to read log' });
  }

  // 摘要只从当前返回内容提取；分段模式不会为摘要再次扫描整个大文件。
  function extractSection(name, maxLines = 40) {
    const marker = `========== ${name} ==========`;
    const start = content.indexOf(marker);
    if (start < 0) return '';
    const after = content.slice(start);
    const next = after.indexOf('\n========== ', marker.length);
    const body = next > 0 ? after.slice(0, next) : after;
    return body.split(/\r?\n/).slice(0, maxLines).join('\n');
  }

  const summaryParts = [
    extractSection('TASK SUMMARY', 30),
    extractSection('DEBUG SUMMARY', 20),
    extractSection('WORKER RESULT PAYLOAD', 40),
  ].filter(Boolean);
  const logHref = `/${String(logPath).replace(/^.*?(logs\/)/, '$1').replace(/\\/g, '/')}`;
  const data = {
    runId: run.id,
    taskId: run.task_id,
    status: run.status,
    errorCode: run.error_code || null,
    startedAt: run.started_at,
    endedAt: run.ended_at,
    logPath,
    logUrl: logHref,
    totalLines,
    tail,
    full,
    summary: summaryParts.join('\n\n'),
    content,
    size: snapshotSize,
  };
  if (chunk) Object.assign(data, chunk);
  res.json({ data });
});

app.get('/api/runs/:id/log/download', (req, res) => {
  const run = db.getRun(Number(req.params.id));
  if (!run) return res.status(404).json({ message: 'Run not found' });
  if (!run.log_path || !fs.existsSync(run.log_path)) {
    return res.status(404).json({ message: 'Log file not found' });
  }
  const abs = path.resolve(run.log_path);
  const root = path.resolve(config.paths.logsDir);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return res.status(400).json({ message: 'Invalid log path' });
  }
  return res.download(abs, `run-${run.id}.log`);
});

app.get('/api/runs/:id/log/stream', (req, res) => {
  const run = db.getRun(Number(req.params.id));
  if (!run) return res.status(404).json({ message: 'Run not found' });
  if (!run.log_path || !fs.existsSync(run.log_path)) {
    return res.status(404).json({ message: 'Log file not found' });
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  if (res.socket && typeof res.socket.setNoDelay === 'function') res.socket.setNoDelay(true);
  const cleanup = logStream.subscribe(run.log_path, res);
  // subscribe 后重新读状态，封住“初始查询仍 running、订阅前任务刚结束”的窗口。
  // 这段是同步执行：若完成发生在重读之后，全局 logStream.end 会命中该客户端。
  const latestRun = db.getRun(run.id) || run;
  if (latestRun.status !== 'running') {
    logStream.endClient(run.log_path, res, { status: latestRun.status });
  }
  res.on('close', cleanup);
});

app.get('/api/tasks/:id/runs', (req, res) => {
  res.json({ data: db.listRunsByTask(Number(req.params.id)) });
});

app.get('/api/runs', (req, res) => {
  res.json({ data: db.listRuns(100) });
});

app.get('/api/storage/cleanup/preview', (req, res) => {
  try {
    const categories = req.query.categories
      ? normalizeCategories(String(req.query.categories).split(',').filter(Boolean))
      : undefined;
    const data = cleanupStorage(db, {
      dryRun: true,
      retentionDays: normalizeRetentionDays(req.query.retentionDays),
      categories,
      runningTaskIds: getRunningTaskIds(),
    });
    res.json({ data });
  } catch (error) {
    res.status(400).json({ message: error.message || '生成存储清理预览失败' });
  }
});

app.post('/api/storage/cleanup', (req, res) => {
  try {
    const body = req.body || {};
    const data = cleanupStorage(db, {
      dryRun: body.dryRun === true,
      retentionDays: normalizeRetentionDays(body.retentionDays),
      categories: normalizeCategories(body.categories),
      runningTaskIds: getRunningTaskIds(),
    });
    events.emit('runs', { cleanup: true });
    res.json({ data });
  } catch (error) {
    res.status(400).json({ message: error.message || '存储清理失败' });
  }
});

app.post('/api/runs/cleanup', (req, res) => {
  try {
    const data = cleanupStorage(db, {
      dryRun: false,
      retentionDays: 30,
      categories: ['runArtifacts'],
      runningTaskIds: getRunningTaskIds(),
      pruneOldRunRows: true,
    });
    events.emit('runs', { cleanup: true });
    res.json({ ok: data.failures.length === 0, data });
  } catch (error) {
    res.status(400).json({ message: error.message || '运行记录清理失败' });
  }
});

// 备份导出/导入。挂在 requireAuth 下方——导出文件含任务脚本源码,
// 且在加密模式下含密钥(虽已加密,但密码是用户自己给的,强度不由我们保证)。
//
// 导出用 POST 不用 GET:密码走 body。放 query 会进 access log、浏览器历史
// 和 Referer,那等于把密码明文写了三份。
app.post('/api/backup/export', (req, res) => {
  try {
    const body = req.body || {};
    // 空串 / 只有空白 一律当作"不加密"。别让用户以为按了空格就加密了。
    const passphrase = typeof body.passphrase === 'string' && body.passphrase.trim().length
      ? body.passphrase
      : null;
    const result = backup.exportBackup({
      taskIds: backup.normalizeTaskIds(body.task_ids),
      passphrase,
    });
    const exportDate = new Date();
    const filename = backup.buildExportFilename(exportDate, result.header);
    const fallbackFilename = backup.buildExportFilename(exportDate, {
      ...result.header,
      taskName: result.header.taskName ? 'task' : '',
    });
    res.setHeader('Content-Type', result.header.encrypted
      ? 'application/octet-stream'
      : 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fallbackFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    res.send(result.data);
  } catch (error) {
    res.status(400).json({ message: error.message || '导出备份失败' });
  }
});

app.post('/api/backup/preview', (req, res) => {
  try {
    const body = req.body || {};
    const parsed = backup.parseBackup(
      body.backup !== undefined ? body.backup : body,
      { passphrase: body.passphrase },
    );
    const plan = backup.analyze(parsed, {
      script_strategy: body.script_strategy,
      task_strategy: body.task_strategy,
    });
    res.json({ data: backup.toPreview(plan) });
  } catch (error) {
    res.status(400).json({ message: error.message || '解析备份文件失败' });
  }
});

app.post('/api/backup/import', (req, res) => {
  try {
    const body = req.body || {};
    const data = backup.importBackup(body.backup !== undefined ? body.backup : body, {
      script_strategy: body.script_strategy,
      task_strategy: body.task_strategy,
      passphrase: body.passphrase,
    });
    reloadJobs(executeTask);
    events.emit('tasks', { imported: true });
    res.json({ data });
  } catch (error) {
    res.status(400).json({ message: error.message || '导入备份失败' });
  }
});

app.get('/api/meta', (req, res) => {
  res.json({
    data: {
      browser: config.browser,
      paths: {
        tasksDir: config.paths.tasksDir,
        logsDir: config.paths.logsDir,
        screenshotsDir: config.paths.screenshotsDir,
        runtimeDataDir: path.join(config.paths.root, 'runtime-data'),
      },
    },
  });
});

app.use((req, res) => {
  res.sendFile(path.join(config.paths.publicDir, 'index.html'));
});

const httpServer = app.listen(config.server.port, config.server.host, () => {
  reloadJobs(executeTask);
  void ensureTelegramWebhook();
  void warpManager.restore();
  // 云端备份定时器：启动时先把 next_at 算好（若缺失），再挂 60s 的轮询。
  try {
    cloudBackup.ensureScheduled();
  } catch (err) {
    console.error('[boot] cloud backup schedule init failed:', err.message || err);
  }
  cloudBackup.startTicker();
  try {
    prepareBrowserWorkspace();
  } catch (err) {
    console.error('[boot] browser workspace not ready:', err.message || err);
  }
  try {
    db.purgeExpiredSessions();
  } catch (err) {
    console.error('[boot] purge sessions failed:', err.message || err);
  }
  // 异步补一次 tag,不等它 —— 拉到之前面板显示的是旧标签,拉完自动刷新
  refreshTags();
  console.log(`Panel running on http://${config.server.host}:${config.server.port}`);
  if (!db.hasAnyUser()) {
    console.log('[auth] 尚未设置管理员账号 — 首次打开面板会进入引导页');
  }
  if (config.server.host === '0.0.0.0') {
    console.warn(
      '[auth] 警告：面板监听 0.0.0.0 且为明文 HTTP，密码在链路上可被嗅探。'
      + '建议改绑 127.0.0.1 走 SSH 隧道，或前置 nginx + TLS。',
    );
  }
});

// 可复用的停机序列：停调度 → 断 SSE → 停 WARP → 关库。
// SIGTERM 路径之外，云端备份的恢复流程也要用它（关库后才能动 app.db）。
// 注意这里不能关 httpServer —— 恢复请求本身就挂在 httpServer 上，等它关完就是死锁，
// 关 httpServer 只留在真正退出的 shutdown() 里做。
async function closeCoreServices(reason) {
  console.log(`[shutdown] ${reason}`);
  stopAllJobs();
  events.closeAll();
  await warpManager.shutdown();
  db.db.close();
}

let shutdownPromise = null;
function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    await closeCoreServices(`received ${signal}`);
    await new Promise((resolve) => httpServer.close(resolve));
  })().catch((error) => {
    console.error('[shutdown] failed:', error);
    process.exitCode = 1;
  });
  return shutdownPromise;
}

// 恢复的换文件回调：停掉会碰库的定时器 → 走停机序列关库 → 旧数据挪到
// data/pre-restore-<stamp>/ 留作回滚 → 快照内容落盘。返回 pre-restore 目录给 UI 展示。
cloudBackup.setPerformRestoreSwap(async (stagingDir) => {
  cloudBackup.stopTicker();
  await closeCoreServices('restore swap');
  return cloudBackup.swapDataDir(stagingDir);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => process.exit());
  });
}
