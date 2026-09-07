const fs = require('fs');
const path = require('path');
const express = require('express');
const { createApplication } = require('./app');
const { createLifecycle, registerSignalHandlers } = require('./lifecycle');
const { createSettingsRouter } = require('./routes/settings-routes');
const { createEnvRouter } = require('./routes/env-routes');
const { spawnSync } = require('child_process');
const config = require('../config');
const db = require('./db');
const { getVersion, refreshTags } = require('./version');
const { runTask, stopTask, prepareLogForTask } = require('./task-runner');
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
const { createResourceRouter } = require('./resources/router');
const { createTaskGroupRouter } = require('./tasks/group-routes');
const { createTaskService } = require('./tasks/task-service');
const { createTaskRouter } = require('./tasks/task-routes');
const { createScriptService } = require('./tasks/script-service');
const { createImportRouter } = require('./tasks/import-routes');
const { createRuntimeRouter } = require('./routes/runtime-routes');
const { createConditionRouter } = require('./routes/condition-routes');
const { createMaintenanceRouter } = require('./routes/maintenance-routes');
const { createBrowserRouteHelpers, createBrowserStatusRouter, createBrowserRuntimeRouter, createBrowserProfileRouter } = require('./routes/browser-routes');
const { createTelegramRouteHandlers } = require('./routes/telegram-routes');
const { createTaskStorageRouter } = require('./routes/task-storage-routes');
const { createSystemRouteRegistrars } = require('./routes/system-routes');
const { getSuccessHeuristicSettings, setSuccessHeuristicSettings } = require('./runtime/success-heuristics');
const { testVisionChannel } = require('./runtime/vision-test');
const {
  normalizeTaskType,
  slugifyScriptName,
  buildTaskScriptFilename,
  resolveTaskScriptPath,
} = require('./tasks/task-payload');

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

const {
  registerPublicRoutes,
  registerEventRoutes,
  registerSettingsRoutes,
  registerProfileEnvRoutes,
  registerRunArtifactRoutes,
} = createSystemRouteRegistrars({
  fs,
  path,
  db,
  events,
  logStream,
  cleanupStorage,
  getRunningTaskIds,
  normalizeEnvEntriesPayload,
  normalizeVisionSettingsPayload,
  readUtf8Chunk,
  getVersion,
  getSuccessHeuristicSettings,
  setSuccessHeuristicSettings,
  testVisionChannel,
  logsDir: config.paths.logsDir,
});

