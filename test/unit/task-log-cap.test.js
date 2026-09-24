const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-f6-'));
process.env.PANEL_RUNTIME_ROOT = tmp;

const config = require('../../config');
const { appendLog, taskLogMaxBytes } = require('../../server/task-runner');

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('taskLogMaxBytes defaults to 50MB', () => {
  assert.equal(taskLogMaxBytes(), 50 * 1024 * 1024);
});

test('appendLog caps run log size, keeps the tail, notes truncation once', () => {
  const prev = config.tasks.logMaxBytes;
  config.tasks.logMaxBytes = 64 * 1024;
  try {
    const logPath = path.join(tmp, 'cap.log');
    for (let i = 0; i < 300; i++) {
      appendLog(logPath, `line-${String(i).padStart(4, '0')}-` + 'x'.repeat(900) + '\n');
    }
    const size = fs.statSync(logPath).size;
    assert.ok(size <= 64 * 1024 + 4096, `log must stay capped, got ${size} bytes`);

    const content = fs.readFileSync(logPath, 'utf8');
    const notices = content.match(/\[日志已达上限/g) || [];
    assert.equal(notices.length, 1, 'truncation notice must be inserted exactly once');

    assert.ok(content.includes('line-0299'), 'newest output (tail) must be preserved');
    assert.ok(!content.includes('line-0000'), 'oldest output (head) must be dropped');

    // Appending after the cap still works and the newest line survives.
    appendLog(logPath, 'FINAL-LINE\n');
    const content2 = fs.readFileSync(logPath, 'utf8');
    assert.ok(content2.includes('FINAL-LINE'), 'post-cap appends must land in the log');
    assert.ok(fs.statSync(logPath).size <= 64 * 1024 + 4096, 'still capped after more appends');
    const notices2 = content2.match(/\[日志已达上限/g) || [];
    assert.equal(notices2.length, 1, 'notice must not be duplicated');
  } finally {
    config.tasks.logMaxBytes = prev;
  }
});

test('F6: a single chunk bigger than the cap is trimmed to its tail, never exceeding the cap', () => {
  const prev = config.tasks.logMaxBytes;
  config.tasks.logMaxBytes = 64 * 1024;
  try {
    const logPath = path.join(tmp, 'huge.log');
    appendLog(logPath, 'A'.repeat(200 * 1024)); // one 200KB write against a 64KB cap
    const size = fs.statSync(logPath).size;
    assert.ok(size <= 64 * 1024, `single huge chunk must not break the hard cap, got ${size} bytes`);
    const content = fs.readFileSync(logPath, 'utf8');
    assert.ok(content.endsWith('A'.repeat(100)), 'the tail of the huge chunk (newest output) must survive');
    assert.ok(content.includes('[日志已达上限'), 'truncation notice must be present');
  } finally {
    config.tasks.logMaxBytes = prev;
  }
});
