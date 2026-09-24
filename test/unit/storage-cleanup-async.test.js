// Must be set before config is first required (fresh process per test file).
process.env.PANEL_RUNTIME_ROOT = require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'browser-panel-f9-')
);

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../../config');
const { cleanupStorage, collectCleanupItems } = require('../../server/storage-cleanup');

// Empty task_runs table stand-in.
const db = {
  db: {
    prepare: () => ({
      all: () => [],
      run: () => ({ changes: 0 }),
    }),
  },
};

const FILE_COUNT = 1500;

test.before(async () => {
  fs.mkdirSync(config.paths.logsDir, { recursive: true });
  const oldMs = Date.now() - 2 * 86400000;
  for (let i = 0; i < FILE_COUNT; i++) {
    const p = path.join(config.paths.logsDir, `task-1-orphan-${i}.log`);
    fs.writeFileSync(p, 'x'.repeat(100));
    fs.utimesSync(p, oldMs / 1000, oldMs / 1000);
  }
});

test('F9: cleanupStorage is async and yields to the event loop', async () => {
  const pending = cleanupStorage(db, { dryRun: false, categories: ['orphanLogs'], retentionDays: 1 });
  assert.equal(typeof pending.then, 'function', 'cleanupStorage must return a promise');

  const fireTimes = [];
  const timer = setInterval(() => fireTimes.push(Date.now()), 5);
  const result = await pending;
  const end = Date.now();
  clearInterval(timer);

  const duringCleanup = fireTimes.filter((t) => t < end);
  assert.ok(
    duringCleanup.length >= 1,
    `event loop must turn while cleanup runs (fired ${duringCleanup.length}x during, ${fireTimes.length} total)`
  );

  // JSON contract unchanged.
  assert.equal(result.dryRun, false);
  assert.equal(result.count, FILE_COUNT);
  assert.ok(result.bytes > 0);
  assert.deepEqual(result.failures, []);
  assert.ok(result.byCategory.orphanLogs, 'byCategory keeps per-category buckets');
  assert.equal(result.byCategory.orphanLogs.count, FILE_COUNT);
  assert.ok(Array.isArray(result.items) && result.items.length === FILE_COUNT);

  const remaining = fs.readdirSync(config.paths.logsDir);
  assert.equal(remaining.length, 0, 'all orphan logs must be deleted');
});

test('F9: dry-run preview keeps the same summary shape without deleting', async () => {
  const p = path.join(config.paths.logsDir, 'task-1-orphan-dry.log');
  const oldMs = Date.now() - 2 * 86400000;
  fs.writeFileSync(p, 'y'.repeat(50));
  fs.utimesSync(p, oldMs / 1000, oldMs / 1000);

  const collected = await collectCleanupItems(db, { dryRun: true, categories: ['orphanLogs'], retentionDays: 1 });
  assert.ok(Array.isArray(collected.items) && collected.items.length >= 1);
  assert.ok(collected.items[0].bytes > 0, 'items still carry computed sizes');
  assert.ok(fs.existsSync(p), 'dry run must not delete');

  const preview = await cleanupStorage(db, { dryRun: true, categories: ['orphanLogs'], retentionDays: 1 });
  assert.equal(preview.dryRun, true);
  assert.ok(fs.existsSync(p), 'dry run must not delete');
});
