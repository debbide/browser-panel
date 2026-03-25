const cron = require('node-cron');
const { listTasks } = require('./db');

const jobs = new Map();

function stopAllJobs() {
  for (const job of jobs.values()) {
    job.stop();
  }
  jobs.clear();
}

function reloadJobs(runTaskById) {
  stopAllJobs();
  const tasks = listTasks();
  for (const task of tasks) {
    if (!task.enabled || !task.cron_expr) continue;
    if (!cron.validate(task.cron_expr)) continue;
    const job = cron.schedule(task.cron_expr, async () => {
      await runTaskById(task.id);
    });
    jobs.set(task.id, job);
  }
}

module.exports = {
  reloadJobs,
  stopAllJobs,
};
