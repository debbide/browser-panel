const cron = require('node-cron');
const { listTasks } = require('./db');

const jobs = new Map();
const runningTasks = new Set();

function stopAllJobs() {
  for (const job of jobs.values()) {
    job.stop();
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

function reloadJobs(runTaskById) {
  stopAllJobs();
  const tasks = listTasks();
  for (const task of tasks) {
    if (!task.enabled || !task.cron_expr) continue;
    if (!cron.validate(task.cron_expr)) continue;
    const job = cron.schedule(task.cron_expr, async () => {
      await runTaskSafely(task.id, runTaskById);
    });
    jobs.set(task.id, job);
  }
}

module.exports = {
  reloadJobs,
  stopAllJobs,
  isTaskRunning,
  runTaskSafely,
};
