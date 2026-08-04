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
  params_json TEXT NOT NULL DEFAULT '{}',
  browser_profile_id INTEGER REFERENCES browser_profiles(id),
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
  retryable INTEGER,
  retry_reason TEXT,
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
  runtime_stack TEXT NOT NULL DEFAULT '',
  locale TEXT NOT NULL DEFAULT '',
  timezone_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS env_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  owner_id INTEGER,
  name TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  is_secret INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(scope, owner_id, name)
);

CREATE TABLE IF NOT EXISTS panel_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- token_hash 存 sha256(token)，不存明文：万一 app.db 泄露，
-- 拿到的哈希不能直接当 Cookie 用。
CREATE TABLE IF NOT EXISTS panel_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES panel_users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_panel_sessions_user ON panel_sessions(user_id);
`);

const taskRunColumns = db.prepare('PRAGMA table_info(task_runs)').all().map(row => row.name);
if (!taskRunColumns.includes('error_code')) {
  db.exec('ALTER TABLE task_runs ADD COLUMN error_code TEXT');
}
if (!taskRunColumns.includes('retryable')) {
  db.exec('ALTER TABLE task_runs ADD COLUMN retryable INTEGER');
}
if (!taskRunColumns.includes('retry_reason')) {
  db.exec('ALTER TABLE task_runs ADD COLUMN retry_reason TEXT');
}
if (!taskRunColumns.includes('screenshots_dir')) {
  db.exec('ALTER TABLE task_runs ADD COLUMN screenshots_dir TEXT');
}

const taskTableColumns = db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name);
if (!taskTableColumns.includes('schedule_mode')) db.exec("ALTER TABLE tasks ADD COLUMN schedule_mode TEXT NOT NULL DEFAULT 'fixed'");
if (!taskTableColumns.includes('interval_min')) db.exec('ALTER TABLE tasks ADD COLUMN interval_min INTEGER');
if (!taskTableColumns.includes('interval_max')) db.exec('ALTER TABLE tasks ADD COLUMN interval_max INTEGER');
if (!taskTableColumns.includes('interval_unit')) db.exec('ALTER TABLE tasks ADD COLUMN interval_unit TEXT');
if (!taskTableColumns.includes('next_run_at')) db.exec('ALTER TABLE tasks ADD COLUMN next_run_at TEXT');
if (!taskTableColumns.includes('daily_time_start')) db.exec('ALTER TABLE tasks ADD COLUMN daily_time_start TEXT');
if (!taskTableColumns.includes('daily_time_end')) db.exec('ALTER TABLE tasks ADD COLUMN daily_time_end TEXT');

if (!taskTableColumns.includes('browser_profile_id')) db.exec('ALTER TABLE tasks ADD COLUMN browser_profile_id INTEGER REFERENCES browser_profiles(id)');
if (!taskTableColumns.includes('params_json')) db.exec("ALTER TABLE tasks ADD COLUMN params_json TEXT NOT NULL DEFAULT '{}'");
if (!taskTableColumns.includes('condition_enabled')) db.exec('ALTER TABLE tasks ADD COLUMN condition_enabled INTEGER NOT NULL DEFAULT 0');
if (!taskTableColumns.includes('condition_json')) db.exec("ALTER TABLE tasks ADD COLUMN condition_json TEXT NOT NULL DEFAULT '{}'");
if (!taskTableColumns.includes('condition_next_check_at')) db.exec('ALTER TABLE tasks ADD COLUMN condition_next_check_at TEXT');
if (!taskTableColumns.includes('condition_last_status')) db.exec('ALTER TABLE tasks ADD COLUMN condition_last_status TEXT');
if (!taskTableColumns.includes('condition_last_detail')) db.exec('ALTER TABLE tasks ADD COLUMN condition_last_detail TEXT');
if (!taskTableColumns.includes('condition_last_checked_at')) db.exec('ALTER TABLE tasks ADD COLUMN condition_last_checked_at TEXT');
if (!taskTableColumns.includes('condition_cooldown_until')) db.exec('ALTER TABLE tasks ADD COLUMN condition_cooldown_until TEXT');
// Script remaining-time callback (always stored when script reports; scheduling uses condition switch)
if (!taskTableColumns.includes('callback_remaining_sec')) db.exec('ALTER TABLE tasks ADD COLUMN callback_remaining_sec REAL');
if (!taskTableColumns.includes('callback_reported_at')) db.exec('ALTER TABLE tasks ADD COLUMN callback_reported_at TEXT');
if (!taskTableColumns.includes('callback_trigger_at')) db.exec('ALTER TABLE tasks ADD COLUMN callback_trigger_at TEXT');
if (!taskTableColumns.includes('callback_threshold_sec')) db.exec('ALTER TABLE tasks ADD COLUMN callback_threshold_sec REAL');
if (!taskTableColumns.includes('callback_valid_until')) db.exec('ALTER TABLE tasks ADD COLUMN callback_valid_until TEXT');
if (!taskTableColumns.includes('callback_action')) db.exec('ALTER TABLE tasks ADD COLUMN callback_action TEXT');

const browserProfileColumns = db.prepare('PRAGMA table_info(browser_profiles)').all().map(row => row.name);
if (!browserProfileColumns.includes('runtime_stack')) db.exec("ALTER TABLE browser_profiles ADD COLUMN runtime_stack TEXT NOT NULL DEFAULT ''");
if (!browserProfileColumns.includes('locale')) db.exec("ALTER TABLE browser_profiles ADD COLUMN locale TEXT NOT NULL DEFAULT ''");
if (!browserProfileColumns.includes('timezone_id')) db.exec("ALTER TABLE browser_profiles ADD COLUMN timezone_id TEXT NOT NULL DEFAULT ''");

const taskColumns = [
  'name', 'type', 'script_path', 'cron_expr', 'schedule_mode',
  'interval_min', 'interval_max', 'interval_unit', 'daily_time_start', 'daily_time_end', 'next_run_at',
  'enabled', 'use_browser', 'use_persistent', 'timeout_sec', 'params_json', 'browser_profile_id',
  'condition_enabled', 'condition_json', 'condition_next_check_at',
  'condition_last_status', 'condition_last_detail', 'condition_last_checked_at', 'condition_cooldown_until',
  'callback_remaining_sec', 'callback_reported_at', 'callback_trigger_at',
  'callback_threshold_sec', 'callback_valid_until', 'callback_action',
];

function listTasks() {
  return db.prepare('SELECT * FROM tasks ORDER BY id DESC').all();
}

function getTask(id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function createTask(payload) {
  const stmt = db.prepare(`
    INSERT INTO tasks (
      name, type, script_path, cron_expr, schedule_mode,
      interval_min, interval_max, interval_unit, daily_time_start, daily_time_end, next_run_at,
      enabled, use_browser, use_persistent, timeout_sec, params_json, browser_profile_id,
      condition_enabled, condition_json, condition_next_check_at,
      condition_last_status, condition_last_detail, condition_last_checked_at, condition_cooldown_until,
      callback_remaining_sec, callback_reported_at, callback_trigger_at,
      callback_threshold_sec, callback_valid_until, callback_action,
      updated_at
    )
    VALUES (
      @name, @type, @script_path, @cron_expr, @schedule_mode,
      @interval_min, @interval_max, @interval_unit, @daily_time_start, @daily_time_end, @next_run_at,
      @enabled, @use_browser, @use_persistent, @timeout_sec, @params_json, @browser_profile_id,
      @condition_enabled, @condition_json, @condition_next_check_at,
      @condition_last_status, @condition_last_detail, @condition_last_checked_at, @condition_cooldown_until,
      @callback_remaining_sec, @callback_reported_at, @callback_trigger_at,
      @callback_threshold_sec, @callback_valid_until, @callback_action,
      CURRENT_TIMESTAMP
    )
  `);
  const result = stmt.run({
    condition_enabled: 0,
    condition_json: '{}',
    condition_next_check_at: null,
    condition_last_status: null,
    condition_last_detail: null,
    condition_last_checked_at: null,
    condition_cooldown_until: null,
    callback_remaining_sec: null,
    callback_reported_at: null,
    callback_trigger_at: null,
    callback_threshold_sec: null,
    callback_valid_until: null,
    callback_action: null,
    ...payload,
  });
  return getTask(result.lastInsertRowid);
}

/**
 * Persist script remaining-time callback. Always stores report; trigger fields optional.
 * Does not clear fields that are undefined in patch (only overwrites provided keys).
 */
function applyTaskCallbackReport(taskId, report = {}) {
  const id = Number(taskId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const current = getTask(id);
  if (!current) return null;

  const patch = { ...current };
  if (report.remaining_sec !== undefined && report.remaining_sec !== null && report.remaining_sec !== '') {
    const n = Number(report.remaining_sec);
    if (Number.isFinite(n)) patch.callback_remaining_sec = n;
  }
  if (report.reported_at !== undefined) {
    patch.callback_reported_at = report.reported_at || null;
  }
  if (report.trigger_at !== undefined) {
    patch.callback_trigger_at = report.trigger_at || null;
  }
  if (report.threshold_sec !== undefined && report.threshold_sec !== null && report.threshold_sec !== '') {
    const n = Number(report.threshold_sec);
    patch.callback_threshold_sec = Number.isFinite(n) ? n : null;
  }
  if (report.valid_until !== undefined) {
    patch.callback_valid_until = report.valid_until ? String(report.valid_until).slice(0, 120) : null;
  }
  if (report.action !== undefined) {
    patch.callback_action = report.action ? String(report.action).slice(0, 64) : null;
  }
  return updateTask(id, patch);
}

function updateTask(id, payload) {
  const fields = taskColumns.map(col => `${col} = @${col}`).join(', ');
  const stmt = db.prepare(`UPDATE tasks SET ${fields}, updated_at = CURRENT_TIMESTAMP WHERE id = @id`);
  stmt.run({ ...payload, id });
  return getTask(id);
}

const deleteTaskTxn = db.transaction((id) => {
  db.prepare('DELETE FROM task_runs WHERE task_id = ?').run(id);
  db.prepare("DELETE FROM env_entries WHERE scope = 'task' AND owner_id = ?").run(id);
  return db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
});

function deleteTask(id) {
  return deleteTaskTxn(id);
}

const ENV_SCOPES = new Set(['global', 'task', 'profile']);
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VALUE_MAX_LEN = 200_000;

function normalizeEnvScope(scope) {
  const value = String(scope || '').trim().toLowerCase();
  if (!ENV_SCOPES.has(value)) throw new Error('Invalid env scope');
  return value;
}

function normalizeEnvOwnerId(scope, ownerId) {
  // SQLite UNIQUE treats each NULL as distinct; use 0 as global sentinel.
  if (scope === 'global') return 0;
  const id = Number(ownerId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid env owner_id');
  return id;
}

function normalizeEnvName(name) {
  const key = String(name || '').trim();
  if (!key) throw new Error('Env name is required');
  if (!ENV_NAME_RE.test(key)) {
    throw new Error(`Invalid env name: ${key} (use A-Z, 0-9, _)`);
  }
  if (key.length > 128) throw new Error('Env name too long');
  return key;
}

function normalizeEnvValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function listEnvEntriesRaw(scope, ownerId = null) {
  const normalizedScope = normalizeEnvScope(scope);
  const id = normalizeEnvOwnerId(normalizedScope, ownerId);
  return db.prepare(`
    SELECT * FROM env_entries
    WHERE scope = ? AND owner_id = ?
    ORDER BY name COLLATE NOCASE ASC
  `).all(normalizedScope, id);
}

function publicEnvEntry(row) {
  if (!row) return null;
  const isSecret = Boolean(row.is_secret);
  const ownerId = row.owner_id === 0 || row.owner_id === null ? null : row.owner_id;
  return {
    id: row.id,
    scope: row.scope,
    owner_id: ownerId,
    name: row.name,
    value: isSecret ? '' : row.value,
    valueMasked: isSecret ? maskSecret(row.value) : '',
    is_secret: isSecret ? 1 : 0,
    has_value: Boolean(String(row.value || '').length),
    updated_at: row.updated_at,
  };
}

function listEnvEntriesPublic(scope, ownerId = null) {
  return listEnvEntriesRaw(scope, ownerId).map(publicEnvEntry);
}

function envEntriesToObject(rows) {
  const out = {};
  for (const row of rows || []) {
    if (!row || !row.name) continue;
    out[String(row.name)] = row.value == null ? '' : String(row.value);
  }
  return out;
}

function getEnvMap(scope, ownerId = null) {
  return envEntriesToObject(listEnvEntriesRaw(scope, ownerId));
}

function parseParamsJsonObject(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return { ...raw };
  try {
    const parsed = JSON.parse(String(raw));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // ignore
  }
  return {};
}

function paramsObjectToEntries(params) {
  const entries = [];
  const obj = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  for (const [name, value] of Object.entries(obj)) {
    if (!name) continue;
    if (value === null || value === undefined || value === '') continue;
    let isSecret = 0;
    const upper = String(name).toUpperCase();
    if (/(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE)/i.test(upper)) isSecret = 1;
    entries.push({
      name: String(name),
      value: normalizeEnvValue(value),
      is_secret: isSecret,
    });
  }
  return entries;
}

function getTaskEnvMap(task) {
  if (!task) return {};
  const taskId = Number(task.id);
  if (Number.isInteger(taskId) && taskId > 0) {
    const rows = listEnvEntriesRaw('task', taskId);
    if (rows.length) return envEntriesToObject(rows);
  }
  return parseParamsJsonObject(task.params_json);
}

function getProfileEnvMap(profileId) {
  const id = Number(profileId);
  if (!Number.isInteger(id) || id <= 0) return {};
  return getEnvMap('profile', id);
}

function getGlobalEnvMap() {
  return getEnvMap('global');
}

const replaceEnvEntriesTxn = db.transaction((scope, ownerId, entriesInput) => {
  const normalizedScope = normalizeEnvScope(scope);
  const normalizedOwnerId = normalizeEnvOwnerId(normalizedScope, ownerId);
  const existing = listEnvEntriesRaw(normalizedScope, normalizedOwnerId);
  const existingByName = new Map(existing.map((row) => [row.name, row]));

  const incoming = Array.isArray(entriesInput) ? entriesInput : [];
  const nextNames = new Set();
  const upsert = db.prepare(`
    INSERT INTO env_entries (scope, owner_id, name, value, is_secret, updated_at)
    VALUES (@scope, @owner_id, @name, @value, @is_secret, CURRENT_TIMESTAMP)
    ON CONFLICT(scope, owner_id, name) DO UPDATE SET
      value = excluded.value,
      is_secret = excluded.is_secret,
      updated_at = CURRENT_TIMESTAMP
  `);
  const remove = db.prepare(`
    DELETE FROM env_entries WHERE scope = ? AND owner_id = ? AND name = ?
  `);

  for (const item of incoming) {
    if (!item) continue;
    const name = normalizeEnvName(item.name);
    nextNames.add(name);
    const isSecret = item.is_secret === true || item.is_secret === 1 || item.is_secret === '1';
    let value = normalizeEnvValue(item.value);
    if (value.length > ENV_VALUE_MAX_LEN) {
      throw new Error(`Env value too long for ${name}`);
    }
    const prev = existingByName.get(name);
    // Secret blank keep: empty new value + existing secret → keep old value
    // (UI never re-sends secret plaintext; empty means "unchanged")
    if (isSecret && value === '' && prev && String(prev.value || '').length) {
      value = prev.value;
    }
    // Also keep previous secret if client forgot is_secret but sent empty value for same name
    if (!isSecret && value === '' && prev && prev.is_secret && String(prev.value || '').length) {
      value = prev.value;
      // treat as secret still
      upsert.run({
        scope: normalizedScope,
        owner_id: normalizedOwnerId,
        name,
        value,
        is_secret: 1,
      });
      continue;
    }
    // Skip empty non-secrets (no value to inject)
    if (!isSecret && value === '' && !(prev && prev.is_secret && value === '')) {
      continue;
    }
    upsert.run({
      scope: normalizedScope,
      owner_id: normalizedOwnerId,
      name,
      value,
      is_secret: isSecret ? 1 : 0,
    });
  }

  for (const row of existing) {
    if (nextNames.has(row.name)) continue;
    remove.run(normalizedScope, normalizedOwnerId, row.name);
  }

  return listEnvEntriesPublic(normalizedScope, normalizedOwnerId);
});

function replaceEnvEntries(scope, ownerId, entries) {
  return replaceEnvEntriesTxn(scope, ownerId, entries);
}

function setTaskEnvFromParams(taskId, paramsObject) {
  const id = Number(taskId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid task id');
  const entries = paramsObjectToEntries(paramsObject);
  // Preserve is_secret for existing task secrets when params object has plain values
  const existing = listEnvEntriesRaw('task', id);
  const existingSecrets = new Set(existing.filter((r) => r.is_secret).map((r) => r.name));
  const merged = entries.map((e) => ({
    ...e,
    is_secret: existingSecrets.has(e.name) || e.is_secret ? 1 : 0,
  }));
  return replaceEnvEntries('task', id, merged);
}

function syncTaskParamsJsonFromEnv(taskId) {
  const id = Number(taskId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const map = getEnvMap('task', id);
  const paramsJson = JSON.stringify(map);
  db.prepare('UPDATE tasks SET params_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(paramsJson, id);
  return getTask(id);
}

function migrateTaskParamsToEnvIfNeeded(task) {
  if (!task || !task.id) return;
  const rows = listEnvEntriesRaw('task', task.id);
  if (rows.length) return;
  const params = parseParamsJsonObject(task.params_json);
  if (!Object.keys(params).length) return;
  setTaskEnvFromParams(task.id, params);
}

function isGithubCompatEnabled() {
  const raw = getSetting('github_compat_env');
  if (raw === null || raw === undefined || raw === '') return true;
  return toBool(raw);
}

function setGithubCompatEnabled(enabled) {
  setSetting('github_compat_env', enabled ? '1' : '0');
  return isGithubCompatEnabled();
}

/** Default serial (false). Only explicit truthy setting enables parallel. */
function isTaskParallelAllowed() {
  return toBool(getSetting('task_allow_parallel'));
}

function setTaskParallelAllowed(enabled) {
  setSetting('task_allow_parallel', enabled ? '1' : '0');
  return isTaskParallelAllowed();
}

// Success-log soft success settings live in runtime/success-heuristics.js
// (getSuccessHeuristicSettings / setSuccessHeuristicSettings) using getSetting/setSetting.

function createRun(taskId, data) {
  const stmt = db.prepare(`
    INSERT INTO task_runs (task_id, status, started_at, ended_at, exit_code, log_path, screenshot_path, screenshots_dir, error_text, error_code, retryable, retry_reason)
    VALUES (@task_id, @status, @started_at, @ended_at, @exit_code, @log_path, @screenshot_path, @screenshots_dir, @error_text, @error_code, @retryable, @retry_reason)
  `);
  const result = stmt.run({ error_code: null, retryable: null, retry_reason: null, screenshots_dir: null, task_id: taskId, ...data });
  return getRun(result.lastInsertRowid);
}

function updateRun(id, data) {
  const stmt = db.prepare(`
    UPDATE task_runs
    SET status = @status, ended_at = @ended_at, exit_code = @exit_code,
        log_path = @log_path, screenshot_path = @screenshot_path, screenshots_dir = @screenshots_dir, error_text = @error_text,
        error_code = @error_code, retryable = @retryable, retry_reason = @retry_reason
    WHERE id = @id
  `);
  stmt.run({ error_code: null, retryable: null, retry_reason: null, screenshots_dir: null, id, ...data });
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

/**
 * Latest run per task, regardless of how long ago it happened.
 * The task cards used to read this out of listRuns(100), so a task that ran
 * days ago would fall out of that global window and render as "未运行" even
 * though listRunsByTask still had its history.
 */
function listLatestRunPerTask() {
  return db.prepare(`
    SELECT r.* FROM task_runs r
    JOIN (SELECT task_id, MAX(id) AS id FROM task_runs GROUP BY task_id) latest
      ON latest.id = r.id
  `).all();
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
    INSERT INTO browser_profiles (name, user_data_dir, proxy, runtime_stack, locale, timezone_id)
    VALUES (@name, @user_data_dir, @proxy, @runtime_stack, @locale, @timezone_id)
  `);
  const result = stmt.run(payload);
  return getBrowserProfile(result.lastInsertRowid);
}

