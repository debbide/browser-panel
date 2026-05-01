const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');
const { launchBrowserTaskAndWait, stopBrowserTask } = require('./runtime/browser-launcher');
const db = require('./db');

const activeChildren = new Map();

fs.mkdirSync(config.paths.logsDir, { recursive: true });
fs.mkdirSync(config.paths.screenshotsDir, { recursive: true });

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function makeLogPath(taskId) {
  return path.join(config.paths.logsDir, `task-${taskId}-${stamp()}.log`);
}

function makeScreenshotPath(taskId) {
  return path.join(config.paths.screenshotsDir, `task-${taskId}-${stamp()}.png`);
}

function getTempProfileDir(task) {
  return path.join(config.paths.root, 'runtime-data', 'profiles', `task-${task.id}-tmp-profile`);
}

function safeString(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function maskProxy(value) {
  const raw = safeString(value).trim();
  if (!raw) return '';
  const schemeMatch = raw.match(/^([a-zA-Z0-9+.-]+):\/\//);
  const scheme = schemeMatch ? schemeMatch[1] : '';
  const withoutScheme = scheme ? raw.slice(`${scheme}://`.length) : raw;
  const atIndex = withoutScheme.lastIndexOf('@');
  const hostPart = atIndex >= 0 ? withoutScheme.slice(atIndex + 1) : withoutScheme;
  if (atIndex >= 0) {
    return scheme ? `${scheme}://***@${hostPart}` : `***@${hostPart}`;
  }
  return raw;
}

function section(title) {
  return `\n========== ${title} ==========\n`;
}

function appendLog(logPath, text) {
  fs.appendFileSync(logPath, safeString(text), 'utf8');
}

function createRealtimeLogWriter(logPath) {
  let stdoutHeaderWritten = false;
  let stderrHeaderWritten = false;
  return {
    onStdout(text) {
      if (!stdoutHeaderWritten) {
        appendLog(logPath, section('SUBPROCESS OUTPUT (STDOUT)'));
        stdoutHeaderWritten = true;
      }
      appendLog(logPath, text);
    },
    onStderr(text) {
      if (!stderrHeaderWritten) {
        appendLog(logPath, section('SUBPROCESS OUTPUT (STDERR)'));
        stderrHeaderWritten = true;
      }
      appendLog(logPath, text);
    },
    finalizeHeadersIfMissing() {
      if (!stdoutHeaderWritten) appendLog(logPath, section('SUBPROCESS OUTPUT (STDOUT)'));
      if (!stderrHeaderWritten) appendLog(logPath, section('SUBPROCESS OUTPUT (STDERR)'));
    },
  };
}

function writeLogHeader(logPath, title, entries) {
  const lines = [section(title)];
  for (const [key, value] of entries) {
    lines.push(`${key}: ${safeString(value)}\n`);
  }
  appendLog(logPath, lines.join(''));
}

function resolveTaskProfile(task) {
  if (!task.browser_profile_id) return null;
  return db.getBrowserProfile(task.browser_profile_id) || null;
}

function resolveRuntimeStack(task, runtimeSettings) {
  const profileStack = safeString(task?._profile?.runtime_stack).trim().toLowerCase();
  if (profileStack === 'seleniumbase') return 'seleniumbase';
  if (profileStack === 'playwright') return 'playwright';
  const globalStack = safeString(runtimeSettings?.runtimeStack).trim().toLowerCase();
  return globalStack === 'seleniumbase' ? 'seleniumbase' : 'playwright';
}

function resolveBrowserContext(task) {
  const runtimeSettings = db.getBrowserRuntimeSettings();
  const profile = task._profile || null;
  const effectiveProxy = profile && profile.proxy ? profile.proxy : (config.browser.proxy || '');
  const effectiveUserDataDir = profile && profile.user_data_dir
    ? profile.user_data_dir
    : (task.use_persistent ? config.browser.userDataDir : getTempProfileDir(task));
  const effectiveLocale = profile && profile.locale ? profile.locale : config.browser.locale;
  const effectiveTimezone = profile && profile.timezone_id ? profile.timezone_id : config.browser.timezoneId;
  const runtimeStack = resolveRuntimeStack(task, runtimeSettings);

  return {
    runtimeSettings,
    runtimeStack,
    effectiveProxy,
    effectiveUserDataDir,
    effectiveLocale,
    effectiveTimezone,
  };
}

function prepareLogForTask(taskId) {
  const logPath = makeLogPath(taskId);
  fs.writeFileSync(logPath, '', 'utf8');
  return logPath;
}

function classifyForegroundFailure(exitCode, stderrText) {
  const text = String(stderrText || '').toLowerCase();
  if (text.includes('task timeout exceeded')) return 'timeout';
  if (text.includes('eacces') || text.includes('permission denied')) return 'permission_error';
  if (text.includes('no such file') || text.includes('cannot find module') || text.includes('not found')) return 'script_error';
  return exitCode === 0 ? null : 'script_error';
}

function buildEnv(task, screenshotPath) {
  const env = { ...process.env };
  if (task.use_browser) {
    env.BROWSER_DISPLAY = config.browser.display;
    env.BROWSER_XAUTHORITY = config.browser.xauthority;
    env.BROWSER_USER = config.browser.user;
    env.BROWSER_USER_DATA_DIR = task.use_persistent ? config.browser.userDataDir : getTempProfileDir(task);
    env.BROWSER_CHROME_PATH = config.browser.chromePath;
    env.BROWSER_PROXY = config.browser.proxy;
    env.BROWSER_LOCALE = config.browser.locale;
    env.BROWSER_TIMEZONE = config.browser.timezoneId;
    env.BROWSER_HEADLESS = 'false';
  }
  env.APP_ROOT = config.paths.root;
  env.LOGS_DIR = config.paths.logsDir;
  env.SCREENSHOTS_DIR = config.paths.screenshotsDir;
  env.TASK_SCREENSHOT_PATH = screenshotPath;
  return env;
}

function getCommand(task) {
  if (task.type === 'python') {
    return { cmd: path.join(config.paths.root, '.venv', 'bin', 'python'), args: [task.script_path] };
  }
  return { cmd: 'node', args: [task.script_path] };
}

function runForegroundTask(task, screenshotPath, logPath = makeLogPath(task.id)) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    writeLogHeader(logPath, 'TASK START', [
      ['started_at', startedAt],
      ['mode', 'foreground'],
      ['task_id', task.id],
      ['task_name', task.name],
      ['task_type', task.type],
      ['script_path', task.script_path],
      ['timeout_sec', task.timeout_sec],
      ['screenshot_path', screenshotPath],
    ]);
    appendLog(logPath, section('SUBPROCESS OUTPUT'));

    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    const { cmd, args } = getCommand(task);
    const child = spawn(cmd, args, {
      cwd: config.paths.root,
      env: buildEnv(task, screenshotPath),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChildren.set(task.id, child);

    let stderrText = '';
    const timer = setTimeout(() => {
      stderrText += '\nTask timeout exceeded';
      child.kill('SIGTERM');
    }, task.timeout_sec * 1000);

    child.stdout.on('data', chunk => logStream.write(chunk));
    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderrText += text;
      logStream.write(chunk);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      activeChildren.delete(task.id);
      logStream.end();
      const errorText = stderrText.trim() || null;
      let errorCode = classifyForegroundFailure(code, errorText);
      if (signal === 'SIGTERM' && !errorText?.includes('Task timeout exceeded')) {
        errorCode = 'stopped';
      }
      const endedAt = new Date().toISOString();
      writeLogHeader(logPath, 'TASK SUMMARY', [
        ['ended_at', endedAt],
        ['status', code === 0 ? 'success' : 'failed'],
        ['error_code', errorCode || ''],
        ['exit_code', code ?? ''],
        ['signal', signal || ''],
        ['screenshot_exists', fs.existsSync(screenshotPath) ? '1' : '0'],
      ]);
      resolve({
        status: code === 0 ? 'success' : 'failed',
        errorCode,
        startedAt,
        endedAt,
        exitCode: code,
        logPath,
        screenshotPath: fs.existsSync(screenshotPath) ? screenshotPath : null,
        errorText,
      });
    });
  });
}

