const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('PANEL_RUNTIME_ROOT isolates mutable runtime paths', () => {
  const runtimeRoot = path.join('/tmp', 'browser-panel-test-runtime');
  const result = spawnSync(process.execPath, ['-e', `
    const config = require('./config');
    process.stdout.write(JSON.stringify({ browser: config.browser, paths: config.paths }));
  `], {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, PANEL_RUNTIME_ROOT: runtimeRoot },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const { browser, paths } = JSON.parse(result.stdout);
  assert.equal(browser.workDir, path.join(runtimeRoot, 'browser-work'));
  assert.equal(paths.root, path.resolve(__dirname, '../..'));
  assert.equal(paths.dataDir, path.join(runtimeRoot, 'data'));
  assert.equal(paths.dbFile, path.join(runtimeRoot, 'data', 'app.db'));
  assert.equal(paths.logsDir, path.join(runtimeRoot, 'logs'));
  assert.equal(paths.screenshotsDir, path.join(runtimeRoot, 'screenshots'));
  assert.equal(paths.tasksDir, path.join(runtimeRoot, 'tasks'));
  assert.equal(paths.publicDir, path.resolve(__dirname, '../../public'));
  assert.equal(paths.extensionsDir, path.join(runtimeRoot, 'extensions'));
  assert.equal(paths.profilesDir, path.join(runtimeRoot, 'profiles'));
});

test('browser path environment overrides take precedence over PANEL_RUNTIME_ROOT', () => {
  const runtimeRoot = path.join('/tmp', 'browser-panel-test-runtime');
  const browserWork = path.join('/custom', 'work');
  const extensionsDir = path.join('/custom', 'extensions');
  const profilesDir = path.join('/custom', 'profiles');
  const result = spawnSync(process.execPath, ['-e', `
    const config = require('./config');
    process.stdout.write(JSON.stringify({ browser: config.browser, paths: config.paths }));
  `], {
    cwd: path.resolve(__dirname, '../..'),
    env: {
      ...process.env,
      PANEL_RUNTIME_ROOT: runtimeRoot,
      BROWSER_WORK_DIR: browserWork,
      BROWSER_EXTENSIONS_DIR: extensionsDir,
      BROWSER_PROFILES_DIR: profilesDir,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.browser.workDir, browserWork);
  assert.equal(config.paths.extensionsDir, extensionsDir);
  assert.equal(config.paths.profilesDir, profilesDir);
});

test('browser paths retain production defaults without PANEL_RUNTIME_ROOT', () => {
  const result = spawnSync(process.execPath, ['-e', `
    delete process.env.PANEL_RUNTIME_ROOT;
    delete process.env.BROWSER_WORK_DIR;
    delete process.env.BROWSER_EXTENSIONS_DIR;
    delete process.env.BROWSER_PROFILES_DIR;
    const config = require('./config');
    process.stdout.write(JSON.stringify({ browser: config.browser, paths: config.paths }));
  `], {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  const browserWork = path.join('/home', process.env.BROWSER_USER || 'browser', 'browser-work');
  assert.equal(config.browser.workDir, browserWork);
  assert.equal(config.paths.extensionsDir, browserWork);
  assert.equal(config.paths.profilesDir, path.join(browserWork, 'profiles'));
});

test('module check uses and cleans an isolated runtime root', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-check-test-'));
  const guardPath = path.join(tempRoot, 'guard-home-browser-work.js');
  fs.writeFileSync(guardPath, `
    const fs = require('node:fs');
    const originalMkdirSync = fs.mkdirSync;
    fs.mkdirSync = function guardedMkdirSync(target, options) {
      if (String(target).startsWith('/home/browser/browser-work')) {
        const error = new Error('blocked production browser work path');
        error.code = 'EACCES';
        throw error;
      }
      return originalMkdirSync.call(this, target, options);
    };
  `);

  try {
    const result = spawnSync('bash', ['scripts/check-code.sh'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        TMPDIR: tempRoot,
        NODE_OPTIONS: `--require=${guardPath}`,
        BROWSER_USER: 'browser',
        PANEL_RUNTIME_ROOT: '',
        BROWSER_WORK_DIR: '',
        BROWSER_EXTENSIONS_DIR: '',
        BROWSER_PROFILES_DIR: '',
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(fs.readdirSync(tempRoot).sort(), [path.basename(guardPath)]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
