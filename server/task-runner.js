const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');
const { launchBrowserTaskAndWait, stopBrowserTask } = require('./runtime/browser-launcher');
const db = require('./db');
const {
  parseTaskParams,
  resolveUseTempProfile,
  resolveEffectiveProxy,
  buildForegroundEnv,
} = require('./runtime/env-builder');
const { evaluateLogSuccess } = require('./runtime/success-heuristics');
const { ingestTaskResultCallback } = require('./runtime/callback-report');
const logStream = require('./log-stream');

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

function makeRunScreenshotsDir(taskId, runId) {
  const safeRunId = String(runId || `${taskId}-${Date.now()}`).replace(/[^a-zA-Z0-9._-]+/g, '-');
  return path.join(config.paths.screenshotsDir, 'runs', `task-${taskId}-run-${safeRunId}`);
}

function listImageFiles(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp|gif)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

/** Recursively list image files as paths relative to rootDir (posix-ish for URLs). */
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

function copyDirectoryImages(srcDir, destDir) {
  if (!srcDir || !fs.existsSync(srcDir)) return 0;
  fs.mkdirSync(destDir, { recursive: true });
  let copied = 0;
  // Include nested folders (e.g. yolo_hard/miss/cars/*.png) so train samples are archived.
  for (const rel of listImageFilesRecursive(srcDir)) {
    const from = path.join(srcDir, rel);
    const to = path.join(destDir, rel);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      copied += 1;
    } catch {
      // ignore single-file copy failures
    }
  }
  return copied;
}

function removeWorkerArtifact(target, options = {}) {
  if (!target) return;
  try {
    fs.rmSync(target, { recursive: Boolean(options.recursive), force: true });
  } catch (error) {
    console.warn(`[task-runner] worker artifact cleanup failed: ${target}: ${error.message || error}`);
  }
}

function getTempProfileDir(task, runId = null) {
  const id = task && task.id != null ? task.id : 'x';
  const run = runId != null && String(runId).trim()
    ? String(runId).trim().replace(/[^\w.-]+/g, '_')
    : `t${Date.now()}`;
  return path.join(config.paths.root, 'runtime-data', 'profiles', `task-${id}-run-${run}-tmp`);
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
  const value = safeString(text);
  fs.appendFileSync(logPath, value, 'utf8');
  logStream.publish(logPath);
}

function isoNow() {
  return new Date().toISOString();
}

/** 本地时分秒，用于脚本没自带时间时补前缀 */
function logTimeNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 行首是否已有脚本自己的时间（避免双重戳） */
function lineAlreadyHasTimestamp(line) {
  const text = safeString(line).trimStart();
  // [16:46:42] / 16:46:42 / 2026-07-20T... /
  return (
    /^\[\d{1,2}:\d{2}(:\d{2})?([.,]\d+)?\]/.test(text)
    || /^\d{1,2}:\d{2}(:\d{2})?([.,]\d+)?(\s|$)/.test(text)
    || /^\d{4}-\d{2}-\d{2}[T\s]/.test(text)
  );
}

function formatSubprocessLogLine(line) {
  // 脚本已有时间 → 原样；没有 → 只补 HH:MM:SS
  if (lineAlreadyHasTimestamp(line)) return `${line}\n`;
  return `${logTimeNow()} ${line}\n`;
}

/** 子进程按行写日志：有时间戳不重复加，没有则补短时间 */
function createTimestampedLineWriter(writeLine) {
  let buffer = '';
  return {
    write(chunk) {
      buffer += safeString(chunk);
      buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        writeLine(formatSubprocessLogLine(line));
      }
    },
    flush() {
      if (!buffer) return;
      writeLine(formatSubprocessLogLine(buffer));
      buffer = '';
    },
  };
}

