const db = require('./db');
const { listTasks, updateTask } = db;
const {
  evaluateTaskCondition,
  conditionFromTask,
} = require('./conditions');

const runningTasks = new Set();
let mainLoopHandle = null;
let tickInFlight = false;

const MAX_CONDITION_EVALS_PER_TICK = 3;

function stopAllJobs() {
  if (mainLoopHandle) {
    clearInterval(mainLoopHandle);
    mainLoopHandle = null;
  }
}

function isTaskRunning(taskId) {
  return runningTasks.has(Number(taskId));
}

function isAnyTaskRunning() {
  return runningTasks.size > 0;
}

function getRunningTaskIds() {
  return Array.from(runningTasks).map(Number);
}

function getRunningCount() {
  return runningTasks.size;
}

/**
 * @returns {{ ok: true } | { ok: false, reason: 'already_running' | 'global_busy' }}
 */
function canStartTask(taskId, { allowParallel } = {}) {
  const id = Number(taskId);
  if (runningTasks.has(id)) {
    return { ok: false, reason: 'already_running' };
  }
  const parallel = allowParallel === undefined
    ? db.isTaskParallelAllowed()
    : Boolean(allowParallel);
  if (!parallel && runningTasks.size > 0) {
    return { ok: false, reason: 'global_busy' };
  }
  return { ok: true };
}

async function runTaskSafely(taskId, runTaskById, options = {}) {
  const id = Number(taskId);
  const allowParallel = options.allowParallel === undefined
    ? db.isTaskParallelAllowed()
    : Boolean(options.allowParallel);
  const gate = canStartTask(id, { allowParallel });
  if (!gate.ok) {
    return { skipped: true, reason: gate.reason };
  }
  runningTasks.add(id);
  try {
    return await runTaskById(id);
  } finally {
    runningTasks.delete(id);
  }
}

function randomIntInclusive(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function addInterval(date, value, unit) {
  const next = new Date(date.getTime());
  if (unit === 'days') next.setUTCDate(next.getUTCDate() + value);
  else if (unit === 'minutes') next.setUTCMinutes(next.getUTCMinutes() + value);
  else next.setUTCHours(next.getUTCHours() + value);
  return next;
}

function getTzDate(baseDate, targetMin, addDays = 0) {
  let tz = 'Asia/Shanghai';
  try { tz = require('../config').browser.timezoneId || tz; } catch (e) {}

  const shiftDate = new Date(baseDate.getTime() + addDays * 24 * 3600 * 1000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(shiftDate);

  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;

  const h = Math.floor(targetMin / 60);
  const min = targetMin % 60;
  const localStr = `${y}-${m}-${d}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00.000`;

  const offsetParts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'longOffset'
  }).formatToParts(shiftDate);
  const gmtStr = offsetParts.find(p => p.type === 'timeZoneName')?.value || 'GMT';
  const offsetStr = gmtStr === 'GMT' ? 'Z' : gmtStr.replace('GMT', '');

  return new Date(localStr + offsetStr);
}

function computeNextRun(task, fromDate = new Date(), isReschedule = false) {
  if (task.schedule_mode === 'daily_window') {
    const startStr = task.daily_time_start || '00:00';
    const endStr = task.daily_time_end || '23:59';
    const [startH, startM] = startStr.split(':').map(Number);
    const [endH, endM] = endStr.split(':').map(Number);

    const startTotalMin = (startH || 0) * 60 + (startM || 0);
    const endTotalMin = (endH || 0) * 60 + (endM || 0);

    let targetMin = startTotalMin;
    if (endTotalMin > startTotalMin) {
       targetMin = randomIntInclusive(startTotalMin, endTotalMin);
    }

    let candidate = getTzDate(fromDate, targetMin, isReschedule ? 1 : 0);

    if (!isReschedule && candidate.getTime() <= fromDate.getTime()) {
      if (endTotalMin > startTotalMin) {
         targetMin = randomIntInclusive(startTotalMin, endTotalMin);
      }
      candidate = getTzDate(fromDate, targetMin, 1);
    }

    return candidate.toISOString();
  }

  const min = Number(task.interval_min || 0);
  const max = Number(task.interval_max || 0);
  const unit = task.interval_unit || 'hours';
  if (!min || !max) return null;

  const value = task.schedule_mode === 'interval' ? randomIntInclusive(min, max) : min;
  return addInterval(fromDate, value, unit).toISOString();
}

function isConditionEnabled(task) {
  return Boolean(Number(task && task.condition_enabled));
}

function isScheduleEnabled(task) {
  return Boolean(Number(task && task.enabled));
}

