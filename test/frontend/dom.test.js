const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { evaluateFunctions, read } = require('./helpers');

test('HTML, status, unit and time formatting remain stable', () => {
  const source = read('public/core/dom.js');
  const { prettyStatus, prettyUnit, shortTime } = evaluateFunctions(['prettyStatus', 'prettyUnit', 'shortTime']);
  assert.match(source, /function escapeHtml\(input\)/);
  assert.match(source, /\.replace\(\/&\/g, '&amp;'\)/);
  assert.match(source, /\.replace\(\/'\/g, '&#39;'\)/);
  assert.equal(prettyStatus('success'), '成功');
  assert.equal(prettyUnit('minutes'), '分钟');
  assert.equal(shortTime('2026-09-07T12:34:56Z').length > 0, true);
});

test('DOM utilities load before the application entry', () => {
  const html = read('public/index.html');
  const domIndex = html.indexOf('/core/dom.js?v=20260907a');
  const appIndex = html.indexOf('/app.js?v=20260814c');
  assert.ok(domIndex >= 0);
  assert.ok(appIndex > domIndex);
});

test('task model loads before the application entry', () => {
  const html = read('public/index.html');
  const modelIndex = html.indexOf('/features/tasks/model.js?v=20260907a');
  const appIndex = html.indexOf('/app.js?v=20260814c');
  assert.ok(modelIndex >= 0);
  assert.ok(appIndex > modelIndex);
});

test('task list and modal selectors remain present', () => {
  const dom = new JSDOM(read('public/index.html'));
  const document = dom.window.document;
  assert.ok(document.querySelector('#tasks'));
  assert.ok(document.querySelector('#task-form'));
  assert.ok(document.querySelector('#task-modal'));
  assert.ok(document.querySelector('#task-group-select'));
});

test('task edit flow preserves explicit script path', () => {
  const source = `${read('public/features/tasks/editor-controller.js')}\n${read('public/panel-runtime.js')}`;
  assert.match(source, /selectedScriptPath = task\.script_path;/);
  assert.match(source, /loadScriptIntoEditor\(task\.script_path, \{ preserveHint: true, reopenModal: false \}\)/);
  assert.match(source, /form\.script_path\.value = scriptPath;/);
});

test('task create and update payloads retain task type and script path', () => {
  const source = `${read('public/features/tasks/editor-controller.js')}\n${read('public/panel-runtime.js')}`;
  assert.match(source, /const formData = new FormData\(form\)/);
  assert.match(source, /const payload = Object\.fromEntries\(formData\.entries\(\)\)/);
  assert.match(source, /payload\.type = TasksModel\.resolveTaskType\(payload\.script_path, payload\.type\)/);
  assert.match(source, /payload\.use_browser = String\(payload\.use_browser\) === '1'/);
  assert.match(source, /TasksApi\.saveTask\(editingId, payload\)/);
});

test('settings save keeps JSON endpoint and payload contract', () => {
  const source = `${read('public/features/scheduler/api.js')}\n${read('public/panel-runtime.js')}`;
  assert.match(source, /fetchJson\('\/api\/settings\/scheduler'/);
  assert.match(source, /method:\s*'POST'/);
  assert.match(source, /headers:\s*\{ 'Content-Type': 'application\/json' \}/);
  assert.match(source, /body:\s*JSON\.stringify/);
});
