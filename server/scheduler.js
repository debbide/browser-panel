const { listTasks, updateTask } = require('./db');

const runningTasks = new Set();
let mainLoopHandle = null;

function stopAllJobs() {
  if (mainLoopHandle) {
    clearInterval(mainLoopHandle);
    mainLoopHandle = null;
  }
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
  
  // 如果是随机模式则取区间，如果是固定模式（从Web UI传来的），min和max其实是一样的，这里直接取 min
  const value = task.schedule_mode === 'interval' ? randomIntInclusive(min, max) : min;
  return addInterval(fromDate, value, unit).toISOString();
}

function startMainLoop(runTaskById) {
  stopAllJobs();
  
  const tick = () => {
    const tasks = listTasks();
    const now = Date.now();

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
      
      // 时间到了，跑起来！
      if (now >= expectedTime) {
         if (!isTaskRunning(task.id)) {
           // 异步运行，以免阻塞其他任务检查
           runTaskSafely(task.id, runTaskById).catch(err => console.error('[scheduler] run error:', err)).finally(() => {
             // 运行结束后，再次排期
             const latestTask = listTasks().find(item => item.id === task.id);
             if (latestTask && latestTask.enabled) {
               const nextTime = computeNextRun(latestTask, new Date());
               if (nextTime) updateTask(task.id, { ...latestTask, next_run_at: nextTime });
             }
           });
         }
      }
    }
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
  runTaskSafely,
};
