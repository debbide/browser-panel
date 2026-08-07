const RUNTIME_STACKS = Object.freeze(['playwright', 'seleniumbase', 'ruyipage']);
const PROXY_MODES = Object.freeze(['inherit', 'direct', 'launch', 'ruyi_fpfile', 'script']);

function normalizeRuntimeStack(value, { allowInherit = false } = {}) {
  const stack = String(value || '').trim().toLowerCase();
  if (!stack && allowInherit) return '';
  return RUNTIME_STACKS.includes(stack) ? stack : 'playwright';
}

function normalizeProxyMode(value, { allowInherit = true } = {}) {
  const mode = String(value || '').trim().toLowerCase();
  if (!mode) return allowInherit ? 'inherit' : 'direct';
  return PROXY_MODES.includes(mode) ? mode : (allowInherit ? 'inherit' : 'direct');
}

function proxyLayer(source, fallbackValue = '') {
  if (!source) return null;
  const legacy = String(source.proxy ?? fallbackValue ?? '').trim();
  const modeRaw = String(source.proxy_mode ?? source.proxyMode ?? '').trim();
  const mode = modeRaw ? normalizeProxyMode(modeRaw) : (legacy ? 'launch' : 'inherit');
  const value = String(source.proxy_value ?? source.proxyValue ?? legacy).trim();
  const fpfile = String(source.ruyi_fpfile ?? source.ruyiFpfile ?? '').trim();
  return { mode, value, fpfile };
}

function resolveProxyContract({ task = null, profile = null, global = null, legacyTaskProxy = '' } = {}) {
  const layers = [proxyLayer(task, legacyTaskProxy), proxyLayer(profile), proxyLayer(global)].filter(Boolean);
  let selected = layers.find((layer) => layer.mode !== 'inherit');
  selected ||= { mode: 'direct', value: '', fpfile: '' };

  const launchProxy = selected.mode === 'launch' ? selected.value : '';
  return {
    mode: selected.mode,
    value: selected.value,
    launchProxy,
    scriptProxy: selected.mode === 'script' ? selected.value : launchProxy,
    fpfile: selected.mode === 'ruyi_fpfile' ? (selected.fpfile || selected.value) : '',
  };
}

function assertRuntimeSupportsTask(runtimeStack, taskType) {
  if (normalizeRuntimeStack(runtimeStack) === 'ruyipage' && String(taskType) !== 'python') {
    const error = new Error('RuyiPage runtime only supports Python browser tasks');
    error.code = 'ruyipage_python_only';
    throw error;
  }
}

module.exports = {
  RUNTIME_STACKS,
  PROXY_MODES,
  normalizeRuntimeStack,
  normalizeProxyMode,
  resolveProxyContract,
  assertRuntimeSupportsTask,
};
