const { hasUsableSelectorCandidate } = require('./selector-utils');

const STEP_CATALOG = Object.freeze({
  goto: {
    label: 'Navigate URL',
    requiredFields: ['url'],
    targets: { playwright: true, seleniumbase: true },
  },
  click: {
    label: 'Click Element',
    requiredFields: ['selector'],
    targets: { playwright: true, seleniumbase: true },
  },
  input: {
    label: 'Input Text',
    requiredFields: ['selector', 'value'],
    targets: { playwright: true, seleniumbase: true },
  },
  wait: {
    label: 'Wait Time',
    requiredFields: ['ms'],
    targets: { playwright: true, seleniumbase: true },
  },
  scroll: {
    label: 'Scroll Window',
    requiredFields: ['x', 'y'],
    targets: { playwright: true, seleniumbase: true },
  },
  hover: {
    label: 'Hover Element',
    requiredFields: ['selector'],
    targets: { playwright: true, seleniumbase: true },
  },
  press: {
    label: 'Press Key',
    requiredFields: ['selector', 'key'],
    targets: { playwright: true, seleniumbase: true },
  },
  select: {
    label: 'Select Option',
    requiredFields: ['selector', 'value'],
    targets: { playwright: true, seleniumbase: true },
  },
  check: {
    label: 'Check Input',
    requiredFields: ['selector'],
    targets: { playwright: true, seleniumbase: true },
  },
  uncheck: {
    label: 'Uncheck Input',
    requiredFields: ['selector'],
    targets: { playwright: true, seleniumbase: true },
  },
  assert_url_contains: {
    label: 'Assert URL Contains',
    requiredFields: ['value'],
    targets: { playwright: true, seleniumbase: true },
  },
  assert_text: {
    label: 'Assert Text',
    requiredFields: ['selector', 'value'],
    targets: { playwright: true, seleniumbase: true },
  },
  screenshot: {
    label: 'Take Screenshot',
    requiredFields: ['name'],
    targets: { playwright: true, seleniumbase: true },
  },
});

function listStepTypes() {
  return Object.keys(STEP_CATALOG);
}

function getStepMeta(stepType) {
  return STEP_CATALOG[String(stepType || '').trim()] || null;
}

function isStepSupported(stepType, target) {
  const meta = getStepMeta(stepType);
  if (!meta) return false;
  return Boolean(meta.targets && meta.targets[target]);
}

function findMissingFields(step) {
  const meta = getStepMeta(step?.type);
  if (!meta) return [];
  const stepType = String(step?.type || '').trim();
  const hasSelector = hasUsableSelectorCandidate(step?.selector);
  if (String(step?.type || '').trim() === 'wait') {
    const strategy = String(step?.wait_for || 'timeout').trim() || 'timeout';
    if (strategy === 'timeout') {
      const ms = Number(step?.ms);
      return Number.isFinite(ms) ? [] : ['ms'];
    }
    if (strategy === 'selector') {
      const missing = [];
      if (!hasSelector) missing.push('selector');
      const timeoutMs = Number(step?.timeout_ms);
      if (!Number.isFinite(timeoutMs)) missing.push('timeout_ms');
      return missing;
    }
    if (strategy === 'url_change' || strategy === 'ready_state') {
      const timeoutMs = Number(step?.timeout_ms);
      return Number.isFinite(timeoutMs) ? [] : ['timeout_ms'];
    }
    return [];
  }
  const missing = [];
  for (const key of meta.requiredFields || []) {
    if (key === 'selector') {
      const isTurnstileTokenAssert = stepType === 'assert_text'
        && String(step?.value || '') === '__turnstile_token_ready__';
      if (!isTurnstileTokenAssert && !hasSelector) {
        missing.push('selector');
      }
      continue;
    }
    const value = step?.[key];
    const empty = value === undefined || value === null
      || (typeof value === 'string' && !value.trim());
    if (empty) missing.push(key);
  }
  return missing;
}

function analyzeIrSupport(ir, target) {
  const steps = Array.isArray(ir?.steps) ? ir.steps : [];
  const unsupported = [];
  const invalid = [];
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i] || {};
    if (step?.enabled === false) {
      continue;
    }
    if (!isStepSupported(step.type, target)) {
      unsupported.push({
        index: i,
        id: step.id || '',
        type: step.type || 'unknown',
      });
      continue;
    }
    const missingFields = findMissingFields(step);
    if (missingFields.length) {
      invalid.push({
        index: i,
        id: step.id || '',
        type: step.type || 'unknown',
        missingFields,
      });
    }
  }
  return { unsupported, invalid };
}

module.exports = {
  STEP_CATALOG,
  listStepTypes,
  getStepMeta,
  isStepSupported,
  findMissingFields,
  analyzeIrSupport,
};
