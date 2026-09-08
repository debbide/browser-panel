(function exposeTaskConditionModel(global) {
  const defaultFormValues = Object.freeze({
    enabled: false,
    type: 'http_check',
    checkInterval: 5,
    checkUnit: 'minutes',
    cooldown: 10,
    cooldownUnit: 'minutes',
    url: '',
    proxy: '',
    method: 'GET',
    timeout: 10,
    successStatuses: '200-399',
    expectBody: '',
    windowValue: 30,
    windowUnit: 'minutes',
    jitterMin: 5,
    jitterMax: 10,
    jitterUnit: 'minutes',
    triggerIfExpired: false,
  });

  function getDefaultFormValues() {
    return { ...defaultFormValues };
  }

  function getFormValues(task, intervalToUnitValue) {
    const condition = (task && task.condition) || {};
    const config = condition.config || {};
    const check = intervalToUnitValue(condition.check_interval_sec || 300);
    const cooldown = intervalToUnitValue(condition.cooldown_sec || 600);
    return {
      enabled: Boolean(Number(task && task.condition_enabled)),
      type: condition.type || 'http_check',
      checkInterval: check.value,
      checkUnit: check.unit,
      cooldown: cooldown.value,
      cooldownUnit: cooldown.unit,
      url: config.url || '',
      proxy: config.proxy || '',
      method: config.method || 'GET',
      timeout: Math.round((Number(config.timeout_ms) || 10000) / 1000),
      successStatuses: config.success_statuses || '200-399',
      expectBody: config.expect_body_includes || '',
      windowValue: config.window_value ?? 30,
      windowUnit: config.window_unit || 'minutes',
      jitterMin: config.jitter_min ?? 5,
      jitterMax: config.jitter_max ?? 10,
      jitterUnit: config.jitter_unit || config.window_unit || 'minutes',
      triggerIfExpired: Boolean(config.trigger_if_expired),
    };
  }

  function getFieldsState(enabled, type) {
    const isRemaining = type === 'remaining_callback';
    return {
      fieldsVisible: Boolean(enabled),
      httpVisible: Boolean(enabled) && !isRemaining,
      remainingVisible: Boolean(enabled) && isRemaining,
      showRemainingPreview: Boolean(enabled) && isRemaining,
      hint: !enabled
        ? '启用后选择类型，只显示该类型的配置。'
        : (isRemaining
          ? '当前：剩余时间回调。T=窗口−偏移（窗口内触发，不是窗口外提前）。'
          : '当前：HTTP 检测。配置检测间隔、冷却与 URL。'),
      testLabel: isRemaining ? '测试回调条件' : '测试 HTTP 检测',
    };
  }

  function buildConditionPayload(values, unitValueToSec) {
    if (!values.enabled) return { condition_enabled: false };

    if (values.type === 'remaining_callback') {
      const windowValue = Number(values.windowValue || 30);
      const jitterMin = Number(values.jitterMin || 5);
      const jitterMax = Number(values.jitterMax || 10);
      if (!Number.isFinite(windowValue) || windowValue <= 0) {
        throw new Error('续期窗口必须大于 0');
      }
      if (!Number.isFinite(jitterMin) || jitterMin < 0 || !Number.isFinite(jitterMax) || jitterMax < 0) {
        throw new Error('随机提前区间无效');
      }
      if (jitterMax < jitterMin) {
        throw new Error('随机提前上限不能小于下限');
      }
      return {
        condition_enabled: true,
        condition: {
          type: 'remaining_callback',
          check_interval_sec: 60,
          cooldown_sec: 600,
          config: {
            window_value: windowValue,
            window_unit: values.windowUnit || 'minutes',
            jitter_min: jitterMin,
            jitter_max: jitterMax,
            jitter_unit: values.jitterUnit || 'minutes',
            trigger_if_expired: Boolean(values.triggerIfExpired),
          },
        },
      };
    }

    const url = String(values.url || '').trim();
    if (!url) throw new Error('启用 HTTP 条件时请填写检测 URL');
    return {
      condition_enabled: true,
      condition: {
        type: 'http_check',
        check_interval_sec: unitValueToSec(values.checkInterval || 5, values.checkUnit || 'minutes', 30),
        cooldown_sec: unitValueToSec(values.cooldown || 10, values.cooldownUnit || 'minutes', 0),
        config: {
          url,
          method: values.method || 'GET',
          timeout_ms: Math.min(60000, Math.max(1000, (Number(values.timeout) || 10) * 1000)),
          success_statuses: String(values.successStatuses || '200-399').trim() || '200-399',
          expect_body_includes: String(values.expectBody || '').trim(),
          proxy: String(values.proxy || '').trim(),
        },
      },
    };
  }

  global.TaskConditionModel = {
    buildConditionPayload,
    getDefaultFormValues,
    getFieldsState,
    getFormValues,
  };
})(window);