function createRealtimeLogWriter(logPath) {
  let stdoutHeaderWritten = false;
  let stderrHeaderWritten = false;
  const stdoutWriter = createTimestampedLineWriter((line) => appendLog(logPath, line));
  const stderrWriter = createTimestampedLineWriter((line) => appendLog(logPath, line));
  return {
    onStdout(text) {
      if (!stdoutHeaderWritten) {
        appendLog(logPath, section('SUBPROCESS OUTPUT (STDOUT)'));
        stdoutHeaderWritten = true;
      }
      stdoutWriter.write(text);
    },
    onStderr(text) {
      if (!stderrHeaderWritten) {
        appendLog(logPath, section('SUBPROCESS OUTPUT (STDERR)'));
        stderrHeaderWritten = true;
      }
      stderrWriter.write(text);
    },
    finalizeHeadersIfMissing() {
      if (!stdoutHeaderWritten) appendLog(logPath, section('SUBPROCESS OUTPUT (STDOUT)'));
      if (!stderrHeaderWritten) appendLog(logPath, section('SUBPROCESS OUTPUT (STDERR)'));
      stdoutWriter.flush();
      stderrWriter.flush();
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

function appendDebugSummarySection(logPath, tracker, extra = {}) {
  if (!tracker && !extra) return;
  const entries = [
    ['timeline_steps', tracker ? tracker.getStepCount() : 0],
    ['last_url', tracker ? (tracker.getLastUrl() || '') : ''],
    ['last_title', tracker ? (tracker.getLastTitle() || '') : ''],
  ];
  if (extra.status !== undefined) entries.push(['status', extra.status || '']);
  if (extra.errorCode !== undefined) entries.push(['error_code', extra.errorCode || '']);
  if (extra.exitCode !== undefined) entries.push(['exit_code', extra.exitCode ?? '']);
  if (extra.ok !== undefined) entries.push(['result_ok', extra.ok ? '1' : '0']);
  if (extra.retryable !== undefined) entries.push(['retryable', extra.retryable ? '1' : '0']);
  writeLogHeader(logPath, 'DEBUG SUMMARY', entries);
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
  const params = parseTaskParams(task);
  const effectiveProxy = resolveEffectiveProxy(task, profile);
  const useTempProfile = resolveUseTempProfile(task, params);
  // Per-run temp dir (browser-launcher deletes after run). Keep helper for non-browser paths.
  const effectiveUserDataDir = useTempProfile
    ? getTempProfileDir(task)
    : pickNonEmptyString(
      profile && profile.user_data_dir,
      task.use_persistent ? config.browser.userDataDir : '',
      getTempProfileDir(task)
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
  // Only runtime/infra failures default to retryable. Plain script exits are not our call.
  const retryableCodes = new Set(['timeout', 'browser_launch_error', 'permission_error']);
  return retryableCodes.has(String(errorCode || '')) ? 1 : 0;
}

function buildEnv(task, screenshotPath) {
  const env = buildForegroundEnv(task, { screenshotPath });
  const params = parseTaskParams(task);
  const useTempProfile = resolveUseTempProfile(task, params);
  if (task.use_browser) {
    const profile = task._profile || null;
    env.BROWSER_USER_DATA_DIR = useTempProfile
      ? getTempProfileDir(task)
      : pickNonEmptyString(
        profile && profile.user_data_dir,
        task.use_persistent ? config.browser.userDataDir : getTempProfileDir(task)
      );
    env.USE_TEMP_PROFILE = useTempProfile ? '1' : '0';
    env.BROWSER_PROXY = resolveEffectiveProxy(task, profile);
    env.BROWSER_LOCALE = pickNonEmptyString(profile && profile.locale, config.browser.locale);
    env.BROWSER_TIMEZONE = pickNonEmptyString(profile && profile.timezone_id, config.browser.timezoneId);
    env.BROWSER_DISPLAY = config.browser.display;
    env.BROWSER_XAUTHORITY = config.browser.xauthority;
    env.BROWSER_USER = config.browser.user;
    try {
      const br = db.getBrowserRuntimeSettings();
      env.BROWSER_CHROME_PATH = (br && br.chromePath) || config.browser.chromePath;
      env.BROWSER_EXTENSIONS = (br && br.extensionDirs) || '';
    } catch {
      env.BROWSER_CHROME_PATH = config.browser.chromePath;
      env.BROWSER_EXTENSIONS = config.browser.extensions || '';
    }
    env.BROWSER_HEADLESS = 'false';
    if (env.BROWSER_EXTENSIONS === undefined) {
      env.BROWSER_EXTENSIONS = config.browser.extensions || '';
    }
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

    const tracker = createStepTimelineTracker();
    const lineWriter = createTimestampedLineWriter((line) => appendLog(logPath, line));
    const { cmd, args } = getCommand(task);
    const child = spawn(cmd, args, {
      cwd: config.paths.root,
      env: buildEnv(task, screenshotPath),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChildren.set(task.id, child);

    let stdoutText = '';
    let stderrText = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stderrText += '\nTask timeout exceeded';
      child.kill('SIGTERM');
    }, task.timeout_sec * 1000);

    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      stdoutText += text;
      tracker.ingest('stdout', text);
      lineWriter.write(text);
    });
    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderrText += text;
      tracker.ingest('stderr', text);
      lineWriter.write(text);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      activeChildren.delete(task.id);
      lineWriter.flush();
      const logVerdict = evaluateLogSuccess(`${stdoutText}\n${stderrText}`, task);
      let ok = code === 0;
      let softSuccess = false;
      if (!ok && logVerdict.softSuccess) {
        ok = true;
        softSuccess = true;
        appendLog(logPath, `\n[panel] soft success via log match: ${logVerdict.successHit}\n`);
      }
      tracker.finalize(ok ? 'ok' : 'failed');
      const errorText = ok ? null : (stderrText.trim() || null);
      let errorCode = null;
      if (!ok) {
        errorCode = classifyForegroundFailure(code, stderrText);
        if (signal === 'SIGTERM' && !stderrText.includes('Task timeout exceeded')) {
          errorCode = 'stopped';
        }
      }
      const endedAt = new Date().toISOString();
      appendTimelineSection(logPath, tracker);
      appendDebugSummarySection(logPath, tracker, {
        status: ok ? 'success' : 'failed',
        errorCode: errorCode || '',
        exitCode: code ?? '',
        softSuccess: softSuccess ? 1 : 0,
      });
      writeLogHeader(logPath, 'TASK SUMMARY', [
        ['ended_at', endedAt],
        ['status', ok ? 'success' : 'failed'],
        ['error_code', errorCode || ''],
        ['exit_code', ok ? 0 : (code ?? '')],
        ['soft_success', softSuccess ? '1' : '0'],
        ['success_log_hit', logVerdict.successHit || ''],
        ['signal', signal || ''],
        ['timed_out', timedOut ? '1' : '0'],
        ['screenshot_exists', fs.existsSync(screenshotPath) ? '1' : '0'],
      ]);
      resolve({
        status: ok ? 'success' : 'failed',
        errorCode,
        startedAt,
        endedAt,
        exitCode: ok ? 0 : code,
        logPath,
        screenshotPath: fs.existsSync(screenshotPath) ? screenshotPath : null,
        errorText,
        retryable: ok ? 0 : defaultRetryableByErrorCode(errorCode),
        retryReason: null,
      });
    });
  });
}