function getCheckIntervalSec(task) {
  const cond = conditionFromTask(task);
  return Math.max(30, Number(cond.check_interval_sec) || 300);
}

function getCooldownSec(task) {
  const cond = conditionFromTask(task);
  return Math.max(0, Number(cond.cooldown_sec) || 600);
}

function parseIsoMs(value) {
  if (!value) return NaN;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? NaN : t;
}

function isInCooldown(task, nowMs = Date.now()) {
  const until = parseIsoMs(task.condition_cooldown_until);
  return Number.isFinite(until) && until > nowMs;
}

function patchTask(taskId, patch) {
  const latest = listTasks().find((item) => item.id === taskId);
  if (!latest) return null;
  return updateTask(taskId, { ...latest, ...patch });
}

function recordConditionResult(taskId, result) {
  return patchTask(taskId, {
    condition_last_status: result.status || null,
    condition_last_detail: String(result.detail || '').slice(0, 500) || null,
    condition_last_checked_at: new Date().toISOString(),
  });
}

function setConditionNextCheck(taskId, whenDate) {
  return patchTask(taskId, {
    condition_next_check_at: whenDate ? new Date(whenDate).toISOString() : null,
  });
}

function applyCooldown(taskId, task) {
  const sec = getCooldownSec(task);
  if (sec <= 0) {
    return patchTask(taskId, { condition_cooldown_until: null });
  }
  const until = new Date(Date.now() + sec * 1000).toISOString();
  return patchTask(taskId, { condition_cooldown_until: until });
}

function rescheduleTask(taskId) {
  const latestTask = listTasks().find(item => item.id === taskId);
  if (latestTask && latestTask.enabled) {
    const nextTime = computeNextRun(latestTask, new Date(), true);
    if (nextTime) updateTask(taskId, { ...latestTask, next_run_at: nextTime });
  }
}

/**
 * Fire a task. options.conditionTriggered: apply cooldown after successful start.
 * options.onSkipped: called when runTaskSafely skips (serial busy etc.)
 */
function fireTask(task, runTaskById, options = {}) {
  const taskId = task.id;
  const conditionTriggered = Boolean(options.conditionTriggered);
  runTaskSafely(taskId, runTaskById)
    .then((result) => {
      if (result?.skipped) {
        if (typeof options.onSkipped === 'function') options.onSkipped(result);
        return;
      }
      if (isScheduleEnabled(task) || (listTasks().find((t) => t.id === taskId) || {}).enabled) {
        rescheduleTask(taskId);
      }
      if (conditionTriggered) {
        const latest = listTasks().find((t) => t.id === taskId) || task;
        applyCooldown(taskId, latest);
        // pure-condition: push next check past cooldown/interval
        if (!isScheduleEnabled(latest) && isConditionEnabled(latest)) {
          const intervalMs = getCheckIntervalSec(latest) * 1000;
          const cooldownMs = getCooldownSec(latest) * 1000;
          const delay = Math.max(intervalMs, cooldownMs);
          setConditionNextCheck(taskId, new Date(Date.now() + delay));
        }
      }
    })
    .catch((err) => {
      console.error('[scheduler] run error:', err);
      if (isScheduleEnabled(task)) rescheduleTask(taskId);
    });
}

async function evaluateAndRecord(task) {
  const result = await evaluateTaskCondition(task);
  recordConditionResult(task.id, result);
  console.log(
    `[condition] task#${task.id} ${result.type || 'cond'} ${result.status}: ${result.detail || ''}`
  );
  return result;
}

async function processPureConditionTasks(tasks, runTaskById, now, evalBudget) {
  let used = 0;
  for (const task of tasks) {
    if (used >= evalBudget) break;
    if (!isConditionEnabled(task)) continue;
    // pure condition only when schedule is off
    if (isScheduleEnabled(task)) continue;
    if (isTaskRunning(task.id)) continue;

    let nextCheckMs = parseIsoMs(task.condition_next_check_at);
    if (!Number.isFinite(nextCheckMs)) {
      setConditionNextCheck(task.id, new Date(now));
      nextCheckMs = now;
    }
    if (now < nextCheckMs) continue;

    if (isInCooldown(task, now)) {
      const until = parseIsoMs(task.condition_cooldown_until);
      const intervalMs = getCheckIntervalSec(task) * 1000;
      const next = Number.isFinite(until) ? Math.max(until, now + intervalMs) : now + intervalMs;
      setConditionNextCheck(task.id, new Date(next));
      continue;
    }

    used += 1;
    let result;
    try {
      result = await evaluateAndRecord(task);
    } catch (err) {
      console.error('[condition] evaluate error:', err);
      recordConditionResult(task.id, {
        status: 'error',
        detail: err.message || String(err),
      });
      setConditionNextCheck(task.id, new Date(now + getCheckIntervalSec(task) * 1000));
      continue;
    }

    if (result.shouldTrigger) {
      fireTask(task, runTaskById, {
        conditionTriggered: true,
        onSkipped: () => {
          // keep next_check due so serial queue can pick it up next tick
        },
      });
      // optimistically leave next_check as-is until success path advances it;
      // if started, fireTask success sets next_check; if skipped, stays due.
    } else {
      setConditionNextCheck(task.id, new Date(now + getCheckIntervalSec(task) * 1000));
    }
  }
  return used;
}

