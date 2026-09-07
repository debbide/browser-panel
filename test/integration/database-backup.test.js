const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '../..');

function runIsolated(source, prefix) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const result = spawnSync(process.execPath, ['-e', source], {
    cwd: projectRoot,
    env: { ...process.env, PANEL_RUNTIME_ROOT: runtimeRoot },
    encoding: 'utf8',
    timeout: 15000,
  });
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('database initializes current schema and preserves task environment behavior', () => {
  const output = runIsolated(String.raw`
    const db = require('./server/db');
    const columns = db.db.prepare('PRAGMA table_info(tasks)').all().map((row) => row.name);
    for (const name of ['schedule_mode', 'params_json', 'extra_paths', 'group_id']) {
      if (!columns.includes(name)) throw new Error('missing migrated column: ' + name);
    }
    const taskPayload = Object.fromEntries(
      db.db.prepare('PRAGMA table_info(tasks)').all().map((column) => [column.name, null])
    );
    const task = db.createTask({ ...taskPayload,
      name: 'database behavior', type: 'shell', script_path: 'tasks/db.sh', cron_expr: '',
      schedule_mode: 'fixed', interval_min: null, interval_max: null, interval_unit: null,
      next_run_at: null,
      daily_time_start: null, daily_time_end: null, daily_day_min: null, daily_day_max: null,
      params_json: '{}', enabled: 1, timeout_sec: 30, use_browser: 0, use_temp_profile: 0,
      use_persistent: 0,
      proxy_mode: 'inherit', proxy_value: '', locale: '', timezone_id: '', extra_paths: '[]',
      browser_profile_id: null, group_id: null, condition_enabled: 0, condition_json: '{}',
    });
    db.replaceEnvEntries('task', task.id, [{ name: 'VISIBLE', value: 'yes' }, { name: 'SECRET', value: 'hidden', is_secret: 1 }]);
    const publicEntries = db.listEnvEntriesPublic('task', task.id);
    if (publicEntries.find((entry) => entry.name === 'SECRET').value !== '') throw new Error('secret leaked');
    if (db.getTaskEnvMap(task).VISIBLE !== 'yes') throw new Error('env map failed');
    process.stdout.write('database-ok');
  `, 'browser-panel-db-');
  assert.match(output, /database-ok/);
});

test('backup restore writes task data and rolls database back when file restore fails', () => {
  const output = runIsolated(String.raw`
    const fs = require('fs');
    const path = require('path');
    const config = require('./config');
    const db = require('./server/db');
    const backup = require('./server/backup');
    fs.mkdirSync(config.paths.tasksDir, { recursive: true });
    const payload = {
      schema_version: backup.SCHEMA_VERSION,
      exported_at: new Date().toISOString(),
      tasks: [{
        name: 'restored task', type: 'node', script_path: 'tasks/restored.js',
        config: { enabled: 1, timeout_sec: 30 }, env: [],
      }], profiles: [], groups: [],
      scripts: [{ path: 'tasks/restored.js', content: "console.log('restored');\\n" }],
    };
    const restored = backup.importBackup(payload, { task_strategy: 'rename', script_strategy: 'rename' });
    if (restored.created.length !== 1 || db.listTasks().length !== 1) throw new Error('restore failed');
    const before = db.listTasks().length;
    const bad = JSON.parse(JSON.stringify(payload));
    bad.tasks[0].name = 'rollback task';
    bad.tasks[0].script_path = 'tasks/blocked/rollback.js';
    bad.scripts[0].path = 'tasks/blocked/rollback.js';
    fs.writeFileSync(path.join(config.paths.tasksDir, 'blocked'), 'not-a-directory');
    let failed = false;
    try { backup.importBackup(bad, { task_strategy: 'rename', script_strategy: 'overwrite' }); } catch { failed = true; }
    if (!failed) throw new Error('expected restore failure');
    if (db.listTasks().length !== before) throw new Error('database did not roll back');
    process.stdout.write('backup-ok');
  `, 'browser-panel-backup-');
  assert.match(output, /backup-ok/);
});
