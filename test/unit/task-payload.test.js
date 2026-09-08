const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeTaskType,
  isPureRequestTaskType,
  buildTaskScriptFilename,
  resolveTaskScriptPath,
} = require('../../server/tasks/task-payload');

test('pure request task types do not require a browser', () => {
  assert.equal(isPureRequestTaskType('python'), true);
  assert.equal(isPureRequestTaskType('php'), true);
  assert.equal(isPureRequestTaskType('shell'), true);
  assert.equal(isPureRequestTaskType('javascript'), false);
});

test('normalizeTaskType preserves supported product task types', () => {
  assert.equal(normalizeTaskType('javascript'), 'javascript');
  assert.equal(normalizeTaskType('python'), 'python');
  assert.equal(normalizeTaskType('php'), 'php');
  assert.equal(normalizeTaskType('shell'), 'shell');
});

test('normalizeTaskType keeps the existing compatibility fallback', () => {
  assert.equal(normalizeTaskType('invalid'), 'javascript');
  assert.equal(normalizeTaskType(undefined), 'javascript');
});

test('buildTaskScriptFilename maps each type to its current extension', () => {
  assert.equal(buildTaskScriptFilename('Daily Report', 'javascript'), 'daily-report.js');
  assert.equal(buildTaskScriptFilename('Daily Report', 'python'), 'daily-report.py');
  assert.equal(buildTaskScriptFilename('Daily Report', 'php'), 'daily-report.php');
  assert.equal(buildTaskScriptFilename('Daily Report', 'shell'), 'daily-report.sh');
});

test('resolveTaskScriptPath preserves explicit paths outside managed task bindings', () => {
  assert.equal(resolveTaskScriptPath('Task', 'php', '/opt/scripts/task.php'), '/opt/scripts/task.php');
  assert.equal(resolveTaskScriptPath('Task', 'shell', ''), '');
});

test('resolveTaskScriptPath preserves existing managed script bindings', () => {
  assert.equal(
    resolveTaskScriptPath('Renamed Task', 'php', 'tasks/shared-script.py'),
    'tasks/shared-script.py'
  );
  assert.equal(
    resolveTaskScriptPath('Renamed Task', 'shell', 'tasks\\shared-script.sh'),
    'tasks/shared-script.sh'
  );
});
