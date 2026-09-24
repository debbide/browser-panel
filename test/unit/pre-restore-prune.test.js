// Must be set before config/db are first required (fresh process per test file).
process.env.PANEL_RUNTIME_ROOT = require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'browser-panel-f8-')
);

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = require('../../config');
const { swapDataDir, pruneOldPreRestoreDirs, PRE_RESTORE_KEEP } = require('../../server/cloud/backup-service');

const dataDir = config.paths.dataDir;

function makePreRestore(name, ageMs) {
  const dir = path.join(dataDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'app.db'), 'old');
  const t = Date.now() - ageMs;
  fs.utimesSync(dir, t / 1000, t / 1000);
  return dir;
}

test('F8: pruneOldPreRestoreDirs keeps the newest 3 and removes older ones', async () => {
  fs.mkdirSync(dataDir, { recursive: true });
  const keepDir = path.join(dataDir, 'keep-me');
  fs.mkdirSync(keepDir, { recursive: true });

  const dirs = [
    makePreRestore('pre-restore-20200101000000', 50 * 86400000),
    makePreRestore('pre-restore-20200201000000', 40 * 86400000),
    makePreRestore('pre-restore-20200301000000', 30 * 86400000),
    makePreRestore('pre-restore-20200401000000', 20 * 86400000),
    makePreRestore('pre-restore-20200501000000', 10 * 86400000),
  ];

  await pruneOldPreRestoreDirs();

  const remaining = fs.readdirSync(dataDir).filter((n) => n.startsWith('pre-restore-'));
  assert.equal(remaining.length, PRE_RESTORE_KEEP);
  assert.ok(!fs.existsSync(dirs[0]), 'oldest must be gone');
  assert.ok(!fs.existsSync(dirs[1]), 'second oldest must be gone');
  assert.ok(fs.existsSync(dirs[4]), 'newest must survive');
  assert.ok(fs.existsSync(keepDir), 'non-pre-restore dirs must be untouched');

  // Idempotent: a second run changes nothing.
  await pruneOldPreRestoreDirs();
  assert.equal(fs.readdirSync(dataDir).filter((n) => n.startsWith('pre-restore-')).length, PRE_RESTORE_KEEP);
});

test('F8: swapDataDir prunes old pre-restore dirs but never the just-created one', async () => {
  // Start clean for this test.
  for (const name of fs.readdirSync(dataDir)) {
    if (name.startsWith('pre-restore-')) fs.rmSync(path.join(dataDir, name), { recursive: true, force: true });
  }
  makePreRestore('pre-restore-20210101000000', 50 * 86400000);
  makePreRestore('pre-restore-20210201000000', 40 * 86400000);
  makePreRestore('pre-restore-20210301000000', 30 * 86400000);
  makePreRestore('pre-restore-20210401000000', 20 * 86400000);

  // Minimal live data + staging for the swap.
  fs.mkdirSync(config.paths.tasksDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'app.db'), 'live-db');
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-f8swap-'));
  fs.writeFileSync(path.join(staging, 'app.db'), 'staged-db');
  fs.mkdirSync(path.join(staging, 'tasks'), { recursive: true });

  const preRestoreDir = swapDataDir(staging);
  assert.ok(fs.existsSync(preRestoreDir), 'just-created pre-restore dir must exist');

  // The prune is fire-and-forget; give it a moment.
  for (let i = 0; i < 50 && fs.readdirSync(dataDir).filter((n) => n.startsWith('pre-restore-')).length > PRE_RESTORE_KEEP; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const remaining = fs.readdirSync(dataDir).filter((n) => n.startsWith('pre-restore-'));
  assert.ok(remaining.length <= PRE_RESTORE_KEEP, `at most ${PRE_RESTORE_KEEP} kept, got ${remaining.length}`);
  assert.ok(fs.existsSync(preRestoreDir), 'the rollback dir returned to the UI must survive pruning');
  assert.ok(remaining.includes(path.basename(preRestoreDir)), 'newest dir must be among the kept');

  fs.rmSync(staging, { recursive: true, force: true });
});
