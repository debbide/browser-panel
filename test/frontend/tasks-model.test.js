const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { read } = require('./helpers');

function loadModel() {
  const context = vm.createContext({ window: {} });
  context.window = context;
  vm.runInContext(read('public/features/tasks/model.js'), context);
  return context.TasksModel;
}

test('task payload type follows all four supported script extensions', () => {
  const model = loadModel();
  assert.equal(model.resolveTaskType('tasks/example.js', 'javascript'), 'javascript');
  assert.equal(model.resolveTaskType('tasks/example.py', 'javascript'), 'python');
  assert.equal(model.resolveTaskType('tasks/example.php', 'javascript'), 'php');
  assert.equal(model.resolveTaskType('tasks/example.sh', 'javascript'), 'shell');
});

test('task payload keeps explicit type for unknown script extensions', () => {
  const model = loadModel();
  assert.equal(model.resolveTaskType('tasks/example.custom', 'node'), 'node');
});

test('task model builds the create form summary', () => {
  const summary = loadModel().buildTaskFormSummary({
    scriptPath: 'tasks/group/example.js',
    timeout: '120',
    scheduleEnabled: true,
    scheduleMode: 'daily_window',
    conditionEnabled: true,
    temporaryProfile: false,
  });
  assert.equal(summary.scriptSummary, '脚本：example.js · 超时 120s');
  assert.equal(summary.summary, '脚本 example.js · 超时 120s · 持久配置 · 定时·每天时段 · 条件触发');
});

test('task model preserves empty form defaults', () => {
  const summary = loadModel().buildTaskFormSummary({
    scriptPath: '',
    timeout: '',
    scheduleEnabled: false,
    scheduleMode: 'fixed',
    conditionEnabled: false,
    temporaryProfile: true,
  });
  assert.equal(summary.scriptSummary, '脚本：未选择（右侧导入或选中）');
  assert.equal(summary.summary, '未选脚本 · 超时 300s · 临时（用完删除） · 手动运行 · 无条件');
});

test('task model parses persisted parameter JSON safely', () => {
  const model = loadModel();
  assert.equal(JSON.stringify(model.parseParamsJson('{"count":2}')), '{"count":2}');
  assert.equal(JSON.stringify(model.parseParamsJson({ enabled: true })), '{"enabled":true}');
  assert.equal(JSON.stringify(model.parseParamsJson('[1,2]')), '{}');
  assert.equal(JSON.stringify(model.parseParamsJson('{broken')), '{}');
});

test('task model converts parameter objects to editor rows', () => {
  const rows = loadModel().entriesFromParamsObject({
    NAME: 'value',
    OPTIONS: { retries: 2 },
    PASSWORD_TOKEN: 'secret',
    EMPTY: '',
  }, name => name.includes('PASSWORD'));
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [
    { name: 'NAME', value: 'value', is_secret: 0, has_value: true },
    { name: 'OPTIONS', value: '{"retries":2}', is_secret: 0, has_value: true },
    { name: 'PASSWORD_TOKEN', value: 'secret', is_secret: 1, has_value: true },
  ]);
});

test('task model reads global Telegram flags from objects and rows', () => {
  const model = loadModel();
  assert.equal(model.readUseGlobalTelegramFlag({}), true);
  assert.equal(model.readUseGlobalTelegramFlag({ use_global_telegram: 'off' }), false);
  assert.equal(model.readUseGlobalTelegramFlag({ USE_GLOBAL_TELEGRAM: 'YES' }), true);
  assert.equal(model.readUseGlobalTelegramFlag([{ name: 'use_global_telegram', value: '0' }]), false);
  assert.equal(model.readUseGlobalTelegramFlag([{ name: 'USE_GLOBAL_TELEGRAM', value: 'on' }]), true);
});

test('task model identifies Host2Play scripts case-insensitively', () => {
  const model = loadModel();
  assert.equal(model.isHost2PlayScript('tasks/host2play_renew_dp.js'), true);
  assert.equal(model.isHost2PlayScript('TASKS/HOST2PLAY/custom.py'), true);
  assert.equal(model.isHost2PlayScript('tasks/other.js'), false);
  assert.equal(model.isHost2PlayScript(null), false);
});

test('task model converts env rows to backward-compatible params', () => {
  const model = loadModel();
  assert.deepEqual(JSON.parse(JSON.stringify(model.paramsFromEnvRows([
    { name: 'NAME', value: 'value' },
    { name: 'SECRET', value: '', is_secret: 1, has_value: true },
    { name: '', value: 'ignored' },
  ]))), { NAME: 'value', SECRET: '' });
});

test('task model merges Host2Play defaults without overwriting current rows', () => {
  const model = loadModel();
  const rows = model.mergeHost2PlayTemplate([{ name: 'MAX_RETRIES', value: '3', is_secret: 0, has_value: true }]);
  assert.equal(rows.find((entry) => entry.name === 'MAX_RETRIES').value, '3');
  assert.equal(rows.find((entry) => entry.name === 'VISION_CALL_BUDGET').value, '200');
  assert.equal(rows.find((entry) => entry.name === 'RENEW_URLS').has_value, false);
});

test('panel runtime delegates task env transformations to the model', () => {
  const runtime = read('public/panel-runtime.js');
  assert.match(runtime, /TasksModel\.paramsFromEnvRows/);
  assert.match(runtime, /TasksModel\.mergeHost2PlayTemplate/);
  assert.doesNotMatch(runtime, /const defaults = \[\s*\{ name: 'RENEW_URLS'/);
});
