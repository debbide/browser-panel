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

test('application factory creates independent apps without listening', () => {
  const script = `
    const { createApp } = require('./server/app');
    const first = createApp({ registerRoutes(app) { app.get('/marker', (req, res) => res.json({ marker: 'first' })); } });
    const second = createApp({ registerRoutes(app) { app.get('/marker', (req, res) => res.json({ marker: 'second' })); } });
    if (first === second) throw new Error('createApp reused an application instance');
    if (typeof first.listen !== 'function' || typeof second.listen !== 'function') throw new Error('createApp did not return Express apps');
    process.stdout.write('independent apps created');
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 10000,
  });

  assert.equal(result.signal, null, result.stderr || 'app factory test timed out');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /independent apps created/);
});

test('lifecycle starts and shuts down only once', () => {
  const script = `
    const { createLifecycle } = require('./server/lifecycle');
    let listens = 0;
    let closes = 0;
    let coreCloses = 0;
    const server = { close(resolve) { closes += 1; resolve(); } };
    const lifecycle = createLifecycle({
      app: { listen() { listens += 1; return server; } },
      host: '127.0.0.1',
      port: 0,
      onStarted() {},
      async closeCoreServices() { coreCloses += 1; },
    });
    if (lifecycle.startServer() !== server || lifecycle.startServer() !== server) throw new Error('startServer result changed');
    Promise.all([lifecycle.shutdown('one'), lifecycle.shutdown('two')]).then(() => {
      if (listens !== 1 || closes !== 1 || coreCloses !== 1) {
        throw new Error(JSON.stringify({ listens, closes, coreCloses }));
      }
      process.stdout.write('lifecycle is idempotent');
    }).catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 10000,
  });

  assert.equal(result.signal, null, result.stderr || 'lifecycle idempotency test timed out');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /lifecycle is idempotent/);
});
