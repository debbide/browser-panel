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
               const nextTime = computeNextRun(latestTask, new Date(), true);
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
