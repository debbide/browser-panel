const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const db = require('./db');

const SCHEMA_VERSION = 1;

// 只导出"配置",不导出"运行态"。next_run_at / condition_last_* / callback_* 属于
// 后者:换台机器后它们必须由调度器和条件门重新算,带过去只会让新面板读到过期状态。
// params_json 也不导出 —— 它是 env_entries 的派生缓存,导入后用
// syncTaskParamsJsonFromEnv() 重建。
const TASK_CONFIG_COLUMNS = Object.freeze([
  'name', 'type', 'script_path', 'cron_expr', 'schedule_mode',
  'interval_min', 'interval_max', 'interval_unit',
  'daily_time_start', 'daily_time_end',
  'use_browser', 'use_persistent', 'timeout_sec',
  'condition_enabled', 'condition_json',
]);

const PROFILE_CONFIG_COLUMNS = Object.freeze([
  'name', 'user_data_dir', 'proxy', 'runtime_stack', 'locale', 'timezone_id',
]);

const CONFLICT_STRATEGIES = Object.freeze(['skip', 'overwrite', 'rename']);
const SCRIPT_EXTENSIONS = Object.freeze(['.js', '.py']);

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * 备份文件里的脚本路径来自上传内容,不可信,而面板是 root 跑的、这里要写盘。
 * 用 path.resolve 做包含性校验(与 storage-cleanup.js 的 isInside 同思路),
 * 而不是靠字符串前缀判断 —— 后者挡不住 tasks/../../etc/cron.d/x 这类构造。
 */
function sanitizeScriptPath(raw) {
  const normalized = String(raw || '').replace(/\\/g, '/').trim();
  if (!normalized) throw new Error('脚本路径不能为空');
  if (!normalized.startsWith('tasks/')) {
    throw new Error(`脚本路径必须位于 tasks/ 下: ${normalized}`);
  }
  const relative = normalized.slice('tasks/'.length);
  if (!relative || relative.startsWith('/')) {
    throw new Error(`脚本路径不合法: ${normalized}`);
  }
  const ext = path.extname(relative).toLowerCase();
  if (!SCRIPT_EXTENSIONS.includes(ext)) {
    throw new Error(`只支持 .js / .py 脚本: ${normalized}`);
  }

  const base = path.resolve(config.paths.tasksDir);
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
    throw new Error(`脚本路径越界: ${normalized}`);
  }

  return {
    relPath: `tasks/${relative}`,
    absPath: target,
    ext,
  };
}

function normalizeTaskIds(value) {
  if (value === undefined || value === null || value === '') return null;
  const list = Array.isArray(value) ? value : String(value).split(',');
  const ids = [];
  for (const item of list) {
    const id = Number(String(item).trim());
    if (!Number.isInteger(id) || id <= 0) throw new Error(`任务 id 不合法: ${item}`);
    ids.push(id);
  }
  if (!ids.length) return null;
  return [...new Set(ids)];
}

function normalizeStrategy(value, fallback = 'skip') {
  if (value === undefined || value === null || value === '') return fallback;
  const strategy = String(value).trim().toLowerCase();
  if (!CONFLICT_STRATEGIES.includes(strategy)) {
    throw new Error(`不支持的冲突策略: ${value}`);
  }
  return strategy;
}

function pick(row, columns) {
  const out = {};
  for (const col of columns) out[col] = row[col] === undefined ? null : row[col];
  return out;
}

// ---------------------------------------------------------------- 导出

/**
 * 按依赖闭包导出:选中的任务 → 它们引用的脚本 → 它们引用的浏览器配置。
 * 没被引用的脚本和 profile 不进备份文件,否则导出 1 个任务却带上一堆无关脚本,
 * 导入端还要为这些脚本处理覆盖冲突。
 */
