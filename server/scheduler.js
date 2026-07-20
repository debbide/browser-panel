const db = require('./db');
const { listTasks, updateTask } = db;

const runningTasks = new Set();
let mainLoopHandle = null;

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

  // 如果是随机模式则取区间，如果是固定模式（从Web UI传来的），min和max其实是一样的，这里直接取 min
  const value = task.schedule_mode === 'interval' ? randomIntInclusive(min, max) : min;
  return addInterval(fromDate, value, unit).toISOString();
}

function rescheduleTask(taskId) {
  const latestTask = listTasks().find(item => item.id === taskId);
  if (latestTask && latestTask.enabled) {
    const nextTime = computeNextRun(latestTask, new Date(), true);
    if (nextTime) updateTask(taskId, { ...latestTask, next_run_at: nextTime });
  }
}

function fireTask(task, runTaskById) {
  const taskId = task.id;
  runTaskSafely(taskId, runTaskById)
    .then((result) => {
      // skipped (race / busy) must not rewrite next_run_at — keep due for later ticks
      if (result?.skipped) return;
      rescheduleTask(taskId);
    })
    .catch((err) => {
      console.error('[scheduler] run error:', err);
      rescheduleTask(taskId);
    });
}

function startMainLoop(runTaskById) {
  stopAllJobs();

  const tick = () => {
    const tasks = listTasks();
    const now = Date.now();
    const allowParallel = db.isTaskParallelAllowed();
    const due = [];

    for (const task of tasks) {
      if (!task.enabled) continue;

      const nextRunAtStr = task.next_run_at;
      if (!nextRunAtStr) {
         // 给新增任务赋初始运行时间
         const nextRunAt = computeNextRun(task);
         if (nextRunAt) {
           updateTask(task.id, { ...task, next_run_at: nextRunAt });
         }
         continue;
      }

      const expectedTime = new Date(nextRunAtStr).getTime();
      if (Number.isNaN(expectedTime)) continue;

      // 时间到了，且本任务未在跑 → 进入 due
      if (now >= expectedTime && !isTaskRunning(task.id)) {
        due.push(task);
      }
    }

    if (!due.length) return;

    if (allowParallel) {
      // 不同任务可同时跑；同任务仍由 runTaskSafely 互斥
      for (const task of due) {
        fireTask(task, runTaskById);
      }
      return;
    }

    // 串行：全局有任务在跑则本 tick 不启动；到期任务保持 next_run_at 等待
    if (isAnyTaskRunning()) return;

    due.sort((a, b) => {
      const ta = new Date(a.next_run_at).getTime();
      const tb = new Date(b.next_run_at).getTime();
      if (ta !== tb) return ta - tb;
      return Number(a.id) - Number(b.id);
    });
    fireTask(due[0], runTaskById);
  };

  // 服务启动时，或重载配置时，立刻做一次全盘扫描，把积压的过期任务扫掉
  tick();

  // 每 10 秒轮询一次，规避原有 setTimeout 的所有副作用
  mainLoopHandle = setInterval(tick, 10000);
}

function reloadJobs(runTaskById) {
  // 补全所有缺失的初始时间
  const tasks = listTasks();
  for (const task of tasks) {
    if (task.enabled && !task.next_run_at) {
       const nextTime = computeNextRun(task);
       if (nextTime) updateTask(task.id, { ...task, next_run_at: nextTime });
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
};
