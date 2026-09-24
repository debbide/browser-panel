const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '../..');

// Drives the real triggerTaskExecution in an isolated panel runtime.
function runTrigger({ wait } = {}) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-f5-'));
  try {
    const script = `
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const config = require('./config');
      const db = require('./server/db');
      const app = require('./server/application');
      (async () => {
        const scriptPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'f5-script-')), 'f5-sleep.sh');
        fs.writeFileSync(scriptPath, '#!/bin/sh\\nsleep 2\\necho done\\n');
        const taskId = db.db.prepare(
          "INSERT INTO tasks (name, type, script_path, use_browser, timeout_sec) VALUES ('f5', 'shell', ?, 0, 30)"
        ).run(scriptPath).lastInsertRowid;
        const t0 = Date.now();
        const res = await app.triggerTaskExecution(taskId, ${wait ? '{ wait: true }' : '{}'});
        const elapsedMs = Date.now() - t0;
        const out = { status: res.status, payload: res.payload, elapsedMs };
        if (res.status === 202 && res.payload.runId) {
          // Fire the second trigger immediately, while the first run is still
          // active: the gate must reject it, not double-start the task.
          const res2 = await app.triggerTaskExecution(taskId, {});
          out.secondStatus = res2.status;
          out.secondCode = res2.payload && res2.payload.code;
          // Then wait for the first run to finish.
          let run;
          for (let i = 0; i < 150; i++) {
            run = db.getRun(res.payload.runId);
            if (run && run.status !== 'running') break;
            await new Promise((r) => setTimeout(r, 100));
          }
          out.finalStatus = run && run.status;
        }
        console.log('F5RESULT ' + JSON.stringify(out));
      })().catch((e) => { console.error('F5FAIL ' + (e && e.stack || e)); process.exit(1); });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: projectRoot,
      env: { ...process.env, PANEL_RUNTIME_ROOT: runtimeRoot },
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.equal(result.status, 0, result.stderr);
    const line = result.stdout.split('\n').find((l) => l.startsWith('F5RESULT '));
    assert.ok(line, 'trigger script must print F5RESULT; stderr: ' + result.stderr);
    return JSON.parse(line.slice('F5RESULT '.length));
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

test('POST /run defaults to async: 202 + runId without waiting for the task', () => {
  const out = runTrigger({});
  assert.equal(out.status, 202);
  assert.ok(Number.isInteger(out.payload.runId), 'payload must carry runId');
  assert.equal(out.payload.status, 'running');
  assert.ok(out.elapsedMs < 1500, `202 must return fast (task sleeps 2s), took ${out.elapsedMs}ms`);
  assert.equal(out.finalStatus, 'success', 'background run must still complete');
});

test('POST /run?wait=1 keeps the legacy blocking semantics', () => {
  const out = runTrigger({ wait: true });
  assert.equal(out.status, 200);
  assert.ok(out.elapsedMs >= 1800, `blocking call must wait for the task, took ${out.elapsedMs}ms`);
  assert.equal(out.payload.data.status, 'success');
});

test('a second trigger while running is rejected, not double-started', () => {
  const out = runTrigger({});
  // In async mode the first trigger returns 202 immediately, so the second
  // trigger races a genuinely running task.
  assert.equal(out.secondStatus, 409);
  assert.equal(out.secondCode, 'already_running');
});
