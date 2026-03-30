const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('../config');
const db = require('./db');
const { runTask, stopTask } = require('./task-runner');
const { reloadJobs, isTaskRunning, runTaskSafely, computeNextRun } = require('./scheduler');
const { openManualBrowser, closeManualBrowser, getManualBrowserStatus } = require('./browser');
const { notifyTaskRun, sendTelegramTestMessage, isTelegramConfigured, maskTelegramToken, answerTelegramCallback } = require('./telegram');

fs.mkdirSync(config.paths.tasksDir, { recursive: true });
fs.mkdirSync(config.paths.publicDir, { recursive: true });

function refreshNextRunAfterSuccessfulManualRun(task) {
  if (!task?.enabled) return;

  const latestTask = db.getTask(task.id);
  if (!latestTask?.enabled) return;

  const nextRunAt = computeNextRun(latestTask, new Date());
  const updatedTask = db.updateTask(task.id, {
    ...latestTask,
    next_run_at: nextRunAt,
  });

  reloadJobs(executeTask);
  return updatedTask;
}

async function executeTask(id, options = {}) {
  const { refreshScheduleOnSuccess = false } = options;
  const task = db.getTask(id);
  if (!task) throw new Error('Task not found');

  const run = db.createRun(id, {
    status: 'running',
    started_at: new Date().toISOString(),
    ended_at: null,
    exit_code: null,
    log_path: null,
    screenshot_path: null,
    error_text: null,
  });

  const result = await runTask(task);
  const completedRun = db.updateRun(run.id, {
    status: result.status,
    ended_at: result.endedAt,
    exit_code: result.exitCode,
    log_path: result.logPath,
    screenshot_path: result.screenshotPath,
    error_text: result.errorText,
    error_code: result.errorCode || null,
  });

  if (refreshScheduleOnSuccess && completedRun.status === 'success') {
    refreshNextRunAfterSuccessfulManualRun(task);
  }

  void notifyTaskRun(task, completedRun);
  return completedRun;
}

async function triggerTaskExecution(taskId) {
  if (getManualBrowserStatus().open) {
    return { ok: false, status: 409, payload: { message: '浏览器已手动打开，请先关闭后再运行任务', code: 'browser_already_open' } };
  }

  const result = await runTaskSafely(Number(taskId), (id) => executeTask(id, { refreshScheduleOnSuccess: true }));
  if (result?.skipped) {
    return { ok: false, status: 409, payload: { message: '任务正在运行中', code: result.reason } };
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
    return { ok: false, message: '浏览器已手动打开，请先关闭后再运行任务' };
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
    return { ok: false, message: '任务正在运行中' };
  }

  return { ok: true, message: '已开始重试任务' };
}

function normalizeTelegramSettingsResponse() {
  const settings = db.getTelegramSettings();
  return {
    configured: isTelegramConfigured(settings),
    chatId: settings.chatId || '',
    botTokenMasked: maskTelegramToken(settings.botToken),
  };
}

function resolveTelegramSettingValue(incomingValue, existingValue) {
  const value = String(incomingValue || '').trim();
  if (value) return value;
  return existingValue || null;
}

function slugifyScriptName(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
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

  throw new Error('无法为任务分配可用的脚本文件名');
}

function resolveTaskScriptPath(taskName, type, currentScriptPath = '', existingTaskId = null) {
  const normalizedCurrent = String(currentScriptPath || '').replace(/\\/g, '/');
  if (!normalizedCurrent.startsWith('tasks/')) return normalizedCurrent;

  const sharedOwner = db.listTasks().find(task => task.script_path === normalizedCurrent && task.id !== existingTaskId);
  if (sharedOwner) return normalizedCurrent;

  const currentFileName = path.basename(normalizedCurrent);
  const sourcePath = path.join(config.paths.tasksDir, currentFileName);
  if (!fs.existsSync(sourcePath)) return normalizedCurrent;

  const candidateFileName = reserveUniqueScriptFilename(taskName, type, existingTaskId, normalizedCurrent);
  const candidatePath = path.join(config.paths.tasksDir, candidateFileName);

  if (candidateFileName !== currentFileName) {
    fs.renameSync(sourcePath, candidatePath);
  }

  return `tasks/${candidateFileName}`;
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(config.paths.publicDir));
app.use('/tasks', express.static(config.paths.tasksDir));
app.use('/logs', express.static(config.paths.logsDir));
app.use('/screenshots', express.static(config.paths.screenshotsDir));

app.get('/api/tasks', (req, res) => {
  const tasks = db.listTasks().map(task => ({ ...task, is_running: isTaskRunning(task.id) }));
  res.json({ data: tasks });
});

app.get('/api/browser', (req, res) => {
  res.json({ data: getManualBrowserStatus() });
});

app.get('/api/settings/telegram', (req, res) => {
  res.json({ data: normalizeTelegramSettingsResponse() });
});

app.post('/api/settings/telegram', (req, res) => {
  const payload = req.body || {};
  const current = db.getTelegramSettings();
  const botToken = resolveTelegramSettingValue(payload.botToken, current.botToken);
  const chatId = resolveTelegramSettingValue(payload.chatId, current.chatId);

  if (!botToken || !chatId) {
    return res.status(400).json({ message: 'Bot Token 和 Chat ID 不能为空' });
  }

  db.setSetting('telegram_bot_token', botToken);
  db.setSetting('telegram_chat_id', chatId);

  res.json({ data: normalizeTelegramSettingsResponse() });
});