async function runBrowserTask(task, logPath = makeLogPath(task.id)) {
  const profile = resolveTaskProfile(task);
  if (profile) task = { ...task, _profile: profile };
  const screenshotPath = makeScreenshotPath(task.id);
  const runId = `${task.id}-${Date.now()}`;
  const screenshotsDir = makeRunScreenshotsDir(task.id, runId);
  fs.mkdirSync(screenshotsDir, { recursive: true });
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
    ['screenshots_dir', screenshotsDir],
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
  const workerScreenshotDir = result.workerScreenshotDir;
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
  if (fs.existsSync(workerScreenshotPath)) {
    try {
      fs.copyFileSync(workerScreenshotPath, screenshotPath);
      removeWorkerArtifact(workerScreenshotPath);
    } catch (error) {
      console.warn(`[task-runner] worker screenshot copy failed: ${error.message || error}`);
    }
  }
  const archivedCount = copyDirectoryImages(workerScreenshotDir, screenshotsDir);
  const workerImageCount = listImageFilesRecursive(workerScreenshotDir).length;
  if (workerImageCount === 0 || archivedCount === workerImageCount) {
    removeWorkerArtifact(workerScreenshotDir, { recursive: true });
  }
  if (!taskResultParseError) removeWorkerArtifact(workerResultPath);
  const hasRunShots = archivedCount > 0 || listImageFiles(screenshotsDir).length > 0;
  const screenshotsDirPath = hasRunShots ? screenshotsDir : null;

  appendTimelineSection(logPath, tracker);

  appendLog(logPath, section('WORKER RESULT PAYLOAD'));
  if (taskResult) {
    appendLog(logPath, `${JSON.stringify(taskResult, null, 2)}\n`);
  } else {
    appendLog(logPath, '(none)\n');
  }
  if (taskResultParseError) {
    appendLog(logPath, `parse_error: ${taskResultParseError}\n`);
  }

  // Always store remaining_sec callback when present; scheduling adoption is panel switch.
  if (taskResult && task && task.id != null) {
    try {
      const cbTask = ingestTaskResultCallback(task.id, taskResult);
      if (cbTask && cbTask.callback_remaining_sec != null) {
        appendLog(
          logPath,
          `[panel] callback remaining_sec=${cbTask.callback_remaining_sec}`
            + (cbTask.callback_trigger_at ? ` trigger_at=${cbTask.callback_trigger_at}` : ' (not scheduling)')
            + '\n'
        );
      }
    } catch (cbErr) {
      appendLog(logPath, `[panel] callback ingest error: ${cbErr.message || cbErr}\n`);
    }
  }

  if (result.errorCode === 'stopped') {
    appendDebugSummarySection(logPath, tracker, {
      status: 'failed',
      errorCode: 'stopped',
      exitCode: result.exitCode ?? '',
      ok: false,
      retryable: 0,
    });
    writeLogHeader(logPath, 'TASK SUMMARY', [
      ['ended_at', result.endedAt],
      ['status', 'failed'],
      ['error_code', 'stopped'],
      ['exit_code', result.exitCode ?? ''],
      ['worker_result_path', workerResultPath],
      ['worker_screenshot_path', workerScreenshotPath],
      ['worker_screenshots_dir', workerScreenshotDir || ''],
      ['screenshots_dir', screenshotsDirPath || ''],
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
      screenshotsDir: screenshotsDirPath,
      errorText: 'Stopped by user',
      retryable: 0,
      retryReason: null,
    };
  }

  const hasScreenshot = fs.existsSync(screenshotPath);
  // Prefer explicit TASK_RESULT_PATH payload. For legacy GitHub-style scripts that
  // never write it: treat clean exit (code 0) as success so the panel matches reality.
  // Soft success: success-looking logs even if process hung until timeout / grace kill.
  const exitCodeNum = Number(result.exitCode);
  const exitOk = result.exitCode === 0 || result.exitCode === '0' || exitCodeNum === 0;
  const combinedLog = `${result.stdout || ''}\n${result.stderr || ''}`;
  const logVerdict = evaluateLogSuccess(combinedLog, task);
  let softSuccess = false;
  let ok = false;
  if (taskResult && typeof taskResult === 'object' && !Array.isArray(taskResult)) {
    // Only trust payload when it explicitly sets ok
    if (Object.prototype.hasOwnProperty.call(taskResult, 'ok')) {
      ok = taskResult.ok === true || taskResult.ok === 1 || taskResult.ok === '1' || taskResult.ok === 'true';
    } else if (exitOk) {
      ok = true;
    }
  } else if (exitOk) {
    ok = true;
  }
  if (!ok && logVerdict.softSuccess) {
    // Allow soft success on timeout, grace kill, or other non-zero exits without TASK_RESULT
    softSuccess = true;
    ok = true;
    appendLog(
      logPath,
      `\n[panel] soft success via log match: ${logVerdict.successHit}` +
        `${result.timedOut ? ' (after timeout)' : ''}` +
        `${result.graceKilled ? ' (grace kill)' : ''}\n`
    );
  }
  let errorCode = null;
  if (!ok) {
    const combinedFailLog = `${result.stdout || ''}\n${result.stderr || ''}`;
    // Only label *panel/runtime* failures. Do not invent script_error / missing_result
    // for normal script exits — scripts own their business outcome; panel does not judge them.
    if (/timed out/i.test(result.stderr || '') || result.timedOut) {
      errorCode = 'timeout';
    } else if ((result.stderr || '').includes('Permission denied')) {
      errorCode = 'permission_error';
    } else if (/tab crashed|BrowserType|Executable doesn.?t exist|Target closed|browser has been closed/i.test(combinedFailLog)) {
      errorCode = 'browser_launch_error';
    } else if (taskResult && taskResult.error) {
      // Explicit payload from script — pass through as opaque task error, not our judgment
      errorCode = 'browser_task_error';
    } else {
      // Script exited non-zero (with or without TASK_RESULT): no special panel taxonomy.
      errorCode = null;
    }
  } else if (softSuccess && (result.timedOut || /timed out/i.test(result.stderr || ''))) {
    errorCode = null;
  }
  const scriptRetryable = normalizeRetryable(taskResult?.data?.retryable ?? taskResult?.retryable);
  const retryable = ok ? 0 : (scriptRetryable ?? defaultRetryableByErrorCode(errorCode));
  const retryReasonRaw = taskResult?.data?.retry_reason ?? taskResult?.retry_reason;
  const retryReason = retryReasonRaw === null || retryReasonRaw === undefined ? null : String(retryReasonRaw).slice(0, 300);

  appendDebugSummarySection(logPath, tracker, {
    status: ok ? 'success' : 'failed',
    errorCode: errorCode || '',
    exitCode: result.exitCode ?? '',
    ok,
    softSuccess: softSuccess ? 1 : 0,
    successLogHit: logVerdict.successHit || '',
    retryable,
  });
  writeLogHeader(logPath, 'TASK SUMMARY', [
    ['ended_at', result.endedAt],
    ['status', ok ? 'success' : 'failed'],
    ['error_code', errorCode || ''],
    ['exit_code', result.exitCode ?? ''],
    ['soft_success', softSuccess ? '1' : '0'],
    ['success_log_hit', logVerdict.successHit || ''],
    ['worker_result_path', workerResultPath],
    ['worker_screenshot_path', workerScreenshotPath],
    ['worker_screenshots_dir', workerScreenshotDir || ''],
    ['screenshots_dir', screenshotsDirPath || ''],
    ['screenshot_exists', hasScreenshot ? '1' : '0'],
  ]);

  return {
    status: ok ? 'success' : 'failed',
    errorCode,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    // Soft success: report exit 0 so UI/history match "succeeded" for GitHub-style scripts
    exitCode: ok ? 0 : result.exitCode,
    logPath,
    screenshotPath: hasScreenshot ? screenshotPath : null,
    screenshotsDir: screenshotsDirPath,
    errorText: ok
      ? null
      : (taskResult?.error
        || (result.stderr && String(result.stderr).trim())
        || (result.stdout && String(result.stdout).trim().split(/\r?\n/).filter(Boolean).slice(-5).join('\n'))
        || null),
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
