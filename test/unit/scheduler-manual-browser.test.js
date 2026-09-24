const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-f4-'));
process.env.PANEL_RUNTIME_ROOT = runtimeRoot;

// Stub the manual browser BEFORE scheduler.js loads ./browser.
const browserPath = require.resolve('../../server/browser.js');
const manualDir = path.join(runtimeRoot, 'manual-profile');
let manualOpen = false;
require.cache[browserPath] = {
  id: browserPath,
  filename: browserPath,
  loaded: true,
  exports: {
    getManualBrowserStatus: () => ({
      open: manualOpen,
      openedAt: manualOpen ? new Date().toISOString() : null,
      userDataDir: manualDir,
      warp: null,
    }),
  },
};

const db = require('../../server/db');
const scheduler = require('../../server/scheduler');

test.after(() => {
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
});

const sameProfile = db.createBrowserProfile({ name: 'same', user_data_dir: manualDir });
const otherProfile = db.createBrowserProfile({ name: 'other', user_data_dir: path.join(runtimeRoot, 'other-profile') });

const taskWith = (overrides) => ({
  id: 7000 + Math.floor(Math.random() * 1000),
  use_browser: 1,
  use_persistent: 1,
  browser_profile_id: null,
  params_json: '{}',
  ...overrides,
});

test('scheduler gate allows browser tasks when manual browser is closed', () => {
  manualOpen = false;
  const gate = scheduler.canStartTask(7101, {
    task: taskWith({ browser_profile_id: sameProfile.id }),
  });
  assert.deepEqual(gate, { ok: true });
});

test('scheduler gate blocks only the colliding profile when manual browser is open', () => {
  manualOpen = true;
  try {
    const colliding = scheduler.canStartTask(7102, {
      task: taskWith({ browser_profile_id: sameProfile.id }),
    });
    assert.deepEqual(colliding, { ok: false, reason: 'manual_browser_busy' });

    const differentProfile = scheduler.canStartTask(7103, {
      task: taskWith({ browser_profile_id: otherProfile.id }),
    });
    assert.deepEqual(differentProfile, { ok: true });

    // Temp-profile task: unique per-run dir, never contends.
    const tempTask = scheduler.canStartTask(7104, {
      task: taskWith({ use_persistent: 0, browser_profile_id: null }),
    });
    assert.deepEqual(tempTask, { ok: true });

    // Non-browser task is unaffected.
    const shellTask = scheduler.canStartTask(7105, {
      task: taskWith({ use_browser: 0 }),
    });
    assert.deepEqual(shellTask, { ok: true });
  } finally {
    manualOpen = false;
  }
});

test('runTaskSafely surfaces manual_browser_busy without running the task', async () => {
  manualOpen = true;
  try {
    let ran = false;
    const result = await scheduler.runTaskSafely(7106, async () => { ran = true; return 'done'; }, {
      task: taskWith({ browser_profile_id: sameProfile.id }),
    });
    assert.deepEqual(result, { skipped: true, reason: 'manual_browser_busy' });
    assert.equal(ran, false);
  } finally {
    manualOpen = false;
  }
});

test('checkManualBrowserCollision honors the HTTP profileId override', () => {
  manualOpen = true;
  try {
    // Task bound to the colliding profile, but the caller overrides to a
    // different profile: no collision.
    const gate = scheduler.canStartTask(7107, {
      task: taskWith({ browser_profile_id: sameProfile.id }),
      profileId: otherProfile.id,
    });
    assert.deepEqual(gate, { ok: true });

    // Override to the colliding profile: blocked.
    const gate2 = scheduler.canStartTask(7108, {
      task: taskWith({ browser_profile_id: otherProfile.id }),
      profileId: sameProfile.id,
    });
    assert.deepEqual(gate2, { ok: false, reason: 'manual_browser_busy' });
  } finally {
    manualOpen = false;
  }
});
