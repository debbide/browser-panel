const test = require('node:test');
const assert = require('node:assert/strict');
const { read } = require('./helpers');

test('active panel activation keeps tab and header state synchronized', () => {
  const source = read('public/app.js');
  assert.match(source, /function activateAppTab\(targetId/);
  assert.match(source, /classList\.toggle\('active'/);
  assert.match(source, /tabContents\.forEach/);
});

test('task filter and backup selections use persistent module state', () => {
  const source = read('public/app.js');
  assert.match(source, /let selectedBackupTaskIds = new Set\(\)/);
  assert.match(source, /let tasksCache = \[\]/);
  assert.match(source, /window\.selectTaskGroup/);
});

test('SSE startup is guarded and reconnect timing remains explicit', () => {
  const source = read('public/app.js');
  assert.match(source, /function startStatusStream\(\)/);
  assert.match(source, /if \(streamStarted\) return;/);
  assert.match(source, /new EventSource\(SSE_URL\)/);
  assert.match(source, /EventSource 自带重连/);
  assert.match(source, /startFallbackPolling\(\)/);
});

test('SSE events refresh only declared domains', () => {
  const source = read('public/app.js');
  assert.match(source, /eventSource\.addEventListener\('task'/);
  assert.match(source, /eventSource\.addEventListener\('state'/);
  assert.match(source, /const onStateEvent = \(\) => scheduleRefresh\(\)/);
});