const app = createApplication((app) => {

// --- 鉴权分界线 -------------------------------------------------------------
// 顺序有讲究，别把 requireAuth 往下挪：
// express.static(publicDir) 一旦排在前面，index.html 会在鉴权之前就被送出去，
// 中间件等于没挂。同理 /tasks /logs /screenshots 三个静态目录必须在线下方——
// 它们分别暴露任务脚本源码、日志里的 token、以及可能含已登录账号页面的截图。
app.use('/api/auth', authRouter);
// 版本号不含任何敏感信息,放鉴权之前 —— 登录页也能显示,排查"哪台机器跑着哪个版本"不用登录
registerPublicRoutes(app);
app.use(requireAuth);
app.use('/api/extensions-fs', createResourceRouter({
  rootDir: config.paths.extensionsDir,
  label: '插件管理',
}));
app.use('/api/profiles-fs', createResourceRouter({
  rootDir: config.paths.profilesDir,
  label: '用户目录',
  // 当前运行状态无法可靠映射到具体子目录时，优先采取保守保护：
  // 任意手动浏览器或浏览器任务运行期间，不允许修改 Profile 文件树。
  isBusy: () => getManualBrowserStatus().open || isAnyBrowserTaskRunning(),
}));
app.use('/api/warp', createWarpRouter(warpManager));
// 云端备份快照里含全部密钥（代理凭据、面板账号、WARP），必须挂在 requireAuth 之后。
app.use('/api/cloud-backup', createCloudBackupRouter(cloudBackup));
app.use('/api/task-groups', createTaskGroupRouter(db));
// --- 以下全部需要登录 -------------------------------------------------------

// 状态推送（SSE）。放在鉴权之后，所以未登录连不上；放在 express.static 之前，
// 免得将来 public/ 下真出现同名文件把它顶掉。
//
// 事件只是"某某变了，自己去拉"的信号，不带状态本体：前端复用已有的 loadTasks /
// loadRuns / loadBrowserStatus，服务端不用再维护一份序列化逻辑，而且拉取走
// fetchJson，会话过期时能正常走 401 跳登录页那条路（长连接本身只在建立时鉴权，
// 之后哪怕会话过期了连接也不会自己断）。
registerEventRoutes(app);

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

app.use(createBrowserStatusRouter({ getManualBrowserStatus }));

const browserRouteHelpers = createBrowserRouteHelpers({ db, proxyModes: PROXY_MODES });
app.use(createBrowserRuntimeRouter({ db, config, spawnSync, resolveNpmCommand, runBashCommand, helpers: browserRouteHelpers }));

const telegramRouteHandlers = createTelegramRouteHandlers({
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
});
app.get('/api/settings/telegram', telegramRouteHandlers.getSettings);
app.post('/api/settings/telegram', telegramRouteHandlers.saveSettings);
app.post('/api/settings/telegram/test', telegramRouteHandlers.testSettings);

app.use('/api/settings', createSettingsRouter({ db, getRunningTaskIds }));

registerSettingsRoutes(app);







/**
 * 只切某个通道的 model，其他字段（尤其是 key）原样保留。
 * 给前端「模型下拉点选即生效」用：走全量保存会连带写入用户还在编辑、并不想保存的字段。
 */


/**
 * Test Vision channel: connectivity (/models) + optional image chat/completions.
 * Body may include draft channel from the form (apiKey empty → use THAT channel's saved key).
 * Never fall back to primary key for a non-primary baseUrl (causes false INVALID_API_KEY).
 */


app.post('/api/telegram/webhook/:token', telegramRouteHandlers.receiveWebhook);

app.use(createBrowserProfileRouter({ db, isAnyBrowserTaskRunning, buildSchedulerBusyPayload, openManualBrowser, closeManualBrowser, helpers: browserRouteHelpers }));

app.use('/api/env', createEnvRouter({ db, normalizeEnvEntriesPayload }));





registerProfileEnvRoutes(app);



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

const taskService = createTaskService({
  db,
  normalizeTaskEnvPayload,
  applyTaskEnvPayload,
  decorateTaskForApi,
  buildConditionFieldsFromPayload,
  resolveTaskGroupId,
  normalizeExtraPathsPayload,
  reloadJobs,
  executeTask,
  isTaskRunning,
});
const scriptService = createScriptService({
  tasksDir: config.paths.tasksDir,
  listTasks: () => db.listTasks(),
  scanTaskDependencies: (scriptPath) => backup.scanTaskDependencies(scriptPath),
  normalizeExtraPaths: (value) => backup.normalizeExtraPaths(value),
});
app.use('/api/tasks', createTaskRouter(taskService));

app.use('/api', createConditionRouter({
  db,
  listConditionTypes,
  parseConditionJson,
  normalizeConditionPayload,
  evaluateTaskCondition,
}));

app.use('/api', createTaskStorageRouter({
  fs,
  path,
  tasksDir: config.paths.tasksDir,
  listTasks: () => db.listTasks(),
}));


app.use('/api', createImportRouter({ scriptService }));


app.use('/api', createRuntimeRouter({
  triggerTaskExecution,
  stopTask,
  listRunsByTask: (taskId) => db.listRunsByTask(taskId),
  listRuns: (limit) => db.listRuns(limit),
}));


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

registerRunArtifactRoutes(app);

/** 读取任务运行日志：默认返回末尾 tail 行；offset/limit 用于分段加载全文。 */








app.use('/api', createMaintenanceRouter({
  backup,
  cleanupStorage,
  normalizeRetentionDays,
  normalizeCategories,
  db,
  getRunningTaskIds,
  reloadJobs,
  executeTask,
  emit: (...args) => events.emit(...args),
  meta: {
    browser: config.browser,
    paths: {
      tasksDir: config.paths.tasksDir,
      logsDir: config.paths.logsDir,
      screenshotsDir: config.paths.screenshotsDir,
      runtimeDataDir: path.join(config.paths.root, 'runtime-data'),
    },
  },
}));

app.use((req, res) => {
  res.sendFile(path.join(config.paths.publicDir, 'index.html'));
});
});

function onServerStarted() {
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
}

const lifecycle = createLifecycle({
  app,
  port: config.server.port,
  host: config.server.host,
  onStarted: onServerStarted,
  closeCoreServices,
});

function startServer() {
  return lifecycle.startServer();
}

// 可复用的停机序列：停调度 → 断 SSE → 停 WARP → 关库。
// SIGTERM 路径之外，云端备份的恢复流程也要用它（关库后才能动 app.db）。
// 注意这里不能关 httpServer —— 恢复请求本身就挂在 httpServer 上，等它关完就是死锁，
// 关 httpServer 只留在真正退出的 shutdown() 里做。
async function closeCoreServices(reason) {
  console.log(`[shutdown] ${reason}`);
  stopAllJobs();
  cloudBackup.stopTicker();
  events.closeAll();
  await warpManager.shutdown();
  db.db.close();
}

function shutdown(signal) {
  return lifecycle.shutdown(signal);
}

// 恢复的换文件回调：停掉会碰库的定时器 → 走停机序列关库 → 旧数据挪到
// data/pre-restore-<stamp>/ 留作回滚 → 快照内容落盘。返回 pre-restore 目录给 UI 展示。
cloudBackup.setPerformRestoreSwap(async (stagingDir) => {
  cloudBackup.stopTicker();
  await closeCoreServices('restore swap');
  return cloudBackup.swapDataDir(stagingDir);
});

module.exports = {
  app,
  startServer,
  closeCoreServices,
  shutdown,
  registerSignals() {
    registerSignalHandlers(shutdown);
  },
};