function exportBackup({ taskIds = null, includeSecrets = false } = {}) {
  const allTasks = db.listTasks();
  const wanted = normalizeTaskIds(taskIds);

  let selected = allTasks;
  if (wanted) {
    const byId = new Map(allTasks.map((task) => [Number(task.id), task]));
    const missing = wanted.filter((id) => !byId.has(id));
    if (missing.length) throw new Error(`任务不存在: ${missing.join(', ')}`);
    selected = wanted.map((id) => byId.get(id));
  }
  if (!selected.length) throw new Error('没有可导出的任务');

  const warnings = [];
  const selectedIds = new Set(selected.map((task) => Number(task.id)));

  // 脚本平铺去重:多个任务可以共用一个脚本,平铺才能把共用关系原样带过去。
  const scripts = [];
  const seenScripts = new Set();
  for (const task of selected) {
    const raw = String(task.script_path || '').replace(/\\/g, '/');
    if (!raw || seenScripts.has(raw)) continue;
    seenScripts.add(raw);

    let resolved;
    try {
      resolved = sanitizeScriptPath(raw);
    } catch (error) {
      warnings.push(`任务「${task.name}」的脚本路径无法导出(${error.message}),已跳过脚本内容`);
      continue;
    }
    if (!fs.existsSync(resolved.absPath)) {
      warnings.push(`脚本文件不存在,未写入备份: ${resolved.relPath}`);
      continue;
    }
    const content = fs.readFileSync(resolved.absPath, 'utf8');
    scripts.push({ path: resolved.relPath, content, sha256: sha256(content) });

    // 共用脚本提醒:同机以 overwrite 导入会连带改到未选中的任务。
    const alsoUsedBy = allTasks
      .filter((other) => !selectedIds.has(Number(other.id))
        && String(other.script_path || '').replace(/\\/g, '/') === resolved.relPath)
      .map((other) => other.name);
    if (alsoUsedBy.length) {
      warnings.push(`脚本 ${resolved.relPath} 还被未选中的任务使用: ${alsoUsedBy.join('、')}`);
    }
  }

  const profileById = new Map(db.listBrowserProfiles().map((row) => [Number(row.id), row]));
  const profiles = [];
  const seenProfiles = new Set();
  for (const task of selected) {
    const profileId = Number(task.browser_profile_id);
    if (!Number.isInteger(profileId) || profileId <= 0 || seenProfiles.has(profileId)) continue;
    seenProfiles.add(profileId);
    const profile = profileById.get(profileId);
    if (!profile) {
      warnings.push(`任务「${task.name}」引用的浏览器配置已不存在(id=${profileId})`);
      continue;
    }
    profiles.push({
      ...pick(profile, PROFILE_CONFIG_COLUMNS),
      env: db.listEnvEntriesRaw('profile', Number(profile.id)).map((row) => {
        const isSecret = Boolean(row.is_secret);
        return isSecret && !includeSecrets
          ? { name: row.name, value: '', is_secret: 1, omitted: true }
          : { name: row.name, value: row.value == null ? '' : String(row.value), is_secret: isSecret ? 1 : 0 };
      }),
    });
  }

  const tasks = selected.map((task) => {
    const config_ = pick(task, TASK_CONFIG_COLUMNS);
    const profile = profileById.get(Number(task.browser_profile_id));
    const env = db.listEnvEntriesRaw('task', Number(task.id)).map((row) => {
      const isSecret = Boolean(row.is_secret);
      // 脱敏时保留变量名:导入后用户只需填值,不用回想当初配了哪些密钥。
      if (isSecret && !includeSecrets) {
        return { name: row.name, value: '', is_secret: 1, omitted: true };
      }
      return { name: row.name, value: row.value == null ? '' : String(row.value), is_secret: isSecret ? 1 : 0 };
    });
    return {
      ...config_,
      script_path: String(task.script_path || '').replace(/\\/g, '/'),
      browser_profile_name: profile ? profile.name : null,
      env,
    };
  });

  return {
    schema_version: SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    includes_secrets: Boolean(includeSecrets),
    scripts,
    browser_profiles: profiles,
    tasks,
    warnings,
  };
}

// ---------------------------------------------------------------- 解析与分析

function parseBackup(input) {
  let data = input;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      throw new Error('备份文件不是合法 JSON');
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('备份内容格式不正确');
  }
  const version = Number(data.schema_version);
  if (!Number.isInteger(version) || version <= 0) {
    throw new Error('备份文件缺少 schema_version');
  }
  if (version > SCHEMA_VERSION) {
    throw new Error(`备份文件版本(${version})高于当前面板支持的版本(${SCHEMA_VERSION}),请先更新面板`);
  }
  if (!Array.isArray(data.tasks) || !data.tasks.length) {
    throw new Error('备份文件里没有任务');
  }
  return {
    schema_version: version,
    exported_at: data.exported_at ? String(data.exported_at) : null,
    includes_secrets: Boolean(data.includes_secrets),
    scripts: Array.isArray(data.scripts) ? data.scripts : [],
    browser_profiles: Array.isArray(data.browser_profiles) ? data.browser_profiles : [],
    tasks: data.tasks,
  };
}

