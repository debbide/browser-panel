const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-f12-'));
process.env.PANEL_RUNTIME_ROOT = runtimeRoot;

const { _waitForManualBrowserReady } = require('../../server/browser');

test.after(() => {
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
});

test('manual browser pipes stay drained after ready (no write block)', async () => {
  // Child signals ready, then floods stdout with ~6.4MB — far beyond the
  // 64KB pipe buffer. If nobody drains the pipe after ready, the child
  // blocks on write forever.
  const child = spawn(process.execPath, ['-e', `
    console.log('MANUAL_BROWSER_READY');
    const chunk = 'x'.repeat(65536);
    for (let i = 0; i < 100; i++) process.stdout.write(chunk);
    process.exit(0);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });

  await _waitForManualBrowserReady(child, { timeoutMs: 5000 });

  // After ready the launch listeners are gone; streams must be in flowing
  // mode so the kernel pipe buffer never fills.
  assert.equal(child.stdout.readableFlowing, true, 'stdout must be resumed after ready');
  assert.equal(child.stderr.readableFlowing, true, 'stderr must be resumed after ready');

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child blocked on pipe write')), 10000);
    child.once('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  assert.equal(code, 0);
});
