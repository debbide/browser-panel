const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeNextRun,
  runTaskSafely,
  canStartTask,
  isTaskRunning,
  isAnyBrowserTaskRunning,
  getRunningTaskIds,
} = require('../../server/scheduler');

test('computeNextRun advances fixed and interval schedules', () => {
  const from = new Date('2026-09-07T08:00:00.000Z');

  assert.equal(computeNextRun({
    schedule_mode: 'fixed',
    interval_min: 2,
    interval_max: 2,
    interval_unit: 'hours',
  }, from), '2026-09-07T10:00:00.000Z');

  assert.equal(computeNextRun({
    schedule_mode: 'interval',
    interval_min: 30,
    interval_max: 30,
    interval_unit: 'minutes',
  }, from), '2026-09-07T08:30:00.000Z');
});

test('computeNextRun returns null for incomplete interval settings', () => {
  assert.equal(computeNextRun({
    schedule_mode: 'interval',
    interval_min: 5,
    interval_max: null,
    interval_unit: 'minutes',
  }, new Date('2026-09-07T08:00:00.000Z')), null);
});

test('runTaskSafely blocks duplicate execution and releases state', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const task = { id: 41, use_browser: 0 };
  const first = runTaskSafely(41, async () => pending, { task, allowParallel: false });

  assert.equal(isTaskRunning(41), true);
  assert.deepEqual(getRunningTaskIds(), [41]);
  assert.deepEqual(
    await runTaskSafely(41, async () => 'unexpected', { task, allowParallel: false }),
    { skipped: true, reason: 'already_running' }
  );

  release('done');
  assert.equal(await first, 'done');
  assert.equal(isTaskRunning(41), false);
});

test('browser task mutual exclusion respects parallel setting', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const firstTask = { id: 51, use_browser: 1 };
  const secondTask = { id: 52, use_browser: 1 };
  const first = runTaskSafely(51, async () => pending, {
    task: firstTask,
    allowParallel: false,
  });

  assert.equal(isAnyBrowserTaskRunning(), true);
  assert.deepEqual(canStartTask(52, {
    task: secondTask,
    allowParallel: false,
  }), { ok: false, reason: 'browser_busy' });
  assert.deepEqual(canStartTask(52, {
    task: secondTask,
    allowParallel: true,
  }), { ok: true });

  release('done');
  await first;
  assert.equal(isAnyBrowserTaskRunning(), false);
});

test('non-browser tasks remain unrestricted while a browser task is running', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const browserTask = { id: 53, type: 'python', use_browser: 1 };
  const requestTasks = [
    { id: 54, type: 'python', use_browser: 0 },
    { id: 55, type: 'javascript', use_browser: 0 },
    { id: 56, type: 'php', use_browser: 0 },
    { id: 57, type: 'shell', use_browser: 0 },
  ];
  const running = runTaskSafely(53, async () => pending, {
    task: browserTask,
    allowParallel: false,
  });

  for (const task of requestTasks) {
    assert.deepEqual(canStartTask(task.id, {
      task,
      allowParallel: false,
    }), { ok: true });
  }

  release('done');
  await running;
});

test('runTaskSafely releases state when execution throws', async () => {
  const task = { id: 61, use_browser: 0 };
  await assert.rejects(
    runTaskSafely(61, async () => { throw new Error('boom'); }, {
      task,
      allowParallel: false,
    }),
    /boom/
  );
  assert.equal(isTaskRunning(61), false);
});
