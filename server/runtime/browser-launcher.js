const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('../../config');

function getRuntimeDataDir() {
  return path.join(config.paths.root, 'runtime-data');
}

function getTempProfileDir(task) {
  return path.join(getRuntimeDataDir(), 'profiles', `task-${task.id}-tmp-profile`);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function ensureRuntimeFiles(task) {
  fs.mkdirSync('/home/abc61154321/browser-work/node_modules', { recursive: true });
  fs.mkdirSync(path.join(getRuntimeDataDir(), 'profiles'), { recursive: true });
  const files = [
    { from: path.join(config.paths.root, 'node_modules', 'playwright'), to: '/home/abc61154321/browser-work/node_modules/playwright' },
    { from: path.join(config.paths.root, 'node_modules', 'playwright-core'), to: '/home/abc61154321/browser-work/node_modules/playwright-core' },
    { from: path.join(config.paths.root, 'server', 'runtime', 'browser-runtime.js'), to: '/home/abc61154321/browser-work/browser-runtime.js' },
    { from: path.join(config.paths.root, 'server', 'runtime', 'js-task-wrapper.js'), to: '/home/abc61154321/browser-work/js-task-wrapper.js' },
    { from: path.resolve(config.paths.root, task.script_path), to: `/home/abc61154321/browser-work/${path.basename(task.script_path)}` },
  ];
  for (const file of files) {
    if (!fs.existsSync(file.from)) continue;
    if (fs.existsSync(file.to)) fs.rmSync(file.to, { recursive: true, force: true });
    fs.cpSync(file.from, file.to, { recursive: true });
  }
  if (!fs.existsSync('/tmp/node-openclaw')) {
    fs.copyFileSync('/root/.nvm/versions/node/v22.22.1/bin/node', '/tmp/node-openclaw');
    fs.chmodSync('/tmp/node-openclaw', 0o755);
  }
  spawnSync('bash', ['-lc', 'chown -R abc61154321:abc61154321 /home/abc61154321/browser-work'], { stdio: 'ignore' });
}

async function launchBrowserTaskAndWait(task, runId) {
  ensureRuntimeFiles(task);
  const baseName = path.basename(task.script_path);
  const taskFile = `/home/abc61154321/browser-work/${baseName}`;
  const wrapperFile = '/home/abc61154321/browser-work/js-task-wrapper.js';
  const workerScreenshotPath = `/home/abc61154321/browser-work/screenshots/task-${task.id}-${runId}.png`;
  const resultPath = `/home/abc61154321/browser-work/task-results/run-${runId}.json`;
  const runner = task.type === 'python'
    ? `${shellEscape('/usr/bin/python3')} ${shellEscape(taskFile)}`
    : `${shellEscape('/tmp/node-openclaw')} ${shellEscape(wrapperFile)} ${shellEscape(taskFile)}`;

  const cmd = [
    'cd /home/abc61154321/browser-work &&',
    `DISPLAY=${shellEscape(config.browser.display)}`,
    `XAUTHORITY=${shellEscape(config.browser.xauthority)}`,
    `BROWSER_USER_DATA_DIR=${shellEscape(task._profile ? task._profile.user_data_dir : (task.use_persistent ? config.browser.userDataDir : getTempProfileDir(task)))}`,
    `BROWSER_CHROME_PATH=${shellEscape(config.browser.chromePath)}`,
    `BROWSER_PROXY=${shellEscape(task._profile ? task._profile.proxy : (config.browser.proxy || ''))}`,
    `TASK_SCREENSHOT_PATH=${shellEscape(workerScreenshotPath)}`,
    `TASK_RESULT_PATH=${shellEscape(resultPath)}`,
    runner,
  ].join(' ');

  const startedAt = new Date().toISOString();
  const result = spawnSync('su', ['-s', '/bin/bash', config.browser.user, '-c', cmd], {
    encoding: 'utf8',
    timeout: task.timeout_sec * 1000,
  });

  return {
    startedAt,
    endedAt: new Date().toISOString(),
    exitCode: result.status ?? (result.signal ? 1 : 0),
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    workerScreenshotPath,
    resultPath,
  };
}

module.exports = {
  launchBrowserTaskAndWait,
};