function allocateScriptPath(relPath, takenPaths) {
  const dir = path.posix.dirname(relPath);
  const ext = path.posix.extname(relPath);
  const base = path.posix.basename(relPath, ext);
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${dir}/${base}-${index}${ext}`;
    const resolved = sanitizeScriptPath(candidate);
    if (!fs.existsSync(resolved.absPath) && !takenPaths.has(candidate)) return candidate;
  }
  throw new Error(`无法为 ${relPath} 分配可用文件名`);
}

function allocateTaskName(name, takenNames) {
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${name} (${index})`;
    if (!takenNames.has(candidate)) return candidate;
  }
  throw new Error(`无法为任务「${name}」分配可用名称`);
}

/**
 * preview 和 import 共用这一个函数,保证用户在确认弹窗里看到的清单
 * 和实际执行的完全一致。
 */
function analyze(backup, options = {}) {
  const scriptStrategy = normalizeStrategy(options.script_strategy, 'skip');
  const taskStrategy = normalizeStrategy(options.task_strategy, 'rename');

  const existingTasks = db.listTasks();
  const existingProfiles = db.listBrowserProfiles();
  const profileByName = new Map(existingProfiles.map((row) => [String(row.name), row]));
  const takenTaskNames = new Set(existingTasks.map((row) => String(row.name)));

  const warnings = [];

  // 先定脚本:任务的 script_path 要跟着 rename 后的结果走,所以必须先解析脚本。
  const takenScriptPaths = new Set();
  const scriptPlans = [];
  const scriptPathMap = new Map();

  for (const entry of backup.scripts) {
    const resolved = sanitizeScriptPath(entry && entry.path);
    const content = String(entry.content == null ? '' : entry.content);
    const exists = fs.existsSync(resolved.absPath);
    let identical = false;
    if (exists) {
      try {
        identical = fs.readFileSync(resolved.absPath, 'utf8') === content;
      } catch {
        identical = false;
      }
    }

    const boundTasks = existingTasks
      .filter((task) => String(task.script_path || '').replace(/\\/g, '/') === resolved.relPath)
      .map((task) => task.name);

    let action;
    let finalPath = resolved.relPath;
    if (!exists) {
      action = 'create';
    } else if (identical) {
      action = 'identical';
    } else if (scriptStrategy === 'overwrite') {
      action = 'overwrite';
    } else if (scriptStrategy === 'rename') {
      action = 'rename';
      finalPath = allocateScriptPath(resolved.relPath, takenScriptPaths);
    } else {
      action = 'skip';
    }

    takenScriptPaths.add(finalPath);
    scriptPathMap.set(resolved.relPath, finalPath);
    scriptPlans.push({
      path: resolved.relPath,
      finalPath,
      action,
      content,
      exists,
      identical,
      boundTasks,
    });

    if (action === 'overwrite' && boundTasks.length) {
      warnings.push(`覆盖 ${resolved.relPath} 会同时影响已有任务: ${boundTasks.join('、')}`);
    }
  }

  const profilePlans = [];
  const seenProfileNames = new Set();
  for (const entry of backup.browser_profiles) {
    const name = String((entry && entry.name) || '').trim();
    if (!name || seenProfileNames.has(name)) continue;
    seenProfileNames.add(name);
    profilePlans.push({
      name,
      action: profileByName.has(name) ? 'reuse' : 'create',
      config: pick(entry, PROFILE_CONFIG_COLUMNS),
      env: Array.isArray(entry.env) ? entry.env : [],
    });
  }

  const taskPlans = [];
  for (const entry of backup.tasks) {
    const name = String((entry && entry.name) || '').trim() || 'Untitled Task';
    const existing = existingTasks.find((row) => String(row.name) === name) || null;

    let action = 'create';
    let finalName = name;
    if (existing) {
      if (taskStrategy === 'overwrite') {
        action = 'overwrite';
      } else if (taskStrategy === 'rename') {
        action = 'rename';
        finalName = allocateTaskName(name, takenTaskNames);
      } else {
        action = 'skip';
      }
    }
    takenTaskNames.add(finalName);

    const rawScriptPath = String((entry && entry.script_path) || '').replace(/\\/g, '/');
    const finalScriptPath = scriptPathMap.get(rawScriptPath) || rawScriptPath;
    const scriptInBackup = scriptPathMap.has(rawScriptPath);
    if (rawScriptPath && !scriptInBackup && action !== 'skip') {
      warnings.push(`任务「${name}」引用的脚本不在备份文件里: ${rawScriptPath}`);
    }

    const profileName = entry.browser_profile_name ? String(entry.browser_profile_name) : null;
    const profileMissing = Boolean(profileName)
      && !profileByName.has(profileName)
      && !seenProfileNames.has(profileName);
    if (profileMissing && action !== 'skip') {
      warnings.push(`任务「${name}」引用的浏览器配置「${profileName}」不存在,将留空`);
    }

    const env = Array.isArray(entry.env) ? entry.env : [];
    const secretsPending = env
      .filter((item) => item && (item.omitted || (Number(item.is_secret) === 1 && !String(item.value || '').length)))
      .map((item) => String(item.name));

    taskPlans.push({
      name,
      finalName,
      action,
      existingId: existing ? Number(existing.id) : null,
      scriptPath: rawScriptPath,
      finalScriptPath,
      profileName,
      profileMissing,
      secretsPending,
      config: pick(entry, TASK_CONFIG_COLUMNS),
      env,
    });
  }

  const pendingSecretCount = taskPlans
    .filter((plan) => plan.action !== 'skip')
    .reduce((sum, plan) => sum + plan.secretsPending.length, 0);
  if (pendingSecretCount) {
    warnings.push(`有 ${pendingSecretCount} 个密钥未包含在备份里,导入后需手动补填`);
  }

  return {
    schema_version: backup.schema_version,
    exported_at: backup.exported_at,
    includes_secrets: backup.includes_secrets,
    script_strategy: scriptStrategy,
    task_strategy: taskStrategy,
    scripts: scriptPlans,
    profiles: profilePlans,
    tasks: taskPlans,
    warnings,
  };
}

