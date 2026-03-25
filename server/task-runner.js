const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');

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

function buildEnv(task) {
  const env = { ...process.env };
  if (task.use_browser) {
    env.BROWSER_DISPLAY = config.browser.display;
    env.BROWSER_XAUTHORITY = config.browser.xauthority;
    env.BROWSER_USER = config.browser.user;
    env.BROWSER_USER_DATA_DIR = task.use_persistent ? config.browser.userDataDir : path.join(config.paths.dataDir, 'tmp-profile');
    env.BROWSER_CHROME_PATH = config.browser.chromePath;
    env.BROWSER_PROXY = config.browser.proxy;
    env.BROWSER_HEADLESS = 'false';
  }
  env.APP_ROOT = config.paths.root;
  env.LOGS_DIR = config.paths.logsDir;
  env.SCREENSHOTS_DIR = config.paths.screenshotsDir;
  return env;
}

function getCommand(task) {
  if (task.type === 'python') {
    return { cmd: 'python3', args: [task.script_path] };
  }
  return { cmd: 'node', args: [task.script_path] };
}

function runTask(task) {
  return new Promise((resolve) => {
    const logPath = makeLogPath(task.id);
    const screenshotPath = makeScreenshotPath(task.id);
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    const startedAt = new Date().toISOString();
    const { cmd, args } = getCommand(task);
    const child = spawn(cmd, args, {
      cwd: config.paths.root,
      env: buildEnv(task),
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
      const endedAt = new Date().toISOString();
      const status = code === 0 ? 'success' : 'failed';
      const screenshotExists = fs.existsSync(screenshotPath);
      resolve({
        status,
        startedAt,
        endedAt,
        exitCode: code,
        logPath,
        screenshotPath: screenshotExists ? screenshotPath : null,
        errorText: stderrText.trim() || null,
      });
    });
  });
}

module.exports = {
  runTask,
};
