const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { read } = require('./helpers');

function loadPresentation() {
  const window = { shortTime: value => `short:${value}` };
  const context = vm.createContext({ window });
  vm.runInContext(read('public/features/tasks/condition-presentation.js'), context);
  return context.window.TaskConditionPresentation;
}

test('condition presentation exposes stable pure helper boundaries', () => {
  const presentation = loadPresentation();
  assert.equal(presentation.formatRemainingSec(3660), '1h1m');
  assert.equal(presentation.formatRemainingSec(-90), '-1m');
  assert.equal(presentation.describeCondition({ condition_enabled: 1, condition: { type: 'http_check' } }), 'HTTP 检测');
});

test('condition presentation preserves callback and HTTP card summaries', () => {
  const presentation = loadPresentation();
  assert.equal(presentation.conditionStatusClass({ condition: { type: 'remaining_callback' }, callback_remaining_sec: 10 }), 'active');
  assert.equal(presentation.describeConditionValue({ condition_enabled: 1, condition: { type: 'remaining_callback' }, callback_trigger_at: 'next' }), '下次触发 short:next');
  assert.equal(presentation.describeConditionValue({ condition_enabled: 1, condition: { type: 'http_check' }, condition_last_status: 'ok', condition_next_check_at: 'later' }), 'ok · 下次 short:later');
});

test('condition presentation preserves detailed callback status', () => {
  const presentation = loadPresentation();
  const detail = presentation.describeConditionValueFull({
    condition_enabled: 1,
    condition: { type: 'remaining_callback' },
    callback_remaining_sec: 3600,
    callback_trigger_at: 'next',
    callback_threshold_sec: 600,
    callback_action: 'renew',
  });
  assert.match(detail, /估算剩余 1h/);
  assert.match(detail, /预计触发 short:next/);
  assert.match(detail, /阈值 10m/);
  assert.match(detail, /action=renew/);
});

test('production page loads condition presentation before panel runtime', () => {
  const html = read('public/index.html');
  const presentation = html.indexOf('/features/tasks/condition-presentation.js?v=20260908a');
  const runtime = html.indexOf('/panel-runtime.js?v=20260907a');
  assert.ok(presentation >= 0);
  assert.ok(runtime > presentation);
});