function updateBrowserProfile(id, payload) {
  db.prepare(`
    UPDATE browser_profiles
    SET name = @name, user_data_dir = @user_data_dir, proxy = @proxy, runtime_stack = @runtime_stack, locale = @locale, timezone_id = @timezone_id
    WHERE id = @id
  `).run({ ...payload, id });
  return getBrowserProfile(id);
}

function deleteBrowserProfile(id) {
  db.prepare('UPDATE tasks SET browser_profile_id = NULL WHERE browser_profile_id = ?').run(id);
  db.prepare("DELETE FROM env_entries WHERE scope = 'profile' AND owner_id = ?").run(id);
  return db.prepare('DELETE FROM browser_profiles WHERE id = ?').run(id);
}

function getTelegramSettings() {
  return {
    botToken: getSetting('telegram_bot_token'),
    chatId: getSetting('telegram_chat_id'),
    proxy: getSetting('telegram_proxy'),
  };
}

function maskSecret(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= 8) return `${text.slice(0, 2)}***`;
  return `${text.slice(0, 4)}***${text.slice(-4)}`;
}

function toBool(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function normalizeRuntimeStack(value) {
  const stack = String(value || '').trim().toLowerCase();
  if (stack === 'seleniumbase') return 'seleniumbase';
  return 'playwright';
}

function normalizePackageList(value) {
  return String(value || '')
    .split(/[\r\n,;]+/g)
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 20)
    .join(',');
}