app.post('/api/settings/telegram/test', async (req, res) => {
  try {
    await sendTelegramTestMessage();
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ message: error.message || '测试消息发送失败' });
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
      await answerTelegramCallback(settings.botToken, callbackQueryId, '当前会话无权操作这个任务');
      return res.json({ ok: true });
    }

    if (!parsed) {
      await answerTelegramCallback(settings.botToken, callbackQueryId, '无法识别这个操作');
      return res.json({ ok: true });
    }

    const task = db.getTask(parsed.taskId);
    const run = db.getRun(parsed.runId);
    if (!task || !run || run.task_id !== parsed.taskId || run.status !== 'failed') {
      await answerTelegramCallback(settings.botToken, callbackQueryId, '这次失败记录已失效，无法重试');
      return res.json({ ok: true });
    }

    const result = await triggerTaskExecutionInBackground(parsed.taskId);
    await answerTelegramCallback(settings.botToken, callbackQueryId, result.message);
    return res.json({ ok: true });
  } catch (error) {
    try {
      await answerTelegramCallback(settings.botToken, callbackQueryId, error.message || '重试任务失败');
    } catch (answerError) {
      console.warn('[telegram] failed to answer callback query:', answerError.message);
    }
    return res.json({ ok: true });
  }
});

app.post('/api/browser/open', async (req, res) => {
  try {
    const session = await openManualBrowser();
    res.json({ data: { open: true, openedAt: session.openedAt } });
  } catch (error) {
    res.status(500).json({ message: error.message || '浏览器启动失败' });
  }
});

app.post('/api/browser/close', async (req, res) => {
  try {
    const result = await closeManualBrowser();
    res.json({ data: result });
  } catch (error) {
    res.status(500).json({ message: error.message || '浏览器关闭失败' });
  }
});

app.post('/api/tasks', (req, res) => {
  try {
    const payload = req.body || {};
    const type = payload.type === 'python' ? 'python' : 'javascript';
    const name = String(payload.name || 'Untitled Task');
    const task = db.createTask({
      name,
      type,
      script_path: resolveTaskScriptPath(name, type, String(payload.script_path || '')),
      cron_expr: String(payload.cron_expr || ''),
      schedule_mode: payload.schedule_mode === 'interval' ? 'interval' : 'fixed',
      interval_min: payload.interval_min ? Number(payload.interval_min) : null,
      interval_max: payload.interval_max ? Number(payload.interval_max) : null,
      interval_unit: payload.interval_unit ? String(payload.interval_unit) : null,
      next_run_at: payload.next_run_at ? String(payload.next_run_at) : null,
      enabled: payload.enabled ? 1 : 0,
      use_browser: payload.use_browser === false ? 0 : 1,
      use_persistent: payload.use_persistent === false ? 0 : 1,
      timeout_sec: Number(payload.timeout_sec || 300),
    });
    reloadJobs(executeTask);
    res.json({ data: task });
  } catch (error) {
    res.status(400).json({ message: error.message || '保存任务失败' });
  }
});

app.put('/api/tasks/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const payload = req.body || {};
    const existing = db.getTask(id);
    const type = payload.type === 'python' ? 'python' : 'javascript';
    const name = String(payload.name || 'Untitled Task');
    const task = db.updateTask(id, {
      name,
      type,
      script_path: resolveTaskScriptPath(name, type, String(payload.script_path || ''), id),
      cron_expr: String(payload.cron_expr || ''),
      schedule_mode: payload.schedule_mode === 'interval' ? 'interval' : 'fixed',
      interval_min: payload.interval_min ? Number(payload.interval_min) : null,
      interval_max: payload.interval_max ? Number(payload.interval_max) : null,
      interval_unit: payload.interval_unit ? String(payload.interval_unit) : null,
      next_run_at: payload.next_run_at ? String(payload.next_run_at) : existing?.next_run_at || null,
      enabled: payload.enabled ? 1 : 0,
      use_browser: payload.use_browser === false ? 0 : 1,
      use_persistent: payload.use_persistent === false ? 0 : 1,
      timeout_sec: Number(payload.timeout_sec || 300),
    });
    reloadJobs(executeTask);
    res.json({ data: task });
  } catch (error) {
    res.status(400).json({ message: error.message || '更新任务失败' });
  }
});

app.delete('/api/tasks/:id', (req, res) => {
  try {
    const result = db.deleteTask(Number(req.params.id));
    if (!result.changes) {
      return res.status(404).json({ message: '任务不存在或已删除' });
    }
    reloadJobs(executeTask);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ message: error.message || '删除任务失败' });
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
    res.status(500).json({ message: error.message || '脚本保存失败' });
  }
});

app.post('/api/tasks/:id/run', async (req, res) => {
  try {
    const response = await triggerTaskExecution(Number(req.params.id));
    res.status(response.status).json(response.payload);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.post('/api/tasks/:id/stop', (req, res) => {
  const id = Number(req.params.id);
  const stopped = stopTask(id);
  if (!stopped) {
    return res.status(404).json({ message: '当前没有可停止的运行任务' });
  }
  res.json({ ok: true });
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
  console.log(`Panel running on http://${config.server.host}:${config.server.port}`);
});
