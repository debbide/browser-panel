const fs = require('fs');
const path = require('path');
const express = require('express');
const { spawnSync } = require('child_process');
const config = require('../config');
const db = require('./db');
const { runTask, stopTask, prepareLogForTask } = require('./task-runner');
const { reloadJobs, isTaskRunning, runTaskSafely, computeNextRun } = require('./scheduler');
const { openManualBrowser, closeManualBrowser, getManualBrowserStatus, prepareBrowserWorkspace } = require('./browser');
const { notifyTaskRun, sendTelegramTestMessage, isTelegramConfigured, maskTelegramToken, answerTelegramCallback } = require('./telegram');

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

  const result = await runTask(effectiveTask, { logPath: run.log_path });
  const stoppedByUser = result.errorCode === 'stopped';
  const completedRun = db.updateRun(run.id, {
    status: stoppedByUser ? 'stopped' : result.status,
    ended_at: result.endedAt,
    exit_code: result.exitCode,
    log_path: result.logPath,
    screenshot_path: result.screenshotPath,
    screenshots_dir: result.screenshotsDir || null,
    error_text: result.errorText,
    error_code: result.errorCode || null,
    retryable: result.retryable ?? null,
    retry_reason: result.retryReason ?? null,
  });

  if (refreshScheduleOnSuccess && completedRun.status === 'success') {
    refreshNextRunAfterSuccessfulManualRun(task);
  }

  void notifyTaskRun(task, completedRun);
  return completedRun;
}