function normalizeExtensionDirs(value, fallback = '') {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) return String(fallback || '').trim();
  if (/[\r\n\0]/.test(text)) return String(fallback || '').trim();
  return text.slice(0, 4096);
}

function normalizeChromePath(value, fallback = '') {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) return String(fallback || '').trim();
  // Reject obvious garbage; keep paths portable (no shell metachar requirement).
  if (/[\r\n\0]/.test(text)) return String(fallback || '').trim();
  return text.slice(0, 512);
}

function getBrowserRuntimeSettings() {
  const pluginPackages = normalizePackageList(getSetting('browser_plugin_packages'));
  const hasPluginPackages = pluginPackages.length > 0;
  const runtimeStack = normalizeRuntimeStack(getSetting('browser_runtime_stack'));
  const usePlaywrightExtra = runtimeStack === 'playwright'
    && (toBool(getSetting('browser_use_playwright_extra')) || hasPluginPackages);
  // DB override first; empty = fall back to env/config default path
  const chromePath = normalizeChromePath(
    getSetting('browser_chrome_path'),
    (config.browser && config.browser.chromePath) || ''
  );
  const extensionDirs = normalizeExtensionDirs(
    getSetting('browser_extension_dirs'),
    (config.browser && config.browser.extensions) || ''
  );
  return {
    runtimeStack,
    usePlaywrightExtra,
    pluginPackages,
    chromePath,
    extensionDirs,
    extensionDirsSource: String(getSetting('browser_extension_dirs') || '').trim()
      ? 'panel'
      : 'env',
    chromePathSource: String(getSetting('browser_chrome_path') || '').trim()
      ? 'panel'
      : 'env',
  };
}