/** preview 用:去掉脚本正文,只留摘要,避免把整包源码再回传一遍。 */
function toPreview(plan) {
  return {
    ...plan,
    scripts: plan.scripts.map(({ content, ...rest }) => ({ ...rest, bytes: Buffer.byteLength(content, 'utf8') })),
    tasks: plan.tasks.map(({ config, env, ...rest }) => ({ ...rest, env_count: env.length })),
  };
}

// ---------------------------------------------------------------- 导入

function writeScriptFiles(plan) {
  // 先落盘再写库,并把被覆盖文件的原内容留在内存里:库那边一旦抛错就整体还原。
  // better-sqlite3 的事务保不了文件系统,顺序和 undo 都得自己安排。
  const undo = [];
  const written = [];
  try {
    for (const script of plan.scripts) {
      if (script.action === 'skip' || script.action === 'identical') continue;
      const resolved = sanitizeScriptPath(script.finalPath);
      fs.mkdirSync(path.dirname(resolved.absPath), { recursive: true });

      if (fs.existsSync(resolved.absPath)) {
        undo.push({ absPath: resolved.absPath, content: fs.readFileSync(resolved.absPath, 'utf8') });
      } else {
        undo.push({ absPath: resolved.absPath, content: null });
      }

      const tmpPath = `${resolved.absPath}.bp-import.tmp`;
      fs.writeFileSync(tmpPath, script.content, 'utf8');
      fs.renameSync(tmpPath, resolved.absPath);
      written.push(script.finalPath);
    }
  } catch (error) {
    restoreScriptFiles(undo);
    throw error;
  }
  return { undo, written };
}

function restoreScriptFiles(undo) {
  for (const item of undo.slice().reverse()) {
    try {
      if (item.content === null) fs.rmSync(item.absPath, { force: true });
      else fs.writeFileSync(item.absPath, item.content, 'utf8');
    } catch {
      // 还原已尽力,不再抛,避免掩盖原始错误
    }
  }
}

