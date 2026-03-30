const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

fs.mkdirSync(config.paths.dataDir, { recursive: true });

const db = new Database(config.paths.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'javascript',
  script_path TEXT NOT NULL,
  cron_expr TEXT DEFAULT '',
  schedule_mode TEXT NOT NULL DEFAULT 'fixed',
  interval_min INTEGER,
  interval_max INTEGER,
  interval_unit TEXT,
  next_run_at TEXT,
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

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS browser_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  user_data_dir TEXT NOT NULL DEFAULT '',
  proxy TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

const taskRunColumns = db.prepare('PRAGMA table_info(task_runs)').all().map(row => row.name);
if (!taskRunColumns.includes('error_code')) {
  db.exec('ALTER TABLE task_runs ADD COLUMN error_code TEXT');
}

const taskTableColumns = db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name);
if (!taskTableColumns.includes('schedule_mode')) db.exec("ALTER TABLE tasks ADD COLUMN schedule_mode TEXT NOT NULL DEFAULT 'fixed'");
if (!taskTableColumns.includes('interval_min')) db.exec('ALTER TABLE tasks ADD COLUMN interval_min INTEGER');
if (!taskTableColumns.includes('interval_max')) db.exec('ALTER TABLE tasks ADD COLUMN interval_max INTEGER');
if (!taskTableColumns.includes('interval_unit')) db.exec('ALTER TABLE tasks ADD COLUMN interval_unit TEXT');
if (!taskTableColumns.includes('next_run_at')) db.exec('ALTER TABLE tasks ADD COLUMN next_run_at TEXT');

if (!taskTableColumns.includes('browser_profile_id')) db.exec('ALTER TABLE tasks ADD COLUMN browser_profile_id INTEGER REFERENCES browser_profiles(id)');

const taskColumns = ['name', 'type', 'script_path', 'cron_expr', 'schedule_mode', 'interval_min', 'interval_max', 'interval_unit', 'next_run_at', 'enabled', 'use_browser', 'use_persistent', 'timeout_sec', 'browser_profile_id'];

function listTasks() {
  return db.prepare('SELECT * FROM tasks ORDER BY id DESC').all();
}

function getTask(id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function createTask(payload) {
  const stmt = db.prepare(`
    INSERT INTO tasks (name, type, script_path, cron_expr, schedule_mode, interval_min, interval_max, interval_unit, next_run_at, enabled, use_browser, use_persistent, timeout_sec, updated_at)
    VALUES (@name, @type, @script_path, @cron_expr, @schedule_mode, @interval_min, @interval_max, @interval_unit, @next_run_at, @enabled, @use_browser, @use_persistent, @timeout_sec, CURRENT_TIMESTAMP)
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

const deleteTaskTxn = db.transaction((id) => {
  db.prepare('DELETE FROM task_runs WHERE task_id = ?').run(id);
  return db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
});

function deleteTask(id) {
  return deleteTaskTxn(id);
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

function getSetting(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  if (value === null || value === undefined || value === '') {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
    return null;
  }

  db.prepare(`
    INSERT INTO app_settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));

  return getSetting(key);
}

function listBrowserProfiles() {
  return db.prepare('SELECT * FROM browser_profiles ORDER BY id ASC').all();
}

function getBrowserProfile(id) {
  return db.prepare('SELECT * FROM browser_profiles WHERE id = ?').get(id);
}

function createBrowserProfile(payload) {
  const stmt = db.prepare(`
    INSERT INTO browser_profiles (name, user_data_dir, proxy)
    VALUES (@name, @user_data_dir, @proxy)
  `);
  const result = stmt.run(payload);
  return getBrowserProfile(result.lastInsertRowid);
}

function updateBrowserProfile(id, payload) {
  db.prepare(`
    UPDATE browser_profiles SET name = @name, user_data_dir = @user_data_dir, proxy = @proxy WHERE id = @id
  `).run({ ...payload, id });
  return getBrowserProfile(id);
}

function deleteBrowserProfile(id) {
  db.prepare('UPDATE tasks SET browser_profile_id = NULL WHERE browser_profile_id = ?').run(id);
  return db.prepare('DELETE FROM browser_profiles WHERE id = ?').run(id);
}

function getTelegramSettings() {
  return {
    botToken: getSetting('telegram_bot_token'),
    chatId: getSetting('telegram_chat_id'),
  };
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
  getSetting,
  setSetting,
  getTelegramSettings,
  listBrowserProfiles,
  getBrowserProfile,
  createBrowserProfile,
  updateBrowserProfile,
  deleteBrowserProfile,
};