function setBrowserRuntimeSettings(payload = {}) {
  const usePlaywrightExtra = payload.usePlaywrightExtra ? '1' : '0';
  const pluginPackages = normalizePackageList(payload.pluginPackages);
  const runtimeStack = normalizeRuntimeStack(payload.runtimeStack);
  // Empty string clears panel override and reverts to env/config default
  if (payload.chromePath !== undefined) {
    const chromePath = normalizeChromePath(payload.chromePath, '');
    setSetting('browser_chrome_path', chromePath || null);
  }
  if (payload.extensionDirs !== undefined) {
    const extensionDirs = normalizeExtensionDirs(payload.extensionDirs, '');
    setSetting('browser_extension_dirs', extensionDirs || null);
  }
  setSetting('browser_runtime_stack', runtimeStack);
  setSetting('browser_use_playwright_extra', usePlaywrightExtra);
  setSetting('browser_plugin_packages', pluginPackages);
  return getBrowserRuntimeSettings();
}

function getVisionSettings() {
  return {
    baseUrl: getSetting('vision_base_url') || '',
    apiKey: getSetting('vision_api_key') || '',
    model: getSetting('vision_model') || '',
    // 多通道：每行 baseUrl|apiKey|model ；apiKey 写 - 表示沿用主 key
    channels: getSetting('vision_channels') || '',
  };
}

