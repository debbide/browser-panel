'use strict';

const { normalizeTaskType, isPureRequestTaskType, resolveTaskScriptPath } = require('./task-payload');

function parseUsePersistentFlag(value, defaultValue = 0) {
  if (value === undefined || value === null || value === '') return defaultValue ? 1 : 0;
  if (value === true || value === 1 || value === '1') return 1;
  return ['true', 'yes', 'on'].includes(String(value).trim().toLowerCase()) ? 1 : 0;
}

function createTaskService(dependencies) {
  const {
    db,
    normalizeTaskEnvPayload,
    applyTaskEnvPayload,
    decorateTaskForApi,
    buildConditionFieldsFromPayload,
    resolveTaskGroupId,
    normalizeExtraPathsPayload,
    reloadJobs,
    executeTask,
    isTaskRunning,
    emit,
  } = dependencies;

  function buildPayload(payload, existing = null) {
    normalizeTaskEnvPayload(payload);
    const type = normalizeTaskType(payload.type);
    const name = String(payload.name || 'Untitled Task');
    const requestedScriptPath = String(payload.script_path || existing?.script_path || '');
    return {
      name,
      type,
      script_path: resolveTaskScriptPath(name, type, requestedScriptPath),
      cron_expr: String(payload.cron_expr || ''),
      schedule_mode: payload.schedule_mode === 'daily_window' ? 'daily_window' : (payload.schedule_mode === 'interval' ? 'interval' : 'fixed'),
      interval_min: payload.interval_min ? Number(payload.interval_min) : null,
      interval_max: payload.interval_max ? Number(payload.interval_max) : null,
      interval_unit: payload.interval_unit ? String(payload.interval_unit) : null,
      daily_time_start: payload.daily_time_start ? String(payload.daily_time_start) : null,
      daily_time_end: payload.daily_time_end ? String(payload.daily_time_end) : null,
      daily_day_min: payload.daily_day_min ? Number(payload.daily_day_min) : null,
      daily_day_max: payload.daily_day_max ? Number(payload.daily_day_max) : null,
      next_run_at: payload.next_run_at ? String(payload.next_run_at) : existing?.next_run_at || null,
      enabled: payload.enabled ? 1 : 0,
      use_browser: isPureRequestTaskType(type) ? 0 : (payload.use_browser === false ? 0 : 1),
      use_persistent: parseUsePersistentFlag(payload.use_persistent, Number(existing?.use_persistent) ? 1 : 0),
      timeout_sec: Number(payload.timeout_sec || 300),
      params_json: existing?.params_json || '{}',
      browser_profile_id: payload.browser_profile_id ? Number(payload.browser_profile_id) : null,
      group_id: Object.prototype.hasOwnProperty.call(payload, 'group_id') ? resolveTaskGroupId(payload.group_id) : existing?.group_id ?? null,
      extra_paths: Object.prototype.hasOwnProperty.call(payload, 'extra_paths') ? (normalizeExtraPathsPayload(payload.extra_paths) || '[]') : existing?.extra_paths || '[]',
      callback_remaining_sec: existing?.callback_remaining_sec ?? null,
      callback_reported_at: existing?.callback_reported_at || null,
      callback_trigger_at: existing?.callback_trigger_at || null,
      callback_threshold_sec: existing?.callback_threshold_sec ?? null,
      callback_valid_until: existing?.callback_valid_until || null,
      callback_action: existing?.callback_action || null,
      ...buildConditionFieldsFromPayload(payload, existing),
    };
  }

  function list() {
    const latestByTask = new Map(db.listLatestRunPerTask().map((run) => [run.task_id, run]));
    return db.listTasks().map((task) => ({
      ...decorateTaskForApi(task),
      is_running: isTaskRunning(task.id),
      latest_run: latestByTask.get(task.id) || null,
    }));
  }

  function create(payload = {}) {
    let task = db.createTask(buildPayload(payload));
    task = applyTaskEnvPayload(task.id, payload) || task;
    reloadJobs(executeTask);
    return decorateTaskForApi(task);
  }

  function update(id, payload = {}) {
    const existing = db.getTask(id);
    if (!existing) return null;
    let task = db.updateTask(id, buildPayload(payload, existing));
    if (payload.env !== undefined || payload.params !== undefined || payload.params_json !== undefined) {
      task = applyTaskEnvPayload(id, payload) || task;
    }
    reloadJobs(executeTask);
    return decorateTaskForApi(task);
  }

  function remove(id) {
    const result = db.deleteTask(id);
    if (!result.changes) return false;
    reloadJobs(executeTask);
    if (emit) emit('tasks', { action: 'deleted', task_id: id });
    return true;
  }

  return { list, create, update, remove };
}

module.exports = { createTaskService, parseUsePersistentFlag };