async function runBrowserTask(task, logPath = makeLogPath(task.id)) {
  const profile = resolveTaskProfile(task);
  if (profile) task = { ...task, _profile: profile };
  const screenshotPath = makeScreenshotPath(task.id);
  const runId = `${task.id}-${Date.now()}`;
  const browserContext = resolveBrowserContext(task);
  const startedAt = new Date().toISOString();

  writeLogHeader(logPath, 'TASK START', [
    ['started_at', startedAt],
    ['mode', 'browser'],
    ['task_id', task.id],
    ['task_name', task.name],
    ['task_type', task.type],
    ['script_path', task.script_path],
    ['timeout_sec', task.timeout_sec],
    ['browser_profile_id', task.browser_profile_id || ''],
    ['browser_profile_name', task._profile?.name || ''],
    ['runtime_stack', browserContext.runtimeStack],
    ['use_playwright_extra', browserContext.runtimeSettings?.usePlaywrightExtra ? '1' : '0'],
    ['plugin_packages', browserContext.runtimeSettings?.pluginPackages || ''],
    ['browser_proxy', maskProxy(browserContext.effectiveProxy)],
    ['browser_user_data_dir', browserContext.effectiveUserDataDir],
    ['browser_locale', browserContext.effectiveLocale || ''],
    ['browser_timezone', browserContext.effectiveTimezone || ''],
    ['screenshot_path', screenshotPath],
    ['run_id', runId],
  ]);

  const realtimeWriter = createRealtimeLogWriter(logPath);
  const result = await launchBrowserTaskAndWait(task, runId, {
    onStdout: realtimeWriter.onStdout,
    onStderr: realtimeWriter.onStderr,
  });
  const workerScreenshotPath = result.workerScreenshotPath;
  const workerResultPath = result.resultPath;
  realtimeWriter.finalizeHeadersIfMissing();

  let taskResult = null;
  let taskResultParseError = null;
  if (fs.existsSync(workerResultPath)) {
    try {
      taskResult = JSON.parse(fs.readFileSync(workerResultPath, 'utf8'));
    } catch (error) {
      taskResultParseError = error.message || String(error);
    }
  }
  if (fs.existsSync(workerResultPath)) fs.unlinkSync(workerResultPath);
  if (fs.existsSync(workerScreenshotPath)) fs.copyFileSync(workerScreenshotPath, screenshotPath);

  appendLog(logPath, section('WORKER RESULT PAYLOAD'));
  if (taskResult) {
    appendLog(logPath, `${JSON.stringify(taskResult, null, 2)}\n`);
  } else {
    appendLog(logPath, '(none)\n');
  }
  if (taskResultParseError) {
    appendLog(logPath, `parse_error: ${taskResultParseError}\n`);
  }

  if (result.errorCode === 'stopped') {
    writeLogHeader(logPath, 'TASK SUMMARY', [
      ['ended_at', result.endedAt],
      ['status', 'failed'],
      ['error_code', 'stopped'],
      ['exit_code', result.exitCode ?? ''],
      ['worker_result_path', workerResultPath],
      ['worker_screenshot_path', workerScreenshotPath],
      ['screenshot_exists', fs.existsSync(screenshotPath) ? '1' : '0'],
    ]);
    return {
      status: 'failed',
      errorCode: 'stopped',
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      exitCode: result.exitCode,
      logPath,
      screenshotPath: fs.existsSync(screenshotPath) ? screenshotPath : null,
      errorText: 'Stopped by user',
    };
  }

  const hasScreenshot = fs.existsSync(screenshotPath);
  const ok = Boolean(taskResult?.ok === true);
  let errorCode = null;
  if (!ok) {
    if (/timed out/i.test(result.stderr || '')) errorCode = 'timeout';
    else if ((result.stderr || '').includes('Permission denied')) errorCode = 'permission_error';
    else if (taskResult?.error) errorCode = 'browser_task_error';
    else if (!taskResult) errorCode = 'missing_result';
    else errorCode = 'browser_launch_error';
  }

  writeLogHeader(logPath, 'TASK SUMMARY', [
    ['ended_at', result.endedAt],
    ['status', ok ? 'success' : 'failed'],
    ['error_code', errorCode || ''],
    ['exit_code', result.exitCode ?? ''],
    ['worker_result_path', workerResultPath],
    ['worker_screenshot_path', workerScreenshotPath],
    ['screenshot_exists', hasScreenshot ? '1' : '0'],
  ]);

  return {
    status: ok ? 'success' : 'failed',
    errorCode,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    exitCode: result.exitCode,
    logPath,
    screenshotPath: hasScreenshot ? screenshotPath : null,
    errorText: taskResult?.error || result.stderr || (hasScreenshot ? null : 'No result payload written'),
  };
}

async function runTask(task, options = {}) {
  const logPath = options.logPath || prepareLogForTask(task.id);
  if (task.use_browser) {
    return runBrowserTask(task, logPath);
  }
  return runForegroundTask(task, makeScreenshotPath(task.id), logPath);
}

function stopTask(taskId) {
  const numericId = Number(taskId);
  let stopped = false;
  const task = db.getTask(numericId) || null;
  let taskWithProfile = task;
  if (task && task.browser_profile_id) {
    const profile = db.getBrowserProfile(task.browser_profile_id);
    if (profile) taskWithProfile = { ...task, _profile: profile };
  }

  const child = activeChildren.get(numericId);
  if (child) {
    child.kill('SIGTERM');
    stopped = true;
  }

  if (stopBrowserTask(numericId, taskWithProfile)) {
    stopped = true;
  }

  return stopped;
}

module.exports = {
  runTask,
  stopTask,
  prepareLogForTask,
};