// 解析一行额外通道: baseUrl|apiKey|model（apiKey 可写 - 沿用主 key）
function parseVisionChannelLine(line, primaryKey = '') {
  const text = String(line || '').trim();
  if (!text || text.startsWith('#')) return null;
  const parts = text.split(/[|｜]/).map((p) => p.trim());
  if (parts.length < 2) return null;
  const baseUrl = parts[0];
  let apiKey;
  let model;
  if (parts.length === 2) {
    apiKey = primaryKey;
    model = parts[1];
  } else {
    apiKey = parts[1];
    model = parts[2];
    if (['', '-', '*', 'same'].includes(apiKey.toLowerCase())) apiKey = primaryKey;
  }
  if (!baseUrl || !model) return null;
  return { baseUrl, apiKey: apiKey || '', model };
}

// 把当前设置展开成有序通道列表（含主通道为 index 0），带明文 key（仅内部用）
//
// 每个通道带一个稳定 id：主通道恒为 'primary'，额外通道用它在 vision_channels
// 文本里的行序号（ch1/ch2/…）。id 与 baseUrl/model 无关，所以改模型、改 baseUrl
// 或调整顺序都不会让通道"换了身份"——这正是以前切模型丢 key 的根因。
function getVisionChannelsInternal() {
  const settings = getVisionSettings();
  const list = [];
  if (settings.baseUrl && settings.model) {
    list.push({
      id: 'primary',
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey || '',
      model: settings.model,
      isPrimary: true,
    });
  }
  let lineNo = 0;
  String(settings.channels || '')
    .split(/\r?\n/)
    .forEach((line) => {
      const ch = parseVisionChannelLine(line, settings.apiKey || '');
      if (!ch) return;
      lineNo += 1;
      list.push({ ...ch, id: `ch${lineNo}`, isPrimary: false });
    });
  return list;
}

