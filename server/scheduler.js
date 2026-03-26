const { listTasks, updateTask } = require('./db');

const jobs = new Map();
const runningTasks = new Set();

function stopAllJobs() {
  for (const job of jobs.values()) {
    clearTimeout(job.handle);
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
  if (unit === 'days') next.setUTCDate(next.getUTCDate() + value);
  else if (unit === 'minutes') next.setUTCMinutes(next.getUTCMinutes() + value);
  else next.setUTCHours(next.getUTCHours() + value);
  return next;
}

function computeNextRun(task, fromDate = new Date()) {
  const min = Number(task.interval_min || 0);
  const max = Number(task.interval_max || 0);
  const unit = task.interval_unit || 'hours';
  if (!min || !max) return null;
  const value = task.schedule_mode === 'interval' ? randomIntInclusive(min, max) : min;
  return addInterval(fromDate, value, unit).toISOString();
}

function scheduleTask(task, runTaskById) {
  if (!task.enabled) return;
  const nextRunAt = task.next_run_at || computeNextRun(task);
  if (!nextRunAt) return;

  if (!task.next_run_at) {
    updateTask(task.id, { ...task, next_run_at: nextRunAt });
  }

  const delayMs = Math.max(0, new Date(nextRunAt).getTime() - Date.now());
  const handle = setTimeout(async () => {
    const latestTask = listTasks().find(item => item.id === task.id);
    if (!latestTask || !latestTask.enabled) return;

    await runTaskSafely(task.id, runTaskById);

    const nextScheduledAt = computeNextRun(latestTask, new Date());
    const updated = updateTask(task.id, {
      ...latestTask,
      next_run_at: nextScheduledAt,
    });
    scheduleTask(updated, runTaskById);
  }, delayMs);

  jobs.set(task.id, { kind: 'timeout', handle });
}

function reloadJobs(runTaskById) {
  stopAllJobs();
  const tasks = listTasks();
  for (const task of tasks) {
    if (!task.enabled) continue;
    scheduleTask(task, runTaskById);
  }
}

module.exports = {
  reloadJobs,
  stopAllJobs,
  isTaskRunning,
  runTaskSafely,
};
