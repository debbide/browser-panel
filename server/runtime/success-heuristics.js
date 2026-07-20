const db = require('../db');

/** Default patterns for GitHub-style scripts that print success then hang (e.g. SB not exiting). */
const DEFAULT_SUCCESS_PATTERNS = [
  '续期后剩余',
  '续期成功',
  '验证已通过',
  'Cloudflare验证已通过',
  'Cloudflare 验证已通过',
  '任务完成',
  '执行成功',
  'SUCCESS',
  'completed successfully',
  '\\[OK\\]',
  '✅',
];

const DEFAULT_FAILURE_PATTERNS = [
  'Traceback \\(most recent call last\\)',
  '登录失败',
  'FAILED',
  '❌',
  'Exception:',
  'Error: BrowserType',
  'Executable doesn\'t exist',
];

function toBool(value, defaultValue = false) {
  if (value === null || value === undefined || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function splitPatterns(raw) {
  return String(raw || '')
    .split(/[\r\n|]+/g)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 40);
}

function compilePatterns(list) {
  const out = [];
  for (const src of list) {
    try {
      out.push(new RegExp(src, 'i'));
    } catch {
      // treat as literal
      out.push(new RegExp(src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    }
  }
  return out;
}

function getSuccessHeuristicSettings() {
  const enabledRaw = db.getSetting('success_log_soft_enabled');
  const enabled = enabledRaw === null || enabledRaw === undefined || enabledRaw === ''
    ? true
    : toBool(enabledRaw, true);

  const successRaw = db.getSetting('success_log_patterns');
  const failureRaw = db.getSetting('failure_log_patterns');
  const graceRaw = db.getSetting('success_exit_grace_sec');

  const successPatterns = successRaw
    ? splitPatterns(successRaw)
    : DEFAULT_SUCCESS_PATTERNS.slice();
  const failurePatterns = failureRaw
    ? splitPatterns(failureRaw)
    : DEFAULT_FAILURE_PATTERNS.slice();

  let graceSec = Number(graceRaw);
  if (!Number.isFinite(graceSec)) graceSec = 45;
  graceSec = Math.max(0, Math.min(600, Math.floor(graceSec)));

  return {
    enabled,
    successPatterns,
    failurePatterns,
    graceSec,
    successPatternsText: successPatterns.join('\n'),
    failurePatternsText: failurePatterns.join('\n'),
  };
}

function setSuccessHeuristicSettings(payload = {}) {
  if (payload.enabled !== undefined) {
    db.setSetting('success_log_soft_enabled', payload.enabled ? '1' : '0');
  }
  if (payload.successPatternsText !== undefined) {
    const text = String(payload.successPatternsText || '').trim();
    db.setSetting('success_log_patterns', text || null);
  }
  if (payload.failurePatternsText !== undefined) {
    const text = String(payload.failurePatternsText || '').trim();
    db.setSetting('failure_log_patterns', text || null);
  }
  if (payload.graceSec !== undefined) {
    const n = Math.max(0, Math.min(600, Number(payload.graceSec) || 0));
    db.setSetting('success_exit_grace_sec', String(n));
  }
  return getSuccessHeuristicSettings();
}

function resolveHeuristicsForTask(task = null) {
  const global = getSuccessHeuristicSettings();
  const params = {};
  try {
    const map = db.getTaskEnvMap ? db.getTaskEnvMap(task) : {};
    Object.assign(params, map || {});
  } catch {
    // ignore
  }

  // Task-level kill switch
  if (params.SUCCESS_LOG_SOFT !== undefined && params.SUCCESS_LOG_SOFT !== '') {
    if (!toBool(params.SUCCESS_LOG_SOFT, true)) {
      return { ...global, enabled: false };
    }
  }

  let successPatterns = global.successPatterns;
  let failurePatterns = global.failurePatterns;
  let graceSec = global.graceSec;

  if (params.SUCCESS_LOG_REGEX) {
    successPatterns = splitPatterns(params.SUCCESS_LOG_REGEX);
  }
  if (params.FAILURE_LOG_REGEX) {
    failurePatterns = splitPatterns(params.FAILURE_LOG_REGEX);
  }
  if (params.SUCCESS_EXIT_GRACE_SEC !== undefined && params.SUCCESS_EXIT_GRACE_SEC !== '') {
    const n = Number(params.SUCCESS_EXIT_GRACE_SEC);
    if (Number.isFinite(n)) graceSec = Math.max(0, Math.min(600, Math.floor(n)));
  }

  return {
    enabled: global.enabled,
    successPatterns,
    failurePatterns,
    graceSec,
  };
}

function matchAny(text, patterns) {
  if (!text || !patterns || !patterns.length) return null;
  const compiled = compilePatterns(patterns);
  for (let i = 0; i < compiled.length; i += 1) {
    if (compiled[i].test(text)) return patterns[i];
  }
  return null;
}

/**
 * @returns {{ softSuccess: boolean, successHit: string|null, failureHit: string|null }}
 */
function evaluateLogSuccess(combinedLog, task = null) {
  const h = resolveHeuristicsForTask(task);
  if (!h.enabled) {
    return { softSuccess: false, successHit: null, failureHit: null, graceSec: h.graceSec, enabled: false };
  }
  const text = String(combinedLog || '');
  const failureHit = matchAny(text, h.failurePatterns);
  const successHit = matchAny(text, h.successPatterns);
  // Soft success only if success matched and no hard failure marker
  const softSuccess = Boolean(successHit) && !failureHit;
  return {
    softSuccess,
    successHit,
    failureHit,
    graceSec: h.graceSec,
    enabled: true,
  };
}

module.exports = {
  DEFAULT_SUCCESS_PATTERNS,
  DEFAULT_FAILURE_PATTERNS,
  getSuccessHeuristicSettings,
  setSuccessHeuristicSettings,
  resolveHeuristicsForTask,
  evaluateLogSuccess,
};
