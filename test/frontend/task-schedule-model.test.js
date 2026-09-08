const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { read } = require('./helpers');

function loadModel() {
  const window = {
    prettyUnit(unit) {
      return ({ minutes: '分钟', hours: '小时', days: '天' })[unit] || unit;
    },
  };
  const context = vm.createContext({ window });
  vm.runInContext(read('public/features/tasks/schedule-model.js'), context);
  return context.window.TaskScheduleModel;
}

test('task schedule model exposes parsing and conversion boundaries', () => {
  const model = loadModel();
  assert.equal(typeof model.parseTaskSchedule, 'function');
  assert.equal(typeof model.buildSchedulePayload, 'function');
  assert.equal(typeof model.describeTaskSchedule, 'function');
  assert.equal(typeof model.intervalToUnitValue, 'function');
  assert.equal(typeof model.unitValueToSec, 'function');
});

test('task schedule model owns schedule payload construction', () => {
  const model = loadModel();
  assert.deepEqual(JSON.parse(JSON.stringify(model.buildSchedulePayload({ enabled: true, mode: 'fixed', fixedHours: 2 }))), { enabled: true, cron_expr: '', schedule_mode: 'fixed', interval_min: 2, interval_max: 2, interval_unit: 'hours', next_run_at: null });
  assert.deepEqual(JSON.parse(JSON.stringify(model.buildSchedulePayload({ enabled: true, mode: 'interval', intervalMin: 5, intervalMax: 3, intervalUnit: 'minutes' }))), { enabled: true, cron_expr: '', schedule_mode: 'interval', interval_min: 5, interval_max: 5, interval_unit: 'minutes', next_run_at: null });
  assert.deepEqual(JSON.parse(JSON.stringify(model.buildSchedulePayload({ enabled: true, mode: 'daily_window', dailyTimeStart: '09:00', dailyTimeEnd: '11:00', dailyDayMin: 2, dailyDayMax: 1 }))), { enabled: true, cron_expr: '', schedule_mode: 'daily_window', interval_min: null, interval_max: null, interval_unit: null, daily_time_start: '09:00', daily_time_end: '11:00', daily_day_min: 2, daily_day_max: 2, next_run_at: null });
});

test('panel runtime delegates schedule payload construction to the model', () => {
  const runtime = read('public/panel-runtime.js');
  assert.match(runtime, /TaskScheduleModel\.buildSchedulePayload/);
  assert.equal((runtime.match(/schedule_mode: 'daily_window'/g) || []).length, 0);
});

test('task schedule model preserves schedule parsing and descriptions', () => {
  const model = loadModel();
  assert.deepEqual(
    JSON.parse(JSON.stringify(model.parseTaskSchedule({ enabled: true, interval_min: 90, interval_unit: 'minutes' }))),
    { enabled: true, mode: 'fixed', fixedDays: 0, fixedHours: 1, fixedMinutes: 30, intervalMin: 5, intervalMax: 10, intervalUnit: 'minutes', dailyTimeStart: '08:00', dailyTimeEnd: '12:00', dailyDayMin: 1, dailyDayMax: 1 },
  );
  assert.equal(model.describeTaskSchedule({ enabled: true, schedule_mode: 'interval', interval_min: 5, interval_max: 10, interval_unit: 'minutes' }), '5 - 10 分钟之间');
  assert.equal(model.describeTaskSchedule({ enabled: true, schedule_mode: 'daily_window', daily_time_start: '09:00', daily_time_end: '11:00' }), '每天 09:00-11:00 随机');
});

test('task schedule model preserves interval conversions', () => {
  const model = loadModel();
  assert.deepEqual(JSON.parse(JSON.stringify(model.intervalToUnitValue(7200))), { value: 2, unit: 'hours' });
  assert.equal(model.unitValueToSec(5, 'minutes', 30), 300);
  assert.equal(model.unitValueToSec(0, 'minutes', 30), 30);
});

test('production page loads task schedule model before panel runtime', () => {
  const html = read('public/index.html');
  const scheduleModel = html.indexOf('/features/tasks/schedule-model.js?v=20260908a');
  const runtime = html.indexOf('/panel-runtime.js?v=20260907a');
  assert.ok(scheduleModel >= 0);
  assert.ok(runtime > scheduleModel);
});
