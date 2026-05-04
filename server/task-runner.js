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

function pickNonEmptyString(...values) {
  for (const value of values) {
    const text = safeString(value).trim();
    if (text) return text;
  }
  return '';
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

function stripAnsi(text) {
  return String(text || '').replace(
    // eslint-disable-next-line no-control-regex
    /[\u001B\u009B][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    ''
  );
}

function isLikelyUrl(value) {
  return /^https?:\/\/[^\s]+$/i.test(String(value || '').trim());
}

function createStepTimelineTracker() {
  const buffers = {
    stdout: '',
    stderr: '',
  };
  const timeline = [];
  let activeStep = null;
  let lastUrl = '';
  let lastTitle = '';
  let finalStatusHint = 'open';

  function toIso(ms) {
    return new Date(ms).toISOString();
  }

  function closeActiveStep(status = 'auto') {
    if (!activeStep) return;
    const endedMs = Date.now();
    timeline.push({
      index: timeline.length + 1,
      name: activeStep.name,
      status,
      started_at: toIso(activeStep.startedMs),
      ended_at: toIso(endedMs),
      duration_ms: Math.max(0, endedMs - activeStep.startedMs),
      stream: activeStep.stream,
    });
    activeStep = null;
  }

  function beginStep(name, stream) {
    if (!name) return;
    closeActiveStep('switched');
    activeStep = {
      name: String(name).trim().slice(0, 200),
      startedMs: Date.now(),
      stream,
    };
  }

  function captureContext(line) {
    const text = String(line || '').trim();
    if (!text) return;

    const urlTag = text.match(/^\[(?:URL|url)\]\s*(.+)$/);
    if (urlTag && isLikelyUrl(urlTag[1])) {
      lastUrl = urlTag[1].trim().slice(0, 500);
      return;
    }

    const titleTag = text.match(/^\[(?:TITLE|title)\]\s*(.+)$/);
    if (titleTag) {
      lastTitle = titleTag[1].trim().slice(0, 300);
      return;
    }

    const colonContext = text.match(/(?:title|\u6807\u9898|url|\u5f53\u524durl)\s*[:\uFF1A]\s*(.+)$/i);
    if (colonContext) {
      const value = colonContext[1].trim();
      if (isLikelyUrl(value)) {
        lastUrl = value.slice(0, 500);
      } else if (/(?:title|\u6807\u9898)/i.test(text)) {
        lastTitle = value.slice(0, 300);
      }
    }

    const anyUrl = text.match(/\bhttps?:\/\/[^\s"'<>\(\)]+/i);
    if (anyUrl && /(url|navigate|goto|open|visit|redirect|page|current|当前|页面|跳转)/i.test(text)) {
      lastUrl = anyUrl[0].trim().slice(0, 500);
    }
  }

  function parseStepSignal(line, stream) {
    const text = String(line || '').trim();
    if (!text) return;

    const stepStart = text.match(
      /^(?:\[(?:STEP|Step|\u6b65\u9aa4)\]|(?:STEP|Step|\u6b65\u9aa4)\s*[:\uFF1A])\s*(.+)$/
    );
    if (stepStart) {
      beginStep(stepStart[1], stream);
      return;
    }

    if (
      /^(?:\[(?:STEP(?:\s*OK|-OK)|Step(?:\s*OK|-OK)|\u6b65\u9aa4\u5b8c\u6210)\]|(?:STEP|Step)\s*OK\s*[:\uFF1A]|\u6b65\u9aa4\u5b8c\u6210\s*[:\uFF1A])/i.test(
        text
      )
    ) {
      closeActiveStep('ok');
      return;
    }

    if (
      /^(?:\[(?:STEP(?:\s*FAIL|-FAIL)|Step(?:\s*FAIL|-FAIL)|\u6b65\u9aa4\u5931\u8d25)\]|(?:STEP|Step)\s*FAIL\s*[:\uFF1A]|\u6b65\u9aa4\u5931\u8d25\s*[:\uFF1A])/i.test(
        text
      )
    ) {
      closeActiveStep('failed');
      return;
    }

    const sbStart = text.match(/^\=+\s*\{(.+?:SB)\}\s*starts\s*\=+$/i);
    if (sbStart) {
      beginStep(`seleniumbase:${sbStart[1]}`, stream);
      return;
    }

    const sbDone = text.match(/^\=+\s*\{(.+?:SB)\}\s*(passed|failed)\s+in\s+([0-9.]+s)\s*\=+$/i);
    if (sbDone) {
      closeActiveStep(sbDone[2].toLowerCase() === 'passed' ? 'ok' : 'failed');
      return;
    }

    const infoAction = text.match(/^\[(?:INFO|info)\]\s*(.+)$/);
    if (
      infoAction &&
      /(\u6253\u5f00|\u8bbf\u95ee|\u8fdb\u5165|\u52a0\u8f7d|\u70b9\u51fb|\u586b\u5199|\u8f93\u5165|\u63d0\u4ea4|\u7b49\u5f85|\u622a\u56fe|\u5904\u7406|\u5f00\u59cb|\u767b\u5f55|\u7b7e\u5230|open|goto|navigate|click|type|fill|submit|wait|login|signin)/i.test(
        infoAction[1]
      )
    ) {
      beginStep(infoAction[1], stream);
    }
  }

  function parseLine(rawLine, stream) {
    const cleanLine = stripAnsi(rawLine).trim();
    if (!cleanLine) return;
    captureContext(cleanLine);
    parseStepSignal(cleanLine, stream);
  }

  function ingest(stream, chunk) {
    const key = stream === 'stderr' ? 'stderr' : 'stdout';
    buffers[key] += String(chunk || '');
    const normalized = buffers[key].replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    buffers[key] = lines.pop() || '';
    for (const line of lines) {
      parseLine(line, key);
    }
  }

  function finalize(statusHint = 'open') {
    finalStatusHint = statusHint || 'open';
    for (const key of Object.keys(buffers)) {
      if (buffers[key]) parseLine(buffers[key], key);
      buffers[key] = '';
    }
    closeActiveStep(finalStatusHint);
  }

  function render() {
    if (!timeline.length) return '(no step markers found)\n';
    const lines = [];
    for (const item of timeline) {
      lines.push(
        `${item.index}. [${item.status}] ${item.name} | ${item.started_at} -> ${item.ended_at} | ${item.duration_ms}ms | ${item.stream}`
      );
    }
    return `${lines.join('\n')}\n`;
  }

  return {
    ingest,
    finalize,
    render,
    getStepCount: () => timeline.length,
    getLastUrl: () => lastUrl,
    getLastTitle: () => lastTitle,
  };
}

function appendTimelineSection(logPath, tracker) {
  if (!tracker) return;
  appendLog(logPath, section('STEP TIMELINE'));
  appendLog(logPath, tracker.render());
}

function appendDebugSummarySection(logPath, tracker) {
  if (!tracker) return;
  writeLogHeader(logPath, 'DEBUG SUMMARY', [
    ['timeline_steps', tracker.getStepCount()],
    ['last_url', tracker.getLastUrl() || ''],
    ['last_title', tracker.getLastTitle() || ''],
  ]);
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
  const effectiveProxy = pickNonEmptyString(
    profile && profile.proxy,
    config.browser.proxy || ''
  );
  const effectiveUserDataDir = pickNonEmptyString(
    profile && profile.user_data_dir,
    task.use_persistent ? config.browser.userDataDir : getTempProfileDir(task)
  );
  const effectiveLocale = pickNonEmptyString(
    profile && profile.locale,
    config.browser.locale
  );
  const effectiveTimezone = pickNonEmptyString(
    profile && profile.timezone_id,
    config.browser.timezoneId
  );
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

function normalizeRetryable(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value ? 1 : 0;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return 1;
  if (['0', 'false', 'no', 'off'].includes(text)) return 0;
  return null;
}

function defaultRetryableByErrorCode(errorCode) {
  const retryableCodes = new Set(['timeout', 'browser_task_error', 'browser_launch_error', 'missing_result']);
  return retryableCodes.has(String(errorCode || '')) ? 1 : 0;
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
    const tracker = createStepTimelineTracker();
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

    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      tracker.ingest('stdout', text);
      logStream.write(chunk);
    });
    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderrText += text;
      tracker.ingest('stderr', text);
      logStream.write(chunk);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      activeChildren.delete(task.id);
      tracker.finalize(code === 0 ? 'ok' : 'failed');
      const errorText = stderrText.trim() || null;
      let errorCode = classifyForegroundFailure(code, errorText);
      if (signal === 'SIGTERM' && !errorText?.includes('Task timeout exceeded')) {
        errorCode = 'stopped';
      }
      const endedAt = new Date().toISOString();
      logStream.end(() => {
        appendTimelineSection(logPath, tracker);
        appendDebugSummarySection(logPath, tracker);
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
          retryable: code === 0 ? 0 : defaultRetryableByErrorCode(errorCode),
          retryReason: null,
        });
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
  const tracker = createStepTimelineTracker();
  const result = await launchBrowserTaskAndWait(task, runId, {
    onStdout: (text) => {
      tracker.ingest('stdout', text);
      realtimeWriter.onStdout(text);
    },
    onStderr: (text) => {
      tracker.ingest('stderr', text);
      realtimeWriter.onStderr(text);
    },
  });
  const workerScreenshotPath = result.workerScreenshotPath;
  const workerResultPath = result.resultPath;
  realtimeWriter.finalizeHeadersIfMissing();
  tracker.finalize(result.exitCode === 0 ? 'ok' : 'failed');

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

  appendTimelineSection(logPath, tracker);
  appendDebugSummarySection(logPath, tracker);

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
      retryable: 0,
      retryReason: null,
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
  const scriptRetryable = normalizeRetryable(taskResult?.data?.retryable ?? taskResult?.retryable);
  const retryable = ok ? 0 : (scriptRetryable ?? defaultRetryableByErrorCode(errorCode));
  const retryReasonRaw = taskResult?.data?.retry_reason ?? taskResult?.retry_reason;
  const retryReason = retryReasonRaw === null || retryReasonRaw === undefined ? null : String(retryReasonRaw).slice(0, 300);

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
    retryable,
    retryReason,
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