function buildTaskRow(plan, profileIdByName, existing = null) {
  const config_ = plan.config;
  const profileId = plan.profileName && profileIdByName.has(plan.profileName)
    ? profileIdByName.get(plan.profileName)
    : null;

  return {
    name: plan.finalName,
    type: config_.type === 'python' ? 'python' : 'javascript',
    script_path: plan.finalScriptPath,
    cron_expr: String(config_.cron_expr || ''),
    schedule_mode: ['fixed', 'interval', 'daily_window'].includes(config_.schedule_mode)
      ? config_.schedule_mode
      : 'fixed',
    interval_min: config_.interval_min == null ? null : Number(config_.interval_min),
    interval_max: config_.interval_max == null ? null : Number(config_.interval_max),
    interval_unit: config_.interval_unit ? String(config_.interval_unit) : null,
    daily_time_start: config_.daily_time_start ? String(config_.daily_time_start) : null,
    daily_time_end: config_.daily_time_end ? String(config_.daily_time_end) : null,
    // 运行态一律重置:导入后由调度器重新算,不继承备份里的时间点。
    next_run_at: null,
    // 导入后一律停用。否则文件一传,一批任务立刻按 cron 在新机器上开跑,
    // 而代理 / Chrome 路径 / Xvfb 可能都还没配好。
    enabled: 0,
    use_browser: Number(config_.use_browser) === 0 ? 0 : 1,
    use_persistent: Number(config_.use_persistent) === 1 ? 1 : 0,
    timeout_sec: Number(config_.timeout_sec) > 0 ? Number(config_.timeout_sec) : 300,
    params_json: existing ? (existing.params_json || '{}') : '{}',
    browser_profile_id: profileId,
    condition_enabled: Number(config_.condition_enabled) === 1 ? 1 : 0,
    condition_json: typeof config_.condition_json === 'string'
      ? (config_.condition_json || '{}')
      : JSON.stringify(config_.condition_json || {}),
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
  };
}

function normalizeEnvForImport(env) {
  const out = [];
  for (const item of env || []) {
    if (!item || !item.name) continue;
    // omitted 的密钥只有名字没有值,照原样写入 —— 前端会把它们列成"待补填"。
    out.push({
      name: String(item.name),
      value: item.value == null ? '' : String(item.value),
      is_secret: Number(item.is_secret) === 1 || item.is_secret === true ? 1 : 0,
    });
  }
  return out;
}

function importBackup(input, options = {}) {
  const backup = parseBackup(input);
  const plan = analyze(backup, options);

  const result = { created: [], overwritten: [], skipped: [], profiles_created: [], secrets_pending: [] };
  let fileState = { undo: [], written: [] };

  const runImport = db.db.transaction(() => {
    const profileIdByName = new Map(db.listBrowserProfiles().map((row) => [String(row.name), Number(row.id)]));
    for (const profile of plan.profiles) {
      if (profile.action !== 'create') continue;
      const created = db.createBrowserProfile({
        name: profile.name,
        user_data_dir: profile.config.user_data_dir || '',
        proxy: profile.config.proxy || '',
        runtime_stack: profile.config.runtime_stack || '',
        locale: profile.config.locale || '',
        timezone_id: profile.config.timezone_id || '',
      });
      profileIdByName.set(String(created.name), Number(created.id));
      db.replaceEnvEntriesTxn('profile', Number(created.id), normalizeEnvForImport(profile.env));
      result.profiles_created.push(created.name);
    }

    for (const taskPlan of plan.tasks) {
      if (taskPlan.action === 'skip') {
        result.skipped.push(taskPlan.name);
        continue;
      }

      const existing = taskPlan.existingId ? db.getTask(taskPlan.existingId) : null;
      const row = buildTaskRow(taskPlan, profileIdByName, existing);

      let task;
      if (taskPlan.action === 'overwrite' && existing) {
        task = db.updateTask(existing.id, { ...existing, ...row });
        result.overwritten.push(task.name);
      } else {
        task = db.createTask(row);
        result.created.push(task.name);
      }

      db.replaceEnvEntriesTxn('task', Number(task.id), normalizeEnvForImport(taskPlan.env));
      db.syncTaskParamsJsonFromEnv(Number(task.id));

      if (taskPlan.secretsPending.length) {
        result.secrets_pending.push({ task: task.name, names: taskPlan.secretsPending });
      }
    }

    // 文件写在事务最后一步:写盘失败会让 better-sqlite3 回滚整个事务,
    // 库这边不用手工 undo。反过来(先文件后库)则要靠尽力而为的还原兜底,更脆。
    fileState = writeScriptFiles(plan);
  });

  try {
    runImport();
  } catch (error) {
    restoreScriptFiles(fileState.undo);
    throw error;
  }

  return {
    ...result,
    scripts_written: fileState.written,
    warnings: plan.warnings,
  };
}

function buildExportFilename(date = new Date()) {
  const stamp = date.toISOString().slice(0, 19).replace(/[:T]/g, '').replace(/-/g, '');
  return `browser-panel-tasks-${stamp}.json`;
}

module.exports = {
  SCHEMA_VERSION,
  CONFLICT_STRATEGIES,
  TASK_CONFIG_COLUMNS,
  normalizeTaskIds,
  normalizeStrategy,
  exportBackup,
  parseBackup,
  analyze,
  toPreview,
  importBackup,
  buildExportFilename,
};
