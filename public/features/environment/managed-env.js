(function exposeManagedEnvironment(global) {
  const PROXY_ENV_ALIAS_KEYS = [
    'PROXY',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
  ];

  const MANAGED_TASK_ENV_KEYS = new Set([
    'USE_GLOBAL_TELEGRAM',
    'USE_TEMP_PROFILE',
    'BROWSER_PROXY',
    'BROWSER_RUNTIME_STACK',
    'BROWSER_PROXY_MODE',
    'BROWSER_PROXY_VALUE',
    'BROWSER_RUYI_FPFILE',
    ...PROXY_ENV_ALIAS_KEYS,
    'BROWSER_LOCALE',
    'BROWSER_TIMEZONE',
  ]);
  const PROFILE_MANAGED_ENV_KEYS = new Set(['BROWSER_LOCALE', 'BROWSER_TIMEZONE']);

  function isManagedEnvKey(name, keys = MANAGED_TASK_ENV_KEYS) {
    return keys.has(String(name || '').trim().toUpperCase());
  }

  function filterManagedEnvRows(rows, keys = MANAGED_TASK_ENV_KEYS) {
    return (Array.isArray(rows) ? rows : []).filter((entry) => !isManagedEnvKey(entry?.name, keys));
  }

  function filterManagedEnvObject(source, keys = MANAGED_TASK_ENV_KEYS) {
    const out = {};
    for (const [name, value] of Object.entries(source || {})) {
      if (!isManagedEnvKey(name, keys)) out[name] = value;
    }
    return out;
  }

  function findManagedEnvValue(rows, name) {
    const target = String(name || '').toUpperCase();
    const hit = (Array.isArray(rows) ? rows : []).find(
      (entry) => String(entry?.name || '').trim().toUpperCase() === target
    );
    return hit ? String(hit.value || '').trim() : '';
  }

  function findManagedParamValue(params, name) {
    const target = String(name || '').toUpperCase();
    for (const [key, value] of Object.entries(params || {})) {
      if (String(key || '').trim().toUpperCase() === target) return String(value || '').trim();
    }
    return '';
  }

  function deleteManagedMapKeys(map, names) {
    const targets = new Set(names.map((name) => String(name).toUpperCase()));
    for (const key of [...map.keys()]) {
      if (targets.has(String(key || '').toUpperCase())) map.delete(key);
    }
  }

  function deleteManagedObjectKeys(object, names) {
    const targets = new Set(names.map((name) => String(name).toUpperCase()));
    for (const key of Object.keys(object || {})) {
      if (targets.has(String(key || '').toUpperCase())) delete object[key];
    }
  }

  global.ManagedEnvironment = {
    PROXY_ENV_ALIAS_KEYS,
    MANAGED_TASK_ENV_KEYS,
    PROFILE_MANAGED_ENV_KEYS,
    isManagedEnvKey,
    filterManagedEnvRows,
    filterManagedEnvObject,
    findManagedEnvValue,
    findManagedParamValue,
    deleteManagedMapKeys,
    deleteManagedObjectKeys,
  };
})(window);
