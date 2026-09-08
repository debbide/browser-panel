(function exposeTasksModel(global) {
  function resolveTaskType(scriptPath, fallbackType) {
    const normalizedPath = String(scriptPath || '').toLowerCase();
    if (normalizedPath.endsWith('.py')) return 'python';
    if (normalizedPath.endsWith('.php')) return 'php';
    if (normalizedPath.endsWith('.sh')) return 'shell';
    return fallbackType;
  }

  function buildTaskFormSummary({ scriptPath, timeout, scheduleEnabled, scheduleMode, conditionEnabled, temporaryProfile }) {
    const normalizedPath = String(scriptPath || '').trim();
    const scriptLabel = normalizedPath
      ? normalizedPath.split(/[/\\]/).filter(Boolean).pop() || normalizedPath
      : '';
    const normalizedTimeout = String(timeout || '300').trim() || '300';
    const modeLabel = scheduleMode === 'daily_window'
      ? '每天时段'
      : (scheduleMode === 'interval' ? '随机区间' : '固定周期');
    return {
      scriptSummary: normalizedPath
        ? `脚本：${scriptLabel} · 超时 ${normalizedTimeout}s`
        : '脚本：未选择（右侧导入或选中）',
      summary: [
        normalizedPath ? `脚本 ${scriptLabel}` : '未选脚本',
        `超时 ${normalizedTimeout}s`,
        temporaryProfile ? '临时（用完删除）' : '持久配置',
        scheduleEnabled ? `定时·${modeLabel}` : '手动运行',
        conditionEnabled ? '条件触发' : '无条件',
      ].join(' · '),
    };
  }

  function parseParamsJson(raw) {
    if (!raw) return {};
    if (typeof raw === 'object' && !Array.isArray(raw)) return { ...raw };
    try {
      const parsed = JSON.parse(String(raw));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      return {};
    }
    return {};
  }

  function entriesFromParamsObject(params = {}, looksLikeSecretName = () => false) {
    return Object.entries(params || {})
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([name, value]) => ({
        name,
        value: typeof value === 'string' ? value : JSON.stringify(value),
        is_secret: looksLikeSecretName(name) ? 1 : 0,
        has_value: true,
      }));
  }

  function readUseGlobalTelegramFlag(paramsOrEnv) {
    let raw;
    if (Array.isArray(paramsOrEnv)) {
      const entry = paramsOrEnv.find((item) => String(item?.name || '').toUpperCase() === 'USE_GLOBAL_TELEGRAM');
      raw = entry ? entry.value : undefined;
    } else if (paramsOrEnv && typeof paramsOrEnv === 'object') {
      raw = paramsOrEnv.USE_GLOBAL_TELEGRAM ?? paramsOrEnv.use_global_telegram;
    }
    if (raw === undefined || raw === null || String(raw).trim() === '') return true;
    return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
  }

  function isHost2PlayScript(scriptPath) {
    const normalizedPath = String(scriptPath || '').toLowerCase();
    return normalizedPath.includes('host2play_renew_dp') || normalizedPath.includes('host2play');
  }

  function paramsFromEnvRows(rows) {
    const params = {};
    for (const item of rows || []) {
      if (!item.name) continue;
      params[item.name] = item.value;
    }
    return params;
  }

  function mergeHost2PlayTemplate(rows) {
    const byName = new Map((rows || []).map((entry) => [entry.name, { ...entry }]));
    const defaults = [
      { name: 'RENEW_URLS', value: '', is_secret: 0, has_value: false },
      { name: 'VISION_CALL_BUDGET', value: '200', is_secret: 0, has_value: true },
      { name: 'MAX_RETRIES', value: '8', is_secret: 0, has_value: true },
      { name: 'MAX_RENEW_RETRIES_PER_URL', value: '8', is_secret: 0, has_value: true },
      { name: 'VISION_DEBUG', value: '0', is_secret: 0, has_value: true },
    ];
    for (const item of defaults) {
      if (!byName.has(item.name)) byName.set(item.name, item);
    }
    return [...byName.values()];
  }

  global.TasksModel = {
    buildTaskFormSummary,
    entriesFromParamsObject,
    isHost2PlayScript,
    mergeHost2PlayTemplate,
    paramsFromEnvRows,
    parseParamsJson,
    readUseGlobalTelegramFlag,
    resolveTaskType,
  };
})(window);