function getVisionSettingsPublic() {
  const list = getVisionChannelsInternal();
  const channelList = list.map((ch) => ({
    id: ch.id,
    baseUrl: ch.baseUrl,
    model: ch.model,
    apiKeyMasked: maskSecret(ch.apiKey),
    hasKey: Boolean(ch.apiKey),
    isPrimary: Boolean(ch.isPrimary),
  }));
  const settings = getVisionSettings();
  return {
    configured: channelList.some((c) => c.hasKey),
    channelList,
    channelCount: channelList.length,
    // 兼容旧字段
    baseUrl: settings.baseUrl || '',
    model: settings.model || '',
    apiKeyMasked: maskSecret(settings.apiKey),
    channels: settings.channels || '',
  };
}

// 解析一个通道该用哪个 key。顺序有讲究：
//   1) 用户在表单里显式填了新 key —— 最高优先
//   2) 按通道 id 找上次保存的 key —— 改 model / baseUrl / 顺序都不丢 key
//   3) 按 baseUrl+model 找 —— 兼容没有 id 的旧前端/旧调用
// 前端从不回传已保存的 key（密码框只显示掩码 placeholder），所以 2/3 是常态路径。
function resolveVisionChannelKey({ incomingKey, id, baseUrl, model }, prevChannels) {
  const prev = Array.isArray(prevChannels) ? prevChannels : [];
  const explicit = String(incomingKey || '').trim();
  if (explicit) return explicit;

  const wantId = String(id || '').trim();
  if (wantId) {
    const byId = prev.find((ch) => ch.id === wantId && ch.apiKey);
    if (byId) return byId.apiKey;
  }

  const norm = (s) => String(s || '').trim().replace(/\/+$/, '').toLowerCase();
  const byIdentity = prev.find(
    (ch) => ch.apiKey && norm(ch.baseUrl) === norm(baseUrl) && norm(ch.model) === norm(model)
  );
  if (byIdentity) return byIdentity.apiKey;

  return '';
}

