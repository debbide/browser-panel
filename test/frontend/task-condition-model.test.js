const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { read } = require('./helpers');

function loadModel() {
  const context = vm.createContext({ window: {} });
  vm.runInContext(read('public/features/tasks/condition-model.js'), context);
  return context.window.TaskConditionModel;
}

const unitValueToSec = (value, unit, minimum) => Math.max(Number(value) * (unit === 'hours' ? 3600 : 60), minimum);

test('condition model returns the disabled payload without configuration', () => {
  const payload = loadModel().buildConditionPayload({ enabled: false }, unitValueToSec);
  assert.equal(payload.condition_enabled, false);
  assert.equal(Object.keys(payload).length, 1);
});

test('condition model normalizes HTTP condition values', () => {
  const payload = loadModel().buildConditionPayload({
    enabled: true,
    type: 'http_check',
    checkInterval: 2,
    checkUnit: 'minutes',
    cooldown: 1,
    cooldownUnit: 'hours',
    url: ' https://example.test/status ',
    timeout: 90,
    successStatuses: ' 200-299 ',
  }, unitValueToSec);
  assert.equal(payload.condition.check_interval_sec, 120);
  assert.equal(payload.condition.cooldown_sec, 3600);
  assert.equal(payload.condition.config.url, 'https://example.test/status');
  assert.equal(payload.condition.config.timeout_ms, 60000);
  assert.equal(payload.condition.config.success_statuses, '200-299');
});

test('condition model requires an HTTP URL', () => {
  assert.throws(
    () => loadModel().buildConditionPayload({ enabled: true, type: 'http_check' }, unitValueToSec),
    /请填写检测 URL/,
  );
});

test('condition model preserves callback defaults and validates jitter range', () => {
  const model = loadModel();
  const payload = model.buildConditionPayload({ enabled: true, type: 'remaining_callback' }, unitValueToSec);
  assert.equal(payload.condition.check_interval_sec, 60);
  assert.equal(payload.condition.cooldown_sec, 600);
  assert.equal(payload.condition.config.window_value, 30);
  assert.equal(payload.condition.config.jitter_min, 5);
  assert.equal(payload.condition.config.jitter_max, 10);
  assert.throws(
    () => model.buildConditionPayload({ enabled: true, type: 'remaining_callback', jitterMin: 10, jitterMax: 5 }, unitValueToSec),
    /上限不能小于下限/,
  );
});

test('condition model exposes fresh default form values', () => {
  const model = loadModel();
  const first = model.getDefaultFormValues();
  first.url = 'changed';
  const second = model.getDefaultFormValues();
  assert.equal(second.enabled, false);
  assert.equal(second.type, 'http_check');
  assert.equal(second.url, '');
  assert.equal(second.windowValue, 30);
});

test('condition model maps persisted configuration to form values', () => {
  const values = loadModel().getFormValues({
    condition_enabled: 1,
    condition: {
      type: 'remaining_callback',
      check_interval_sec: 7200,
      cooldown_sec: 1800,
      config: {
        window_value: 45,
        window_unit: 'minutes',
        jitter_min: 2,
        jitter_max: 8,
        trigger_if_expired: true,
      },
    },
  }, seconds => ({ value: seconds / 60, unit: 'minutes' }));
  assert.equal(values.enabled, true);
  assert.equal(values.type, 'remaining_callback');
  assert.equal(values.checkInterval, 120);
  assert.equal(values.cooldown, 30);
  assert.equal(values.windowValue, 45);
  assert.equal(values.jitterUnit, 'minutes');
  assert.equal(values.triggerIfExpired, true);
});

test('condition model derives HTTP and callback field visibility', () => {
  const model = loadModel();
  const disabled = model.getFieldsState(false, 'http_check');
  assert.equal(disabled.fieldsVisible, false);
  assert.equal(disabled.httpVisible, false);
  assert.match(disabled.hint, /启用后选择类型/);

  const http = model.getFieldsState(true, 'http_check');
  assert.equal(http.httpVisible, true);
  assert.equal(http.remainingVisible, false);
  assert.equal(http.testLabel, '测试 HTTP 检测');

  const callback = model.getFieldsState(true, 'remaining_callback');
  assert.equal(callback.httpVisible, false);
  assert.equal(callback.remainingVisible, true);
  assert.equal(callback.showRemainingPreview, true);
  assert.equal(callback.testLabel, '测试回调条件');
});

test('production page loads condition model before panel runtime', () => {
  const html = read('public/index.html');
  const model = html.indexOf('/features/tasks/condition-model.js?v=20260908a');
  const runtime = html.indexOf('/panel-runtime.js?v=20260907a');
  assert.ok(model >= 0);
  assert.ok(runtime > model);
});