async function triggerTaskExecution(taskId, options = {}) {
  if (getManualBrowserStatus().open) {
    return { ok: false, status: 409, payload: { message: 'Browser is open manually, close it before running tasks', code: 'browser_already_open' } };
  }

  const profileId = options && options.profileId ? Number(options.profileId) : null;
  if (profileId && !db.getBrowserProfile(profileId)) {
    return { ok: false, status: 400, payload: { message: 'Selected browser profile not found', code: 'invalid_browser_profile' } };
  }

  const result = await runTaskSafely(Number(taskId), (id) => executeTask(id, { refreshScheduleOnSuccess: true, profileId }));
  if (result?.skipped) {
    return { ok: false, status: 409, payload: { message: 'Task is already running', code: result.reason } };
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
  if (getManualBrowserStatus().open) {
    return { ok: false, message: 'Browser is open manually, close it before running tasks' };
  }

  const taskIdNum = Number(taskId);
  const result = await runTaskSafely(taskIdNum, async (id) => {
    setImmediate(async () => {
      try {
        await executeTask(id, { refreshScheduleOnSuccess: true });
      } catch (error) {
        console.warn('[telegram] retry trigger failed:', error.message);
      }
    });
    return { queued: true };
  });

  if (result?.skipped) {
    return { ok: false, message: 'Task is already running' };
  }

  return { ok: true, message: 'Retry started' };
}

function normalizeTelegramSettingsResponse() {
  const settings = db.getTelegramSettings();
  return {
    configured: isTelegramConfigured(settings),
    chatId: settings.chatId || '',
    botTokenMasked: maskTelegramToken(settings.botToken),
    proxy: settings.proxy || '',
  };
}

function resolveTelegramSettingValue(incomingValue, existingValue) {
  const value = String(incomingValue || '').trim();
  if (value) return value;
  return existingValue || null;
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

function applyTaskEnvPayload(taskId, payload = {}) {
  if (Array.isArray(payload.env)) {
    db.replaceEnvEntries('task', taskId, normalizeEnvEntriesPayload(payload.env));
    return db.syncTaskParamsJsonFromEnv(taskId);
  }
  // Legacy: flat params / params_json object
  if (payload.params !== undefined || payload.params_json !== undefined) {
    const params = normalizeTaskParams(payload.params ?? payload.params_json);
    db.setTaskEnvFromParams(taskId, params);
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
  return {
    ...task,
    env,
    params,
    params_json: JSON.stringify(params),
  };
}

function normalizeVisionSettingsPayload(payload = {}) {
  const out = {
    baseUrl: payload.baseUrl !== undefined ? String(payload.baseUrl || '').trim() : undefined,
    model: payload.model !== undefined ? String(payload.model || '').trim() : undefined,
    apiKey: payload.apiKey !== undefined ? String(payload.apiKey || '').trim() : undefined,
    channels: payload.channels !== undefined ? String(payload.channels || '').trim() : undefined,
  };
  // 动态通道卡片：[{baseUrl, apiKey, model}]（apiKey 留空=不改）。第 1 项为主通道。
  if (Array.isArray(payload.channelList)) {
    out.channelList = payload.channelList.map((c) => ({
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

function normalizeProfileRuntimeStack(value) {
  const stack = String(value || '').trim().toLowerCase();
  if (!stack) return '';
  if (stack === 'playwright' || stack === 'seleniumbase') return stack;
  throw new Error('Invalid runtime stack, only playwright or seleniumbase');
}

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function normalizeRuntimeStack(value) {
  const stack = String(value || '').trim().toLowerCase();
  if (stack === 'seleniumbase') return 'seleniumbase';
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

  if (pluginPackages.includes('playwright-stealth')) {
    throw new Error('playwright-stealth 这个包是占位包，请改用 puppeteer-extra-plugin-stealth');
  }

  const invalidPackage = pluginPackages.find(item => !validatePluginPackageName(item));
  if (invalidPackage) {
    throw new Error(`插件包名不合法: ${invalidPackage}`);
  }

  return {
    runtimeStack,
    usePlaywrightExtra: runtimeStack === 'playwright' && (usePlaywrightExtra || pluginPackages.length > 0),
    pluginPackages: pluginPackages.join(','),
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
app.use(express.json({ limit: '1mb' }));
app.use(express.static(config.paths.publicDir));
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

app.post('/api/settings/telegram', (req, res) => {
  const payload = req.body || {};
  const current = db.getTelegramSettings();
  const botToken = resolveTelegramSettingValue(payload.botToken, current.botToken);
  const chatId = resolveTelegramSettingValue(payload.chatId, current.chatId);

  if (!botToken || !chatId) {
    return res.status(400).json({ message: 'Bot Token and Chat ID are required' });
  }

  db.setSetting('telegram_bot_token', botToken);
  db.setSetting('telegram_chat_id', chatId);
  
  if (payload.proxy !== undefined) {
    db.setSetting('telegram_proxy', String(payload.proxy).trim());
  }

  res.json({ data: normalizeTelegramSettingsResponse() });
});

app.post('/api/settings/telegram/test', async (req, res) => {
  try {
    await sendTelegramTestMessage();
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to send test message' });
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

  try {
    if (!isConfiguredTelegramChat(chatId)) {
      await answerTelegramCallback(settings.botToken, callbackQueryId, 'Current chat is not authorized for this task');
      return res.json({ ok: true });
    }

    if (!parsed) {
      await answerTelegramCallback(settings.botToken, callbackQueryId, 'Unable to recognize this action');
      return res.json({ ok: true });
    }

    const task = db.getTask(parsed.taskId);
    const run = db.getRun(parsed.runId);
    if (!task || !run || run.task_id !== parsed.taskId || run.status !== 'failed' || Number(run.retryable || 0) !== 1) {
      await answerTelegramCallback(settings.botToken, callbackQueryId, 'This failed run is no longer retryable');
      return res.json({ ok: true });
    }

    const result = await triggerTaskExecutionInBackground(parsed.taskId);
    await answerTelegramCallback(settings.botToken, callbackQueryId, result.message);
    return res.json({ ok: true });
  } catch (error) {
    try {
      await answerTelegramCallback(settings.botToken, callbackQueryId, error.message || 'Retry task failed');
    } catch (answerError) {
      console.warn('[telegram] failed to answer callback query:', answerError.message);
    }
    return res.json({ ok: true });
  }
});

app.post('/api/browser/open', async (req, res) => {
  try {
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
    const runtime_stack = normalizeProfileRuntimeStack(req.body?.runtime_stack ?? req.body?.runtimeStack);
    const locale = normalizeProfileLocale(req.body?.locale);
    const timezone_id = normalizeProfileTimezone(req.body?.timezone_id ?? req.body?.timezoneId);
    if (!name) return res.status(400).json({ message: 'Profile name is required' });
    const profile = db.createBrowserProfile({
      name: String(name),
      user_data_dir: normalizeProfileUserDataDir(user_data_dir),
      proxy: normalizeProfileProxy(proxy),
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
    const runtime_stack = normalizeProfileRuntimeStack(req.body?.runtime_stack ?? req.body?.runtimeStack);
    const locale = normalizeProfileLocale(req.body?.locale);
    const timezone_id = normalizeProfileTimezone(req.body?.timezone_id ?? req.body?.timezoneId);
    if (!name) return res.status(400).json({ message: 'Profile name is required' });
    const profile = db.updateBrowserProfile(id, {
      name: String(name),
      user_data_dir: normalizeProfileUserDataDir(user_data_dir),
      proxy: normalizeProfileProxy(proxy),
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

app.get('/api/tasks', (req, res) => {
  const tasks = db.listTasks().map((task) => ({
    ...decorateTaskForApi(task),
    is_running: isTaskRunning(task.id),
  }));
  res.json({ data: tasks });
});

app.post('/api/tasks', (req, res) => {
  try {
    const payload = req.body || {};
    const type = payload.type === 'python' ? 'python' : 'javascript';
    const name = String(payload.name || 'Untitled Task');
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
      next_run_at: payload.next_run_at ? String(payload.next_run_at) : null,
      enabled: payload.enabled ? 1 : 0,
      use_browser: payload.use_browser === false ? 0 : 1,
      use_persistent: parseUsePersistentFlag(payload.use_persistent, 0),
      timeout_sec: Number(payload.timeout_sec || 300),
      params_json: '{}',
      browser_profile_id: payload.browser_profile_id ? Number(payload.browser_profile_id) : null,
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
    const existing = db.getTask(id);
    if (!existing) return res.status(404).json({ message: 'Task not found' });
    const type = payload.type === 'python' ? 'python' : 'javascript';
    const name = String(payload.name || 'Untitled Task');
    const requestedScriptPath = String(payload.script_path || existing?.script_path || '');
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

app.get('/api/scripts', (req, res) => {
  const allowedExts = new Set(['.js', '.py']);
  const files = fs.readdirSync(config.paths.tasksDir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(name => allowedExts.has(path.extname(name)))
    .sort()
    .map(name => ({
      name,
      path: `tasks/${name}`,
      type: path.extname(name) === '.py' ? 'python' : 'javascript',
    }));
  res.json({ data: files });
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
    const uniqueName = reserveUniqueScriptFilename(name.slice(0, -ext.length), fileType);
    const target = path.join(config.paths.tasksDir, uniqueName);
    fs.writeFileSync(target, content, 'utf8');
    res.json({ data: { name: uniqueName, path: `tasks/${uniqueName}`, type: fileType } });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Failed to save script' });
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
  const lower = String(name || '').toLowerCase();
  if (lower.startsWith('instr_')) return 'instr';
  if (lower.includes('_grid.png')) return 'grid';
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

function listRunScreenshots(run) {
  const items = [];
  const dir = run && run.screenshots_dir ? String(run.screenshots_dir) : '';
  if (dir && fs.existsSync(dir)) {
    const names = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp|gif)$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    for (const name of names) {
      const abs = path.join(dir, name);
      let stat = null;
      try { stat = fs.statSync(abs); } catch { stat = null; }
      const rel = toPublicAssetPath(abs, 'screenshots');
      if (!rel) continue;
      items.push({
        name,
        kind: classifyScreenshotName(name),
        url: `/${rel}`,
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
        url: `/${rel}`,
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

/** 读取任务运行日志：默认返回末尾 tail 行 + 摘要 section */
app.get('/api/runs/:id/log', (req, res) => {
  const run = db.getRun(Number(req.params.id));
  if (!run) return res.status(404).json({ message: 'Run not found' });

  const logPath = run.log_path;
  if (!logPath || !fs.existsSync(logPath)) {
    return res.status(404).json({ message: 'Log file not found' });
  }

  const full = String(req.query.full || '') === '1' || String(req.query.full || '') === 'true';
  const tail = Math.min(Math.max(Number(req.query.tail) || 120, 20), 2000);

  let content = '';
  try {
    content = fs.readFileSync(logPath, 'utf8');
  } catch (error) {
    return res.status(500).json({ message: error.message || 'Failed to read log' });
  }

  const allLines = content.split(/\r?\n/);
  const totalLines = allLines.length;

  // 抽出关键 section 摘要（TASK START / SUMMARY / DEBUG / RESULT 头几行）
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

  const tailLines = full ? allLines : allLines.slice(Math.max(0, totalLines - tail));
  const logHref = `/${String(logPath).replace(/^.*?(logs\/)/, '$1').replace(/\\/g, '/')}`;

  res.json({
    data: {
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
      content: tailLines.join('\n'),
    },
  });
});

app.get('/api/tasks/:id/runs', (req, res) => {
  res.json({ data: db.listRunsByTask(Number(req.params.id)) });
});

app.get('/api/runs', (req, res) => {
  res.json({ data: db.listRuns(100) });
});

app.post('/api/runs/cleanup', (req, res) => {
  const rows = db.db.prepare('SELECT MAX(id) as id FROM task_runs GROUP BY task_id').all();
  const keep = new Set(rows.map(row => row.id));
  const allRows = db.listRuns(1000);
  for (const row of allRows) {
    if (!keep.has(row.id)) {
      db.db.prepare('DELETE FROM task_runs WHERE id = ?').run(row.id);
    }
  }
  res.json({ ok: true });
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

app.listen(config.server.port, config.server.host, () => {
  reloadJobs(executeTask);
  try {
    prepareBrowserWorkspace();
  } catch (err) {
    console.error('[boot] browser workspace not ready:', err.message || err);
  }
  console.log(`Panel running on http://${config.server.host}:${config.server.port}`);
});