function setVisionSettings(payload = {}) {
  // 新形式：channelList = [{id?, baseUrl, model, apiKey?}]，第 0 项为主通道。
  // apiKey 留空 = 沿用旧 key（优先按 id 认通道，再退回 baseUrl+model）。
  if (Array.isArray(payload.channelList)) {
    const prev = getVisionChannelsInternal();

    const resolved = [];
    payload.channelList.forEach((raw) => {
      const baseUrl = String(raw.baseUrl || '').trim();
      const model = String(raw.model || '').trim();
      const incomingKey = String(raw.apiKey || '').trim();
      const id = String(raw.id || '').trim();
      if (!baseUrl && !model && !incomingKey) return; // 整行空，跳过
      if (!baseUrl || !model) {
        throw new Error('每个视觉通道都需要 Base URL 和 Model');
      }
      const key = resolveVisionChannelKey({ incomingKey, id, baseUrl, model }, prev);
      if (!key) {
        throw new Error(`通道「${model} @ ${baseUrl}」缺少 API Key`);
      }
      resolved.push({ baseUrl, model, apiKey: key });
    });

    if (!resolved.length) {
      setSetting('vision_base_url', null);
      setSetting('vision_model', null);
      setSetting('vision_api_key', null);
      setSetting('vision_channels', null);
      return getVisionSettingsPublic();
    }

    const primary = resolved[0];
    // 每个通道写自己的 key 实体，不再用 '-' 表示"沿用主 key"。
    // 旧写法的坑：以后主通道换了供应商，这些通道会静默跟着换成错的 key。
    // parseVisionChannelLine 仍然解析 '-'，所以库里的老数据照常读。
    const extras = resolved.slice(1).map((ch) => `${ch.baseUrl}|${ch.apiKey}|${ch.model}`);

    setSetting('vision_base_url', primary.baseUrl);
    setSetting('vision_model', primary.model);
    setSetting('vision_api_key', primary.apiKey);
    setSetting('vision_channels', extras.length ? extras.join('\n') : null);
    return getVisionSettingsPublic();
  }

  // 兼容旧形式（扁平字段 + channels 文本）
  const current = getVisionSettings();
  const baseUrl = payload.baseUrl !== undefined ? String(payload.baseUrl || '').trim() : current.baseUrl;
  const model = payload.model !== undefined ? String(payload.model || '').trim() : current.model;
  const apiKeyIncoming = payload.apiKey !== undefined ? String(payload.apiKey || '').trim() : '';
  const apiKey = apiKeyIncoming || current.apiKey || '';
  const channels = payload.channels !== undefined
    ? String(payload.channels || '').trim()
    : (current.channels || '');

  setSetting('vision_base_url', baseUrl || null);
  setSetting('vision_model', model || null);
  setSetting('vision_api_key', apiKey || null);
  setSetting('vision_channels', channels || null);
  return getVisionSettingsPublic();
}

// 只切某个通道的 model，其余字段（尤其是 key）原样保留。
// 给"模型下拉点选即生效"用：走 setVisionSettings 全量提交会连带保存
// 用户还在编辑、并不想保存的其他字段。
function setVisionChannelModel(id, model) {
  const wantId = String(id || '').trim();
  const nextModel = String(model || '').trim();
  if (!wantId) throw new Error('缺少通道 id');
  if (!nextModel) throw new Error('缺少 model');

  const list = getVisionChannelsInternal();
  const target = list.find((ch) => ch.id === wantId);
  if (!target) throw new Error(`通道 ${wantId} 不存在（可能已被改动，请刷新后重试）`);
  if (target.model === nextModel) return getVisionSettingsPublic();

  if (target.isPrimary) {
    setSetting('vision_model', nextModel);
    return getVisionSettingsPublic();
  }

  // 额外通道：整行重写（key 用内部解析后的明文，'-' 老数据在此自然落成实体 key）
  const extras = list
    .filter((ch) => !ch.isPrimary)
    .map((ch) => {
      const m = ch.id === wantId ? nextModel : ch.model;
      return `${ch.baseUrl}|${ch.apiKey}|${m}`;
    });
  setSetting('vision_channels', extras.length ? extras.join('\n') : null);
  return getVisionSettingsPublic();
}

