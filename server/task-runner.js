const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');
const { launchBrowserTaskAndWait } = require('./runtime/browser-launcher');

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

function runForegroundTask(task, screenshotPath) {
  return new Promise((resolve) => {
    const logPath = makeLogPath(task.id);
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    const startedAt = new Date().toISOString();
    const { cmd, args } = getCommand(task);
    const child = spawn(cmd, args, {
      cwd: config.paths.root,
      env: buildEnv(task, screenshotPath),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

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

    child.on('close', (code) => {
      clearTimeout(timer);
      logStream.end();
      const errorText = stderrText.trim() || null;
      resolve({
        status: code === 0 ? 'success' : 'failed',
        errorCode: classifyForegroundFailure(code, errorText),
        startedAt,
        endedAt: new Date().toISOString(),
        exitCode: code,
        logPath,
        screenshotPath: fs.existsSync(screenshotPath) ? screenshotPath : null,
        errorText,
      });
    });
  });
}

async function runBrowserTask(task) {
  const screenshotPath = makeScreenshotPath(task.id);
  const logPath = makeLogPath(task.id);
  const runId = `${task.id}-${Date.now()}`;
  const result = await launchBrowserTaskAndWait(task, runId);
  const workerScreenshotPath = result.workerScreenshotPath;
  const workerResultPath = result.resultPath;
  fs.writeFileSync(logPath, `${result.stdout || ''}${result.stderr || ''}`);
  const taskResult = fs.existsSync(workerResultPath) ? JSON.parse(fs.readFileSync(workerResultPath, 'utf8')) : null;
  if (fs.existsSync(workerResultPath)) fs.unlinkSync(workerResultPath);
  if (fs.existsSync(workerScreenshotPath)) fs.copyFileSync(workerScreenshotPath, screenshotPath);

  const hasScreenshot = fs.existsSync(screenshotPath);
  const ok = Boolean(taskResult?.ok || hasScreenshot);
  let errorCode = null;
  if (!ok) {
    if (/timed out/i.test(result.stderr || '')) errorCode = 'timeout';
    else if ((result.stderr || '').includes('Permission denied')) errorCode = 'permission_error';
    else if (taskResult?.error) errorCode = 'browser_task_error';
    else if (!taskResult) errorCode = 'missing_result';
    else errorCode = 'browser_launch_error';
  }

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

async function runTask(task) {
  if (task.use_browser) {
    return runBrowserTask(task);
  }
  return runForegroundTask(task, makeScreenshotPath(task.id));
}

module.exports = {
  runTask,
};
