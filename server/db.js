const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

fs.mkdirSync(config.paths.dataDir, { recursive: true });

const db = new Database(config.paths.dbFile);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'javascript',
  script_path TEXT NOT NULL,
  cron_expr TEXT DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0,
  use_browser INTEGER NOT NULL DEFAULT 1,
  use_persistent INTEGER NOT NULL DEFAULT 1,
  timeout_sec INTEGER NOT NULL DEFAULT 300,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS task_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  exit_code INTEGER,
  log_path TEXT,
  screenshot_path TEXT,
  error_text TEXT,
  error_code TEXT,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);
`);

const taskRunColumns = db.prepare('PRAGMA table_info(task_runs)').all().map(row => row.name);
if (!taskRunColumns.includes('error_code')) {
  db.exec('ALTER TABLE task_runs ADD COLUMN error_code TEXT');
}

const taskColumns = ['name', 'type', 'script_path', 'cron_expr', 'enabled', 'use_browser', 'use_persistent', 'timeout_sec'];

function listTasks() {
  return db.prepare('SELECT * FROM tasks ORDER BY id DESC').all();
}

function getTask(id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function createTask(payload) {
  const stmt = db.prepare(`
    INSERT INTO tasks (name, type, script_path, cron_expr, enabled, use_browser, use_persistent, timeout_sec, updated_at)
    VALUES (@name, @type, @script_path, @cron_expr, @enabled, @use_browser, @use_persistent, @timeout_sec, CURRENT_TIMESTAMP)
  `);
  const result = stmt.run(payload);
  return getTask(result.lastInsertRowid);
}

function updateTask(id, payload) {
  const fields = taskColumns.map(col => `${col} = @${col}`).join(', ');
  const stmt = db.prepare(`UPDATE tasks SET ${fields}, updated_at = CURRENT_TIMESTAMP WHERE id = @id`);
  stmt.run({ ...payload, id });
  return getTask(id);
}

function deleteTask(id) {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  db.prepare('DELETE FROM task_runs WHERE task_id = ?').run(id);
}

function createRun(taskId, data) {
  const stmt = db.prepare(`
    INSERT INTO task_runs (task_id, status, started_at, ended_at, exit_code, log_path, screenshot_path, error_text, error_code)
    VALUES (@task_id, @status, @started_at, @ended_at, @exit_code, @log_path, @screenshot_path, @error_text, @error_code)
  `);
  const result = stmt.run({ error_code: null, task_id: taskId, ...data });
  return getRun(result.lastInsertRowid);
}

function updateRun(id, data) {
  const stmt = db.prepare(`
    UPDATE task_runs
    SET status = @status, ended_at = @ended_at, exit_code = @exit_code,
        log_path = @log_path, screenshot_path = @screenshot_path, error_text = @error_text,
        error_code = @error_code
    WHERE id = @id
  `);
  stmt.run({ error_code: null, id, ...data });
  return getRun(id);
}

function getRun(id) {
  return db.prepare('SELECT * FROM task_runs WHERE id = ?').get(id);
}

function listRuns(limit = 50) {
  return db.prepare('SELECT * FROM task_runs ORDER BY id DESC LIMIT ?').all(limit);
}

function listRunsByTask(taskId, limit = 20) {
  return db.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY id DESC LIMIT ?').all(taskId, limit);
}

module.exports = {
  db,
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  createRun,
  updateRun,
  getRun,
  listRuns,
  listRunsByTask,
};
