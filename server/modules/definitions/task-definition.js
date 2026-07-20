function normalizeExecutionMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return mode === 'modular' ? 'modular' : 'legacy';
}

function normalizeScriptEngine(value, fallback = 'playwright') {
  const engine = String(value || fallback || '').trim().toLowerCase();
  if (engine === 'seleniumbase') return 'seleniumbase';
  return 'playwright';
}

function normalizeScriptTypeByEngine(engine) {
  return engine === 'seleniumbase' ? 'python' : 'javascript';
}

function normalizeSiteAdapter(value) {
  const adapter = String(value || '').trim().toLowerCase();
  return adapter || 'default';
}

function toOptionalText(value, maxLen = 400) {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  return text.slice(0, maxLen);
}

function normalizePositiveInt(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const asInt = Math.floor(num);
  return asInt > 0 ? asInt : fallback;
}

const SUPPORTED_ACTIONS = new Set([
  'open',
  'wait',
  'click',
  'type',
  'extract',
  'screenshot',
  'check',
]);

function normalizeStep(step) {
  const action = String(step?.action || '').trim().toLowerCase();
  if (!SUPPORTED_ACTIONS.has(action)) {
    throw new Error(`Unsupported modular action: ${action || '(empty)'}`);
  }

  const out = { action };
  const selector = toOptionalText(step?.selector || step?.target);
  const url = toOptionalText(step?.url);
  const value = toOptionalText(step?.value, 2000);
  const valueFrom = toOptionalText(step?.valueFrom, 120);
  const name = toOptionalText(step?.name, 120);
  const state = toOptionalText(step?.state, 50);
  const waitUntil = toOptionalText(step?.waitUntil, 50);
  const message = toOptionalText(step?.message, 240);
  const path = toOptionalText(step?.path, 240);

  if (selector) out.selector = selector;
  if (url) out.url = url;
  if (value !== undefined) out.value = value;
  if (valueFrom) out.valueFrom = valueFrom;
  if (name) out.name = name;
  if (state) out.state = state;
  if (waitUntil) out.waitUntil = waitUntil;
  if (message) out.message = message;
  if (path) out.path = path;

  const timeoutMs = normalizePositiveInt(step?.timeoutMs, undefined);
  if (timeoutMs) out.timeoutMs = Math.min(timeoutMs, 180000);

  if (step?.fullPage !== undefined) out.fullPage = Boolean(step.fullPage);

  return out;
}

function parseStepsInput(rawValue) {
  if (rawValue === undefined) return undefined;
  if (rawValue === null || rawValue === '') return [];
  if (Array.isArray(rawValue)) return rawValue;
  if (typeof rawValue === 'object' && Array.isArray(rawValue.steps)) return rawValue.steps;
  if (typeof rawValue === 'string') {
    const text = rawValue.trim();
    if (!text) return [];
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('modular_steps_json must be valid JSON');
    }
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.steps)) return parsed.steps;
    throw new Error('modular_steps_json must be a JSON array');
  }
  throw new Error('modular_steps_json format is invalid');
}

function normalizeModularStepsJson(value, fallbackValue = '') {
  const parsed = parseStepsInput(value);
  if (parsed === undefined) return String(fallbackValue || '');
  const normalized = parsed
    .map(step => normalizeStep(step))
    .slice(0, 60);
  if (!normalized.length) return '';
  return JSON.stringify(normalized);
}

function normalizeTaskExecutionPayload(payload = {}, fallback = {}) {
  const scriptEngine = normalizeScriptEngine(
    payload.script_engine !== undefined
      ? payload.script_engine
      : fallback.script_engine
  );
  return {
    script_engine: scriptEngine,
    type: normalizeScriptTypeByEngine(scriptEngine),
    execution_mode: normalizeExecutionMode(
      payload.execution_mode !== undefined
        ? payload.execution_mode
        : fallback.execution_mode
    ),
    site_adapter: normalizeSiteAdapter(
      payload.site_adapter !== undefined
        ? payload.site_adapter
        : fallback.site_adapter
    ),
    modular_steps_json: normalizeModularStepsJson(
      payload.modular_steps_json !== undefined
        ? payload.modular_steps_json
        : (payload.modular_steps !== undefined ? payload.modular_steps : undefined),
      fallback.modular_steps_json
    ),
  };
}

module.exports = {
  normalizeExecutionMode,
  normalizeScriptEngine,
  normalizeScriptTypeByEngine,
  normalizeSiteAdapter,
  normalizeModularStepsJson,
  normalizeTaskExecutionPayload,
};