async function collectScheduleDue(tasks, now, evalBudget) {
  const due = [];
  let used = 0;

  for (const task of tasks) {
    if (!isScheduleEnabled(task)) continue;

    const nextRunAtStr = task.next_run_at;
    if (!nextRunAtStr) {
      const nextRunAt = computeNextRun(task);
      if (nextRunAt) {
        updateTask(task.id, { ...task, next_run_at: nextRunAt });
      }
      continue;
    }

    const expectedTime = new Date(nextRunAtStr).getTime();
    if (Number.isNaN(expectedTime)) continue;
    if (now < expectedTime) continue;
    if (isTaskRunning(task.id)) continue;

    if (!isConditionEnabled(task)) {
      due.push(task);
      continue;
    }

    // schedule + condition
    if (isInCooldown(task, now)) {
      rescheduleTask(task.id);
      continue;
    }

    if (used >= evalBudget) {
      // leave next_run_at overdue for next tick
      continue;
    }

    used += 1;
    let result;
    try {
      result = await evaluateAndRecord(task);
    } catch (err) {
      console.error('[condition] evaluate error:', err);
      recordConditionResult(task.id, {
        status: 'error',
        detail: err.message || String(err),
      });
      // treat evaluate crash as trigger-worthy? safer to reschedule and not fire
      rescheduleTask(task.id);
      continue;
    }

    if (result.shouldTrigger) {
      due.push({ ...task, _conditionTriggered: true });
    } else {
      // healthy — skip this schedule slot
      rescheduleTask(task.id);
    }
  }

  return { due, used };
}

function startMainLoop(runTaskById) {
  stopAllJobs();

  const tick = async () => {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      const tasks = listTasks();
      const now = Date.now();
      const allowParallel = db.isTaskParallelAllowed();

      // Ensure pure-condition tasks have a next check time
      for (const task of tasks) {
        if (isConditionEnabled(task) && !isScheduleEnabled(task) && !task.condition_next_check_at) {
          setConditionNextCheck(task.id, new Date(now));
        }
      }

      let budget = MAX_CONDITION_EVALS_PER_TICK;
      const pureUsed = await processPureConditionTasks(tasks, runTaskById, now, budget);
      budget -= pureUsed;

      // refresh tasks after pure path patches
      const tasks2 = listTasks();
      const { due } = await collectScheduleDue(tasks2, now, Math.max(0, budget));

      if (!due.length) return;

      if (allowParallel) {
        for (const task of due) {
          fireTask(task, runTaskById, {
            conditionTriggered: Boolean(task._conditionTriggered),
          });
        }
        return;
      }

      if (isAnyTaskRunning()) return;

      due.sort((a, b) => {
        const ta = new Date(a.next_run_at).getTime();
        const tb = new Date(b.next_run_at).getTime();
        if (ta !== tb) return ta - tb;
        return Number(a.id) - Number(b.id);
      });
      fireTask(due[0], runTaskById, {
        conditionTriggered: Boolean(due[0]._conditionTriggered),
      });
    } catch (err) {
      console.error('[scheduler] tick error:', err);
    } finally {
      tickInFlight = false;
    }
  };

  tick();
  mainLoopHandle = setInterval(tick, 10000);
}

function reloadJobs(runTaskById) {
  const tasks = listTasks();
  for (const task of tasks) {
    if (task.enabled && !task.next_run_at) {
       const nextTime = computeNextRun(task);
       if (nextTime) updateTask(task.id, { ...task, next_run_at: nextTime });
    }
    if (isConditionEnabled(task) && !isScheduleEnabled(task) && !task.condition_next_check_at) {
      updateTask(task.id, {
        ...task,
        condition_next_check_at: new Date().toISOString(),
      });
    }
  }
  startMainLoop(runTaskById);
}

module.exports = {
  computeNextRun,
  reloadJobs,
  stopAllJobs,
  isTaskRunning,
  isAnyTaskRunning,
  getRunningTaskIds,
  getRunningCount,
  canStartTask,
  runTaskSafely,
  evaluateTaskCondition,
};