// ---------------------------------------------------------------------------
// 面板登录：用户与会话
//
// 密码哈希本身在 auth.js 里算（scrypt），这里只负责存取——db.js 不引入 crypto，
// 保持"数据层只管数据"。会话 token 同理：调用方传进来的已经是 sha256(token)。
// ---------------------------------------------------------------------------

function hasAnyUser() {
  return Boolean(db.prepare('SELECT 1 FROM panel_users LIMIT 1').get());
}

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM panel_users WHERE username = ?').get(String(username || ''));
}

function getUserById(id) {
  return db.prepare('SELECT * FROM panel_users WHERE id = ?').get(Number(id));
}

function createUser(username, passwordHash) {
  const name = String(username || '').trim();
  if (!name) throw new Error('用户名不能为空');
  const info = db
    .prepare('INSERT INTO panel_users (username, password_hash) VALUES (?, ?)')
    .run(name, String(passwordHash));
  return getUserById(info.lastInsertRowid);
}

function updateUserPassword(userId, passwordHash) {
  db.prepare(`
    UPDATE panel_users
    SET password_hash = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(String(passwordHash), Number(userId));
  return getUserById(userId);
}

function createSession(tokenHash, userId, expiresAt, userAgent = '') {
  db.prepare(`
    INSERT INTO panel_sessions (token_hash, user_id, created_at, expires_at, user_agent)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    String(tokenHash),
    Number(userId),
    new Date().toISOString(),
    String(expiresAt),
    String(userAgent || '').slice(0, 300),
  );
  return { tokenHash, userId, expiresAt };
}

// 过期判断放在 SQL 里：ISO-8601 字符串按字典序比较等价于按时间比较，
// 省掉一次"取出来再比"的往返，也避免忘了比对时区。
function getSessionUser(tokenHash) {
  if (!tokenHash) return null;
  return db.prepare(`
    SELECT u.id, u.username, s.expires_at
    FROM panel_sessions s
    JOIN panel_users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(String(tokenHash), new Date().toISOString()) || null;
}

function deleteSession(tokenHash) {
  db.prepare('DELETE FROM panel_sessions WHERE token_hash = ?').run(String(tokenHash || ''));
}

function deleteSessionsForUser(userId, exceptTokenHash = null) {
  if (exceptTokenHash) {
    db.prepare('DELETE FROM panel_sessions WHERE user_id = ? AND token_hash != ?')
      .run(Number(userId), String(exceptTokenHash));
    return;
  }
  db.prepare('DELETE FROM panel_sessions WHERE user_id = ?').run(Number(userId));
}

function purgeExpiredSessions() {
  const info = db.prepare('DELETE FROM panel_sessions WHERE expires_at <= ?')
    .run(new Date().toISOString());
  return info.changes || 0;
}

module.exports = {
  db,
  listTasks,
  getTask,
  createTask,
  updateTask,
  applyTaskCallbackReport,
  deleteTask,
  createRun,
  updateRun,
  getRun,
  listRuns,
  listRunsByTask,
  listLatestRunPerTask,
  getSetting,
  setSetting,
  getTelegramSettings,
  getVisionSettings,
  getVisionSettingsPublic,
  getVisionChannelsInternal,
  setVisionSettings,
  setVisionChannelModel,
  resolveVisionChannelKey,
  getBrowserRuntimeSettings,
  setBrowserRuntimeSettings,
  listBrowserProfiles,
  getBrowserProfile,
  createBrowserProfile,
  updateBrowserProfile,
  deleteBrowserProfile,
  maskSecret,
  listEnvEntriesRaw,
  listEnvEntriesPublic,
  getEnvMap,
  getGlobalEnvMap,
  getProfileEnvMap,
  getTaskEnvMap,
  replaceEnvEntries,
  setTaskEnvFromParams,
  syncTaskParamsJsonFromEnv,
  migrateTaskParamsToEnvIfNeeded,
  paramsObjectToEntries,
  parseParamsJsonObject,
  isGithubCompatEnabled,
  setGithubCompatEnabled,
  isTaskParallelAllowed,
  setTaskParallelAllowed,
  hasAnyUser,
  getUserByUsername,
  getUserById,
  createUser,
  updateUserPassword,
  createSession,
  getSessionUser,
  deleteSession,
  deleteSessionsForUser,
  purgeExpiredSessions,
};
