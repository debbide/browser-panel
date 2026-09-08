(function exposeTaskScheduleModel(global) {
  function parseTaskSchedule(task) {
    if (!task || !task.enabled) {
      return { enabled: false, mode: 'fixed', fixedDays: 0, fixedHours: 4, fixedMinutes: 0, intervalMin: 5, intervalMax: 10, intervalUnit: 'minutes', dailyTimeStart: '08:00', dailyTimeEnd: '12:00', dailyDayMin: 1, dailyDayMax: 1 };
    }
    if (task.schedule_mode === 'daily_window') {
      return { enabled: true, mode: 'daily_window', fixedDays: 0, fixedHours: 4, fixedMinutes: 0, intervalMin: 5, intervalMax: 10, intervalUnit: 'minutes', dailyTimeStart: task.daily_time_start || '08:00', dailyTimeEnd: task.daily_time_end || '12:00', dailyDayMin: Number(task.daily_day_min || 1), dailyDayMax: Number(task.daily_day_max || task.daily_day_min || 1) };
    }
    if (task.schedule_mode === 'interval') {
      return { enabled: true, mode: 'interval', fixedDays: 0, fixedHours: 4, fixedMinutes: 0, intervalMin: Number(task.interval_min || 5), intervalMax: Number(task.interval_max || 10), intervalUnit: task.interval_unit || 'minutes', dailyTimeStart: '08:00', dailyTimeEnd: '12:00', dailyDayMin: 1, dailyDayMax: 1 };
    }
    let totalMinutes = Number(task.interval_min || task.interval_max || 0);
    if ((task.interval_unit || 'minutes') === 'days') totalMinutes *= 24 * 60;
    else if ((task.interval_unit || 'minutes') === 'hours') totalMinutes *= 60;
    const fixedDays = Math.floor(totalMinutes / (24 * 60));
    totalMinutes -= fixedDays * 24 * 60;
    const fixedHours = Math.floor(totalMinutes / 60);
    totalMinutes -= fixedHours * 60;
    return { enabled: true, mode: 'fixed', fixedDays, fixedHours, fixedMinutes: totalMinutes, intervalMin: 5, intervalMax: 10, intervalUnit: 'minutes', dailyTimeStart: '08:00', dailyTimeEnd: '12:00', dailyDayMin: 1, dailyDayMax: 1 };
  }

  function describeTaskSchedule(task) {
    if (!task.enabled) return '未启用';
    if (task.schedule_mode === 'daily_window') return `每天 ${task.daily_time_start || '00:00'}-${task.daily_time_end || '23:59'} 随机`;
    if (task.schedule_mode === 'interval') return `${task.interval_min} - ${task.interval_max} ${global.prettyUnit(task.interval_unit)}之间`;
    const parsed = parseTaskSchedule(task);
    return `${parsed.fixedDays}天 ${parsed.fixedHours}小时 ${parsed.fixedMinutes}分`;
  }

  function intervalToUnitValue(sec) {
    const seconds = Math.max(0, Number(sec) || 0);
    if (seconds === 0) return { value: 0, unit: 'minutes' };
    if (seconds >= 3600 && seconds % 3600 === 0) return { value: seconds / 3600, unit: 'hours' };
    return { value: Math.max(1, Math.round(seconds / 60)), unit: 'minutes' };
  }

  function unitValueToSec(value, unit, minSec = 0) {
    const normalizedValue = Math.max(0, Number(value) || 0);
    const seconds = unit === 'hours' ? normalizedValue * 3600 : normalizedValue * 60;
    return Math.max(minSec, seconds);
  }

  function buildSchedulePayload(values) {
    if (!values.enabled) {
      return { enabled: false, cron_expr: '', schedule_mode: 'fixed', interval_min: null, interval_max: null, interval_unit: null, daily_time_start: null, daily_time_end: null, daily_day_min: null, daily_day_max: null, next_run_at: null };
    }
    if (values.mode === 'daily_window') {
      const dayMin = Math.max(1, Number(values.dailyDayMin || 1));
      const dayMax = Math.max(dayMin, Number(values.dailyDayMax || dayMin));
      return { enabled: true, cron_expr: '', schedule_mode: 'daily_window', interval_min: null, interval_max: null, interval_unit: null, daily_time_start: values.dailyTimeStart || '08:00', daily_time_end: values.dailyTimeEnd || '12:00', daily_day_min: dayMin, daily_day_max: dayMax, next_run_at: null };
    }
    if (values.mode === 'interval') {
      const min = Math.max(1, Number(values.intervalMin || 1));
      const max = Math.max(min, Number(values.intervalMax || min));
      return { enabled: true, cron_expr: '', schedule_mode: 'interval', interval_min: min, interval_max: max, interval_unit: values.intervalUnit || 'minutes', next_run_at: null };
    }
    const totalMinutes = Math.max(0, Number(values.fixedDays || 0)) * 24 * 60
      + Math.max(0, Number(values.fixedHours || 0)) * 60
      + Math.max(0, Number(values.fixedMinutes || 0));
    const safeMinutes = Math.max(1, totalMinutes);
    const intervalUnit = safeMinutes % (24 * 60) === 0 ? 'days' : (safeMinutes % 60 === 0 ? 'hours' : 'minutes');
    const intervalValue = intervalUnit === 'days' ? safeMinutes / (24 * 60) : (intervalUnit === 'hours' ? safeMinutes / 60 : safeMinutes);
    return { enabled: true, cron_expr: '', schedule_mode: 'fixed', interval_min: intervalValue, interval_max: intervalValue, interval_unit: intervalUnit, next_run_at: null };
  }

  global.TaskScheduleModel = {
    buildSchedulePayload,
    describeTaskSchedule,
    intervalToUnitValue,
    parseTaskSchedule,
    unitValueToSec,
  };
})(window);
