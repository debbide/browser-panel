const httpCheck = require('./types/http_check');

// Pluggable condition types. future: task_dependency, file_exists, ...
const registry = new Map();

function register(typeModule) {
  if (!typeModule || !typeModule.type || typeof typeModule.evaluate !== 'function') {
    throw new Error('Invalid condition type module');
  }
  registry.set(typeModule.type, typeModule);
}

register(httpCheck);

function listTypes() {
  return Array.from(registry.values()).map((mod) => ({
    type: mod.type,
    label: mod.label || mod.type,
  }));
}

function getType(type) {
  return registry.get(String(type || '').trim()) || null;
}

function parseConditionJson(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Normalize condition payload from API/UI.
 * @returns {{ type: string, check_interval_sec: number, cooldown_sec: number, config: object }}
 */
function normalizeConditionPayload(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const type = String(src.type || 'http_check').trim() || 'http_check';
  const mod = getType(type);
  if (!mod) throw new Error(`未知条件类型: ${type}`);

  const check_interval_sec = Math.max(30, Number(src.check_interval_sec) || 300);
  const cooldown_sec = Math.max(0, Number(src.cooldown_sec) || 600);
  const config = typeof mod.normalizeConfig === 'function'
    ? mod.normalizeConfig(src.config || src)
    : (src.config || {});

  return {
    type,
    check_interval_sec,
    cooldown_sec,
    config,
  };
}

function conditionFromTask(task) {
  return parseConditionJson(task && task.condition_json);
}

/**
 * Evaluate a task's condition.
 * @returns {Promise<{ok:boolean, shouldTrigger:boolean, status:string, detail:string, meta?:object, type:string}>}
 */
async function evaluateTaskCondition(task) {
  const cond = conditionFromTask(task);
  const type = String(cond.type || 'http_check').trim() || 'http_check';
  const mod = getType(type);
  if (!mod) {
    return {
      ok: false,
      shouldTrigger: false,
      status: 'error',
      detail: `未知条件类型: ${type}`,
      type,
    };
  }
  const result = await mod.evaluate(cond.config || {}, { task });
  return {
    ok: Boolean(result && result.ok),
    shouldTrigger: Boolean(result && result.shouldTrigger),
    status: (result && result.status) || (result && result.ok ? 'ok' : 'fail'),
    detail: (result && result.detail) || '',
    meta: result && result.meta,
    type,
  };
}

module.exports = {
  register,
  listTypes,
  getType,
  parseConditionJson,
  normalizeConditionPayload,
  conditionFromTask,
  evaluateTaskCondition,
};
