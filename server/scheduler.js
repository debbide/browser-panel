const cron = require('node-cron');
const { listTasks, updateTask } = require('./db');

const jobs = new Map();
const runningTasks = new Set();

function stopAllJobs() {
  for (const job of jobs.values()) {
    if (job.kind === 'cron') job.handle.stop();
    if (job.kind === 'timeout') clearTimeout(job.handle);
  }
  jobs.clear();
}

function isTaskRunning(taskId) {
  return runningTasks.has(taskId);
}

async function runTaskSafely(taskId, runTaskById) {
  if (runningTasks.has(taskId)) {
    return { skipped: true, reason: 'already_running' };
  }
  runningTasks.add(taskId);
  try {
    return await runTaskById(taskId);
  } finally {
    runningTasks.delete(taskId);
  }
}

function randomIntInclusive(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function addInterval(date, value, unit) {
  const next = new Date(date.getTime());
  if (unit === 'days') {
    next.setUTCDate(next.getUTCDate() + value);
  } else {
    next.setUTCHours(next.getUTCHours() + value);
  }
  return next;
}

function scheduleNextIntervalRun(task, runTaskById) {
  if (!task.enabled || task.schedule_mode !== 'interval') return;
  const min = Number(task.interval_min || 0);
  const max = Number(task.interval_max || 0);
  const unit = task.interval_unit || 'hours';
  if (!min || !max) return;

  const nextRunAt = task.next_run_at ? new Date(task.next_run_at) : addInterval(new Date(), randomIntInclusive(min, max), unit);
  const delayMs = Math.max(0, nextRunAt.getTime() - Date.now());

  const handle = setTimeout(async () => {
    const latestTasks = listTasks();
    const latestTask = latestTasks.find(item => item.id === task.id);
    if (!latestTask || !latestTask.enabled) return;

    await runTaskSafely(task.id, runTaskById);

    const nextScheduledAt = addInterval(new Date(), randomIntInclusive(min, max), unit).toISOString();
    updateTask(task.id, {
      ...latestTask,
      next_run_at: nextScheduledAt,
    });
    scheduleNextIntervalRun({ ...latestTask, next_run_at: nextScheduledAt }, runTaskById);
  }, delayMs);

  jobs.set(task.id, { kind: 'timeout', handle });
}

function reloadJobs(runTaskById) {
  stopAllJobs();
  const tasks = listTasks();
  for (const task of tasks) {
    if (!task.enabled) continue;
    if (task.schedule_mode === 'interval') {
      let nextRunAt = task.next_run_at;
      if (!nextRunAt) {
        const min = Number(task.interval_min || 0);
        const max = Number(task.interval_max || 0);
        const unit = task.interval_unit || 'hours';
        if (min && max) {
          nextRunAt = addInterval(new Date(), randomIntInclusive(min, max), unit).toISOString();
          updateTask(task.id, { ...task, next_run_at: nextRunAt });
          scheduleNextIntervalRun({ ...task, next_run_at: nextRunAt }, runTaskById);
        }
      } else {
        scheduleNextIntervalRun(task, runTaskById);
      }
      continue;
    }

    if (!task.cron_expr) continue;
    if (!cron.validate(task.cron_expr)) continue;
    const handle = cron.schedule(task.cron_expr, async () => {
      await runTaskSafely(task.id, runTaskById);
    });
    jobs.set(task.id, { kind: 'cron', handle });
  }
}

module.exports = {
  reloadJobs,
  stopAllJobs,
  isTaskRunning,
  runTaskSafely,
};
