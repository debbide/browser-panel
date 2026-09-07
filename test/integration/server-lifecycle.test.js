const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '../..');

test('importing server/index does not listen and exposes lifecycle API', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-lifecycle-'));
  try {
    const script = `
      const server = require('./server/index');
      if (!server || typeof server.startServer !== 'function') {
        throw new Error('startServer export is required');
      }
      if (typeof server.closeCoreServices !== 'function') {
        throw new Error('closeCoreServices export is required');
      }
      process.stdout.write('imported without listening');
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PANEL_RUNTIME_ROOT: runtimeRoot,
        HOST: '127.0.0.1',
        PORT: '0',
      },
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.equal(result.signal, null, result.stderr || 'server import timed out');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /imported without listening/);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
