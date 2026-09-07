const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('PANEL_RUNTIME_ROOT isolates mutable runtime paths', () => {
  const runtimeRoot = path.join('/tmp', 'browser-panel-test-runtime');
  const result = spawnSync(process.execPath, ['-e', `
    const config = require('./config');
    process.stdout.write(JSON.stringify(config.paths));
  `], {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, PANEL_RUNTIME_ROOT: runtimeRoot },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const paths = JSON.parse(result.stdout);
  assert.equal(paths.root, path.resolve(__dirname, '../..'));
  assert.equal(paths.dataDir, path.join(runtimeRoot, 'data'));
  assert.equal(paths.dbFile, path.join(runtimeRoot, 'data', 'app.db'));
  assert.equal(paths.logsDir, path.join(runtimeRoot, 'logs'));
  assert.equal(paths.screenshotsDir, path.join(runtimeRoot, 'screenshots'));
  assert.equal(paths.tasksDir, path.join(runtimeRoot, 'tasks'));
  assert.equal(paths.publicDir, path.resolve(__dirname, '../../public'));
});
