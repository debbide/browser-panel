const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const logStream = require('../../server/log-stream');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-f6sse-'));
test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function mockRes() {
  const frames = [];
  return {
    frames,
    writableEnded: false,
    destroyed: false,
    write(chunk) {
      frames.push(String(chunk));
      return true;
    },
    on() {},
  };
}

function parseFrames(res) {
  return res.frames
    .join('')
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const event = (block.match(/^event: (.+)$/m) || [])[1];
      const data = (block.match(/^data: (.+)$/m) || [])[1];
      return { event, data: data ? JSON.parse(data) : null };
    });
}

test('log stream notifies clients with truncated:true when the file shrinks', async () => {
  const logPath = path.join(tmp, 'run.log');
  fs.writeFileSync(logPath, 'x'.repeat(100));

  const res = mockRes();
  const cleanup = logStream.subscribe(logPath, res);

  // Grow the file: client gets a normal size update.
  fs.appendFileSync(logPath, 'y'.repeat(100));
  logStream.publish(logPath);
  await new Promise((r) => setTimeout(r, 250));
  let frames = parseFrames(res);
  let logFrames = frames.filter((f) => f.event === 'log');
  assert.ok(logFrames.length >= 1, 'expected at least one log frame after growth');
  assert.ok(logFrames.every((f) => !f.data.truncated), 'growth frames must not be marked truncated');

  // Simulate the server-side size cap: file shrinks, keeping only the tail.
  fs.writeFileSync(logPath, 'z'.repeat(10));
  logStream.publish(logPath);
  await new Promise((r) => setTimeout(r, 250));
  frames = parseFrames(res);
  logFrames = frames.filter((f) => f.event === 'log');
  const truncated = logFrames.filter((f) => f.data.truncated);
  assert.equal(truncated.length, 1, 'expected exactly one truncated frame');
  assert.equal(truncated[0].data.size, 10);

  cleanup();
});
