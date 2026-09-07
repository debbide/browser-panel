const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createScriptService } = require('../../server/tasks/script-service');

function fixture() {
  const tasksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'script-service-'));
  const tasks = [];
  const service = createScriptService({
    tasksDir,
    listTasks: () => tasks,
    scanTaskDependencies: () => [],
    normalizeExtraPaths: (value) => Array.isArray(value) ? value : JSON.parse(value || '[]'),
  });
  return { tasksDir, tasks, service };
}

test('imports all supported script types and applies selected extension', () => {
  const { tasksDir, service } = fixture();
  for (const [type, extension] of Object.entries({ javascript: '.js', python: '.py', php: '.php', shell: '.sh' })) {
    const result = service.importScript({ name: `sample.txt`, type, content: 'echo ok' });
    assert.equal(result.name, `sample${extension}`);
    assert.equal(fs.readFileSync(path.join(tasksDir, result.name), 'utf8'), 'echo ok');
  }
});

test('sanitizes names, preserves legacy PHP detection, and allocates conflicts', () => {
  const { tasksDir, service } = fixture();
  const first = service.importScript({ name: '../legacy', content: '<?php echo 1;' });
  assert.equal(first.name, 'legacy.php');
  const second = service.importScript({ name: 'legacy.php', content: '<?php echo 2;', overwrite: false });
  assert.equal(second.name, 'legacy-2.php');
  assert.equal(fs.existsSync(path.join(tasksDir, '..', 'legacy.php')), false);
});

test('rejects invalid imports without leaving partial files', () => {
  const { tasksDir, service } = fixture();
  assert.throws(() => service.importScript({ name: 'bad.exe', content: 'x' }), /supported/);
  assert.throws(() => service.importScript({ name: 'empty.js', content: '' }), /content is required/);
  assert.deepEqual(fs.readdirSync(tasksDir), []);
});

test('merges scanned dependencies with declared extra paths', () => {
  const service = createScriptService({
    tasksDir: '/tmp',
    listTasks: () => [],
    scanTaskDependencies: () => [{ path: 'tasks/lib/a.js' }, { path: 'tasks/lib/c.js' }],
    normalizeExtraPaths: () => ['tasks/lib/b.js', 'tasks/lib/a.js'],
  });
  assert.deepEqual(service.scanAssets({ id: 1, name: 'task', script_path: 'tasks/main.js', extra_paths: '[]' }).paths,
    ['tasks/lib/a.js', 'tasks/lib/b.js', 'tasks/lib/c.js']);
});
