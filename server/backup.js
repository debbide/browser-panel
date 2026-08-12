const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const db = require('./db');

const SCHEMA_VERSION = 4;

// --- 加密层（不引入新依赖，与 auth.js 的 scrypt 约定共用参数） ---
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;          // 派生密钥 64 字节 ⇒ 前 32 给 AES-256-GCM，后 32 保留
const AES_KEYLEN = 32;
const AES_NONCE_LEN = 12;          // GCM 推荐 12 字节
const AES_TAG_LEN = 16;

/**
 * scrypt 派生 + AES-256-GCM 加密。盐和 nonce 随机生成，输出自描述信封，
 * 格式与 auth.js 的 `hashPassword` 一致（`$` 分隔，头部标识算法）。
 *
 * 信封: "bp-enc$scrypt_n$scrypt_r$scrypt_p$salt(b64)$nonce(b64)$ciphertext(b64)"
 */
function encryptBackup(plaintext, passphrase) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(passphrase), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
  });
  const aesKey = key.subarray(0, AES_KEYLEN);
  const nonce = crypto.randomBytes(AES_NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, nonce);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'bp-enc',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    nonce.toString('base64'),
    Buffer.concat([encrypted, tag]).toString('base64'),
  ].join('$');
}

/**
 * 反向解密。返回明文字符串；密码错或信封损坏时抛 Error。
 */
function decryptBackup(envelope, passphrase) {
  try {
    const parts = String(envelope || '').split('$');
    if (parts.length !== 7 || parts[0] !== 'bp-enc') {
      throw new Error('不是合法的加密备份文件');
    }
    const [, n, r, p, saltB64, nonceB64, payloadB64] = parts;
    if (Number(n) !== SCRYPT_N || Number(r) !== SCRYPT_R || Number(p) !== SCRYPT_P) {
      throw new Error('不支持的加密参数');
    }
    const salt = Buffer.from(saltB64, 'base64');
    const nonce = Buffer.from(nonceB64, 'base64');
    if (salt.length !== 16) throw new Error('盐长度异常');
    if (nonce.length !== AES_NONCE_LEN) throw new Error('nonce 长度异常');
    const key = crypto.scryptSync(String(passphrase), salt, SCRYPT_KEYLEN, {
      N: Number(n), r: Number(r), p: Number(p),
    });
    const aesKey = key.subarray(0, AES_KEYLEN);
    const payload = Buffer.from(payloadB64, 'base64');
    if (payload.length < AES_TAG_LEN) throw new Error('密文太短');
    const ciphertext = payload.subarray(0, payload.length - AES_TAG_LEN);
    const tag = payload.subarray(payload.length - AES_TAG_LEN);
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, nonce);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (error) {
    // 密码错误时 GCM 的 final() 会抛；把异常统一成明确提示。
    throw new Error(error.message.includes('unable to auth')
      ? '密码错误或备份文件已损坏' : `解密失败: ${error.message}`);
  }
}

// 只导出"配置",不导出"运行态"。next_run_at / condition_last_* / callback_* 属于
// 后者:换台机器后它们必须由调度器和条件门重新算,带过去只会让新面板读到过期状态。
// params_json 也不导出 —— 它是 env_entries 的派生缓存,导入后用
// syncTaskParamsJsonFromEnv() 重建。
const TASK_CONFIG_COLUMNS = Object.freeze([
  'name', 'type', 'script_path', 'cron_expr', 'schedule_mode',
  'interval_min', 'interval_max', 'interval_unit',
  'daily_time_start', 'daily_time_end',
  'daily_day_min', 'daily_day_max',
  'use_browser', 'use_persistent', 'timeout_sec',
  'condition_enabled', 'condition_json',
]);

const PROFILE_CONFIG_COLUMNS = Object.freeze([
  'name', 'user_data_dir', 'proxy', 'proxy_mode', 'proxy_value', 'ruyi_fpfile', 'runtime_stack', 'locale', 'timezone_id',
]);

const BACKUP_EXCLUDED_ENV_KEYS = new Set([
  'BROWSER_PROXY',
  'BROWSER_PROXY_MODE',
  'BROWSER_PROXY_VALUE',
  'BROWSER_RUYI_FPFILE',
  'BROWSER_RUNTIME_STACK',
  'PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
]);

function isBackupExcludedEnvKey(name) {
  return BACKUP_EXCLUDED_ENV_KEYS.has(String(name || '').trim().toUpperCase());
}

function filterBackupEnvEntries(entries) {
  return (Array.isArray(entries) ? entries : []).filter((row) => !isBackupExcludedEnvKey(row && row.name));
}

const CONFLICT_STRATEGIES = Object.freeze(['skip', 'overwrite', 'rename']);
const SCRIPT_EXTENSIONS = Object.freeze(['.js', '.py']);

// 附加文件的排除项与上限。上限是防呆:随手把一个装满数据的目录声明成附加模块,
// 备份文件会大到没法用,这里宁可截断并明确告警,也不静默打包。
const ASSET_EXCLUDED_NAMES = new Set(['__pycache__', 'node_modules', '.git', '.venv', 'venv']);
const ASSET_MAX_FILES = 400;
const ASSET_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * 备份文件里的路径来自上传内容,不可信,而面板是 root 跑的、这里要写盘。
 * 用 path.resolve 做包含性校验(与 storage-cleanup.js 的 isInside 同思路),
 * 而不是靠字符串前缀判断 —— 后者挡不住 tasks/../../etc/cron.d/x 这类构造。
 */
function resolveUnderTasks(raw, label = '路径') {
  const normalized = String(raw || '').replace(/\\/g, '/').trim().replace(/\/+$/, '');
  if (!normalized) throw new Error(`${label}不能为空`);
  if (!normalized.startsWith('tasks/')) {
    throw new Error(`${label}必须位于 tasks/ 下: ${normalized}`);
  }
  const relative = normalized.slice('tasks/'.length);
  if (!relative || relative.split('/').some((seg) => !seg || seg === '.' || seg === '..')) {
    throw new Error(`${label}不合法: ${normalized}`);
  }

  const base = path.resolve(config.paths.tasksDir);
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
    throw new Error(`${label}越界: ${normalized}`);
  }

  return { relPath: `tasks/${relative}`, absPath: target, relative };
}

function sanitizeScriptPath(raw) {
  const resolved = resolveUnderTasks(raw, '脚本路径');
  const ext = path.extname(resolved.relative).toLowerCase();
  if (!SCRIPT_EXTENSIONS.includes(ext)) {
    throw new Error(`只支持 .js / .py 脚本: ${resolved.relPath}`);
  }
  return { relPath: resolved.relPath, absPath: resolved.absPath, ext };
}

/**
 * 附加文件不限扩展名 —— 模块目录里常有 README、json 配置这类非脚本文件,
 * 卡 .js/.py 会把它们漏掉。安全边界仍然只有一条:必须落在 tasks/ 内。
 */
function sanitizeAssetPath(raw) {
  const resolved = resolveUnderTasks(raw, '附加路径');
  for (const seg of resolved.relative.split('/')) {
    if (seg.startsWith('.')) throw new Error(`附加路径不能包含隐藏文件或目录: ${resolved.relPath}`);
    if (ASSET_EXCLUDED_NAMES.has(seg)) throw new Error(`附加路径不能包含 ${seg}: ${resolved.relPath}`);
  }
  return resolved;
}

/**
 * 任务声明的附加路径。数据库里存 JSON 字符串,前端传数组,这里都接受。
 * 统一规整成 "tasks/xxx" 形式;整个 tasks 目录不允许声明 —— 备份也用来把
 * 单个任务分享给别人,打包全部脚本等于把无关任务一起送出去。
 */
function normalizeExtraPaths(value) {
  let list = value;
  if (typeof list === 'string') {
    const text = list.trim();
    if (!text) return [];
    try {
      list = JSON.parse(text);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const raw = String(item == null ? '' : item)
      .replace(/\\/g, '/').trim().replace(/^\/+/, '').replace(/\/+$/, '');
    if (!raw || raw === 'tasks') continue;
    const rel = raw.startsWith('tasks/') ? raw : `tasks/${raw}`;
    if (seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

/** 展开一个附加路径:文件返回自身,目录递归展开。 */
function collectAssetFiles(absPath, relPath) {
  const out = [];
  const stat = fs.statSync(absPath);
  if (stat.isFile()) return [{ absPath, relPath }];
  if (!stat.isDirectory()) return out;
  const walk = (dirAbs, dirRel) => {
    for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name.endsWith('.pyc')) continue;
      if (ASSET_EXCLUDED_NAMES.has(entry.name)) continue;
      const childAbs = path.join(dirAbs, entry.name);
      const childRel = `${dirRel}/${entry.name}`;
      if (entry.isDirectory()) walk(childAbs, childRel);
      else if (entry.isFile()) out.push({ absPath: childAbs, relPath: childRel });
    }
  };
  walk(absPath, relPath);
  return out;
}

/**
 * 附加文件不保证是文本(模块目录里可能有图片、字体之类的测试素材),
 * 按 utf8 读会损坏内容。能无损往返的存文本,其余转 base64。
 */
function readAssetContent(absPath) {
  const buf = fs.readFileSync(absPath);
  const text = buf.toString('utf8');
  if (!buf.includes(0) && Buffer.from(text, 'utf8').equals(buf)) {
    return { content: text, encoding: 'utf8', bytes: buf.length };
  }
  return { content: buf.toString('base64'), encoding: 'base64', bytes: buf.length };
}

function assetToBuffer(entry) {
  return entry.encoding === 'base64'
    ? Buffer.from(String(entry.content || ''), 'base64')
    : Buffer.from(String(entry.content == null ? '' : entry.content), 'utf8');
}

// import 语句里的顶层名字。缩进的 import 也要匹配(函数内部导入很常见),
// 所以用 multiline 而不是锚在行首非空白。
const PY_IMPORT_RE = /^[ \t]*(?:from[ \t]+([.\w]+)[ \t]+import|import[ \t]+([\w.,\s]+))/gm;
const JS_REQUIRE_RE = /(?:require\(|from)\s*['"]([^'"]+)['"]/g;

function pyImportRoots(source) {
  const roots = new Set();
  let match;
  PY_IMPORT_RE.lastIndex = 0;
  while ((match = PY_IMPORT_RE.exec(source)) !== null) {
    const targets = match[1]
      ? [match[1]]
      : String(match[2] || '').split(',');
    for (const target of targets) {
      // 相对导入(from .x import y)指向同包内部,由包目录整体带走,不用单独解析。
      const name = String(target).trim().split(/\s+as\s+/)[0].trim();
      if (!name || name.startsWith('.')) continue;
      const root = name.split('.')[0].trim();
      if (root) roots.add(root);
    }
  }
  return roots;
}

function jsRequireRoots(source) {
  const roots = new Set();
  let match;
  JS_REQUIRE_RE.lastIndex = 0;
  while ((match = JS_REQUIRE_RE.exec(source)) !== null) {
    const spec = String(match[1] || '').trim();
    // 只关心项目内的相对引用,npm 包由 node_modules 提供,不进备份。
    if (!spec.startsWith('.')) continue;
    const cleaned = spec.replace(/^\.+\//, '').replace(/^\.+$/, '');
    const root = cleaned.split('/')[0];
    if (root) roots.add(root);
  }
  return roots;
}

/**
 * 扫描主脚本引用到的本地模块,只作为前端的预填建议 —— 最终以用户勾选为准。
 *
 * 静态分析看不见动态导入(比如脚本自己改 sys.path 再 import),所以这里不追求
 * 完备,漏掉的由用户手工补;反过来也不会把 npm / pip 上的第三方包算进来。
 */
function scanTaskDependencies(scriptPath) {
  const entry = sanitizeScriptPath(scriptPath);
  if (!fs.existsSync(entry.absPath)) throw new Error(`脚本文件不存在: ${entry.relPath}`);

  const tasksRoot = path.resolve(config.paths.tasksDir);
  const found = new Map();        // relPath -> {path, type}
  const visited = new Set([entry.absPath]);
  const queue = [entry.absPath];

  const resolveRoot = (root) => {
    for (const candidate of [root, `${root}.py`, `${root}.js`]) {
      const abs = path.resolve(tasksRoot, candidate);
      if (abs !== tasksRoot && !abs.startsWith(`${tasksRoot}${path.sep}`)) continue;
      if (!fs.existsSync(abs)) continue;
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) return { relPath: `tasks/${candidate}`, absPath: abs, type: 'dir' };
      if (stat.isFile() && abs !== entry.absPath) {
        return { relPath: `tasks/${candidate}`, absPath: abs, type: 'file' };
      }
    }
    return null;
  };

  while (queue.length) {
    const current = queue.shift();
    let source = '';
    try {
      source = fs.readFileSync(current, 'utf8');
    } catch {
      continue;
    }
    const ext = path.extname(current).toLowerCase();
    const roots = ext === '.js' ? jsRequireRoots(source) : pyImportRoots(source);
    for (const root of roots) {
      if (ASSET_EXCLUDED_NAMES.has(root) || root.startsWith('.')) continue;
      const hit = resolveRoot(root);
      if (!hit || found.has(hit.relPath)) continue;
      found.set(hit.relPath, { path: hit.relPath, type: hit.type });
      // 顺着新发现的模块继续往下找:模块自己也可能 import 别的本地模块。
      const files = hit.type === 'dir'
        ? collectAssetFiles(hit.absPath, hit.relPath)
        : [{ absPath: hit.absPath, relPath: hit.relPath }];
      for (const file of files) {
        const fileExt = path.extname(file.absPath).toLowerCase();
        if (fileExt !== '.py' && fileExt !== '.js') continue;
        if (visited.has(file.absPath)) continue;
        visited.add(file.absPath);
        queue.push(file.absPath);
      }
    }
  }

  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
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
 * 导出备份。
 *
 * 按依赖闭包导出:选中的任务 → 它们引用的脚本 → 它们引用的浏览器配置。
 * 没被引用的脚本和 profile 不进备份文件,否则导出 1 个任务却带上一堆无关脚本,
 * 导入端还要为这些脚本处理覆盖冲突。
 *
 * 模式由 passphrase 控制：
 *   - passphrase 为空 ⇒ "仅名称"模式：去掉所有环境变量值、不导出代理、
 *     user_data_dir 置空，适合分享任务结构。
 *   - passphrase 非空 ⇒ "加密完整"模式：带着所有配置和密钥，整体 AES-256-GCM
 *     加密后返回，杜绝隐私泄露。
 *
 * 无论哪种模式，proxy 都不导出、user_data_dir 都置空 —— 代理凭据是本机资产，
 * 换机必然要重配；user_data_dir 是本机绝对路径，带过去也没意义。
 *
 * 返回 { data, header } — data 是输出的字符串，header 是发给前端的元信息
 * （Content-Disposition 文件名里需要加密标记）。
 */
function exportBackup({ taskIds = null, passphrase = null } = {}) {
  const encrypt = Boolean(passphrase);
  if (encrypt && String(passphrase).length < 8) {
    throw new Error('加密密码至少需要 8 个字符');
  }
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

    const alsoUsedBy = allTasks
      .filter((other) => !selectedIds.has(Number(other.id))
        && String(other.script_path || '').replace(/\\/g, '/') === resolved.relPath)
      .map((other) => other.name);
    if (alsoUsedBy.length) {
      warnings.push(`脚本 ${resolved.relPath} 还被未选中的任务使用: ${alsoUsedBy.join('、')}`);
    }
  }

  // 附加模块:只带选中任务自己声明的路径。备份也用来把单个任务发给别人,
  // 所以这里绝不能整包 tasks/ —— 那等于把无关脚本一起送出去。
  const assets = [];
  const seenAssets = new Set();
  let assetBytes = 0;
  let assetTruncated = false;
  for (const task of selected) {
    for (const rawPath of normalizeExtraPaths(task.extra_paths)) {
      let resolved;
      try {
        resolved = sanitizeAssetPath(rawPath);
      } catch (error) {
        warnings.push(`任务「${task.name}」的附加路径无法导出(${error.message}),已跳过`);
        continue;
      }
      if (!fs.existsSync(resolved.absPath)) {
        warnings.push(`附加路径不存在,未写入备份: ${resolved.relPath}`);
        continue;
      }
      let files;
      try {
        files = collectAssetFiles(resolved.absPath, resolved.relPath);
      } catch (error) {
        warnings.push(`附加路径读取失败(${error.message}): ${resolved.relPath}`);
        continue;
      }
      if (!files.length) {
        warnings.push(`附加路径是空目录,未写入备份: ${resolved.relPath}`);
        continue;
      }
      for (const file of files) {
        if (seenAssets.has(file.relPath)) continue;
        if (assets.length >= ASSET_MAX_FILES || assetBytes >= ASSET_MAX_TOTAL_BYTES) {
          assetTruncated = true;
          continue;
        }
        seenAssets.add(file.relPath);
        const read = readAssetContent(file.absPath);
        assetBytes += read.bytes;
        assets.push({
          path: file.relPath,
          content: read.content,
          encoding: read.encoding,
          sha256: sha256(read.content),
        });
      }
    }
  }
  if (assetTruncated) {
    warnings.push(`附加文件超出上限(${ASSET_MAX_FILES} 个 / ${Math.round(ASSET_MAX_TOTAL_BYTES / 1024 / 1024)}MB),超出部分未写入备份`);
  }

  // 浏览器配置整个不导出:它承载的就是固定数据目录和代理凭据这两样本机资产,
  // 换机或分享给别人都必须重配。任务统一以临时模式落地(见下面的 use_persistent)。
  const profiles = [];

  const taskGroups = db.listTaskGroups();
  const groupById = new Map(taskGroups.map((group) => [Number(group.id), group]));
  const selectedGroupIds = new Set(selected
    .map((task) => Number(task.group_id))
    .filter((id) => Number.isInteger(id) && groupById.has(id)));
  const exportedGroups = taskGroups
    .filter((group) => wanted === null || selectedGroupIds.has(Number(group.id)))
    .map((group) => ({ name: group.name }));

  const tasks = selected.map((task) => {
    const config_ = pick(task, TASK_CONFIG_COLUMNS);
    const env = filterBackupEnvEntries(db.listEnvEntriesRaw('task', Number(task.id))).map((row) => {
      if (encrypt) {
        return { name: row.name, value: row.value == null ? '' : String(row.value), is_secret: row.is_secret ? 1 : 0 };
      }
      // 仅名称模式：所有环境变量只保留变量名
      return { name: row.name, value: '', is_secret: row.is_secret ? 1 : 0 };
    });
    if (Number(task.use_persistent) === 1) {
      warnings.push(`任务「${task.name}」原为持久模式,导出后按临时模式落地,固定目录和代理需在目标机重配`);
    }
    return {
      ...config_,
      // 固定目录和代理不进备份,所以绑定关系也不能进 —— 否则导入端会拿到一个
      // 指向空目录、没有代理的持久配置,跑起来行为和源机不一致。
      use_persistent: 0,
      browser_profile_name: null,
      script_path: String(task.script_path || '').replace(/\\/g, '/'),
      extra_paths: normalizeExtraPaths(task.extra_paths),
      task_group_name: groupById.get(Number(task.group_id))?.name || null,
      env,
    };
  });

  const payload = {
    schema_version: SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    encrypted: encrypt,
    names_only: !encrypt,
    scripts,
    assets,
    browser_profiles: profiles,
    task_groups: exportedGroups,
    tasks,
    warnings,
  };

  if (encrypt) {
    const plaintext = JSON.stringify(payload, null, 2);
    const envelope = encryptBackup(plaintext, passphrase);
    return {
      data: envelope,
      header: {
        encrypted: true,
        allTasks: wanted === null,
        taskCount: selected.length,
        taskName: selected.length === 1 ? selected[0].name : '',
      },
    };
  }

  return {
    data: JSON.stringify(payload, null, 2),
    header: {
      encrypted: false,
      allTasks: wanted === null,
      taskCount: selected.length,
      taskName: selected.length === 1 ? selected[0].name : '',
    },
  };
}

// ---------------------------------------------------------------- 解析与分析

/** 加密备份的信封是一整行 "bp-enc$..." 字符串，不是 JSON。 */
function isEncryptedEnvelope(input) {
  return typeof input === 'string' && input.trimStart().startsWith('bp-enc$');
}

/**
 * 解析备份内容。
 *
 * input 可以是：
 *   - 加密信封字符串（"bp-enc$..."）—— 此时必须给 passphrase
 *   - JSON 字符串
 *   - 已经 parse 好的对象
 *
 * schema_version 2 起 `encrypted` 取代了 v1 的 `includes_secrets`。v1 文件仍可导入：
 * 它的 includes_secrets 语义等价于"值都在明文里"，所以按未加密的完整备份处理。
 */
function parseBackup(input, { passphrase = null } = {}) {
  let data = input;

  if (isEncryptedEnvelope(data)) {
    if (!passphrase) throw new Error('这是加密备份文件，请输入导出时设置的密码');
    data = decryptBackup(data.trim(), passphrase);
  }

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

  // v1 → v2：includes_secrets 只表示"密钥值有没有跟着走"，那种文件从不加密。
  const encrypted = version >= 2
    ? Boolean(data.encrypted)
    : false;
  const namesOnly = version >= 2 && !encrypted;

  return {
    schema_version: version,
    exported_at: data.exported_at ? String(data.exported_at) : null,
    encrypted,
    names_only: namesOnly,
    scripts: Array.isArray(data.scripts) ? data.scripts : [],
    assets: version >= 4 && Array.isArray(data.assets) ? data.assets : [],
    browser_profiles: Array.isArray(data.browser_profiles) ? data.browser_profiles : [],
    task_groups: version >= 3 && Array.isArray(data.task_groups) ? data.task_groups : [],
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

  // 附加文件不跟着 rename 走:模块目录一旦改名,脚本里的 import 就断了。
  // 所以只有覆盖和跳过两种结果 —— 覆盖时沿用脚本策略,其余一律保留本地版本。
  const assetPlans = [];
  const seenAssetPaths = new Set();
  for (const entry of backup.assets) {
    const resolved = sanitizeAssetPath(entry && entry.path);
    if (seenAssetPaths.has(resolved.relPath)) continue;
    seenAssetPaths.add(resolved.relPath);
    const encoding = entry && entry.encoding === 'base64' ? 'base64' : 'utf8';
    const content = String(entry && entry.content == null ? '' : entry.content);
    const buffer = assetToBuffer({ content, encoding });
    const exists = fs.existsSync(resolved.absPath);
    let identical = false;
    if (exists) {
      try {
        identical = fs.readFileSync(resolved.absPath).equals(buffer);
      } catch {
        identical = false;
      }
    }

    let action;
    if (!exists) action = 'create';
    else if (identical) action = 'identical';
    else if (scriptStrategy === 'overwrite') action = 'overwrite';
    else action = 'skip';

    assetPlans.push({
      path: resolved.relPath,
      action,
      content,
      encoding,
      bytes: buffer.length,
      exists,
      identical,
    });
  }
  const assetConflicts = assetPlans.filter((plan) => plan.action === 'skip');
  if (assetConflicts.length) {
    warnings.push(`有 ${assetConflicts.length} 个附加文件与本地已有版本不一致,已保留本地版本(脚本策略选"覆盖"才会用备份里的版本)`);
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

  const existingGroups = db.listTaskGroups();
  const groupByName = new Map(existingGroups.map((row) => [String(row.name), row]));
  const groupPlans = [];
  const seenGroupNames = new Set();
  for (const entry of backup.task_groups) {
    const name = String((entry && entry.name) || '').trim();
    if (!name || name === '未分组' || name.length > 60 || seenGroupNames.has(name)) continue;
    seenGroupNames.add(name);
    groupPlans.push({ name, action: groupByName.has(name) ? 'reuse' : 'create' });
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

    const groupName = backup.schema_version >= 3 && entry.task_group_name
      ? String(entry.task_group_name).trim()
      : null;
    const groupMissing = Boolean(groupName)
      && !groupByName.has(groupName)
      && !seenGroupNames.has(groupName);
    if (groupMissing && action !== 'skip') {
      warnings.push(`任务「${name}」引用的分组「${groupName}」不在备份文件里,将移至未分组`);
    }

    const extraPaths = backup.schema_version >= 4 ? normalizeExtraPaths(entry.extra_paths) : [];
    const missingExtras = extraPaths.filter((rel) => !seenAssetPaths.has(rel)
      && ![...seenAssetPaths].some((asset) => asset.startsWith(`${rel}/`)));
    if (missingExtras.length && action !== 'skip') {
      warnings.push(`任务「${name}」声明的附加路径不在备份文件里: ${missingExtras.join('、')}`);
    }

    const env = Array.isArray(entry.env) ? entry.env : [];
    // v2 仅名称模式: 所有变量值都是空的，导入后都需要补填。
    // v1 select-secrets 模式: 只有标记了 omitted 的才缺值。
    // encrypted 模式: 值都在，不需要补。
    const secretsPending = env
      .filter((item) => {
        if (!item || !item.name) return false;
        if (backup.encrypted) return false;            // 密文备份，值都在
        if (backup.names_only) return true;            // 仅名称模式，包括原本就为空的变量
        return item.omitted || (Number(item.is_secret) === 1 && !String(item.value || '').length);  // v1
      })
      .map((item) => String(item.name));

    taskPlans.push({
      name,
      finalName,
      action,
      existingId: existing ? Number(existing.id) : null,
      scriptPath: rawScriptPath,
      finalScriptPath,
      extraPaths,
      profileName,
      profileMissing,
      groupName,
      groupMissing,
      preserveExistingGroup: backup.schema_version < 3 && action === 'overwrite',
      // v3 及更早的备份里没有附加路径这个概念,覆盖时保留本地已有的声明,
      // 否则用旧备份覆盖一次就把用户配好的附加模块清空了。
      preserveExistingExtraPaths: backup.schema_version < 4 && action === 'overwrite',
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
    encrypted: backup.encrypted,
    names_only: backup.names_only,
    script_strategy: scriptStrategy,
    task_strategy: taskStrategy,
    scripts: scriptPlans,
    assets: assetPlans,
    profiles: profilePlans,
    groups: groupPlans,
    tasks: taskPlans,
    warnings,
  };
}

/** preview 用:去掉脚本正文,只留摘要,避免把整包源码再回传一遍。 */
function toPreview(plan) {
  return {
    ...plan,
    scripts: plan.scripts.map(({ content, ...rest }) => ({ ...rest, bytes: Buffer.byteLength(content, 'utf8') })),
    assets: plan.assets.map(({ content, encoding, ...rest }) => rest),
    tasks: plan.tasks.map(({ config, env, ...rest }) => ({ ...rest, env_count: env.length })),
  };
}

// ---------------------------------------------------------------- 导入

function writeScriptFiles(plan) {
  // 先落盘再写库,并把被覆盖文件的原内容留在内存里:库那边一旦抛错就整体还原。
  // better-sqlite3 的事务保不了文件系统,顺序和 undo 都得自己安排。
  const undo = [];
  const written = [];
  const assetsWritten = [];
  const writeOne = (relPath, absPath, buffer) => {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    if (fs.existsSync(absPath)) {
      undo.push({ absPath, content: fs.readFileSync(absPath) });
    } else {
      undo.push({ absPath, content: null });
    }
    const tmpPath = `${absPath}.bp-import.tmp`;
    fs.writeFileSync(tmpPath, buffer);
    fs.renameSync(tmpPath, absPath);
  };
  try {
    for (const script of plan.scripts) {
      if (script.action === 'skip' || script.action === 'identical') continue;
      const resolved = sanitizeScriptPath(script.finalPath);
      writeOne(script.finalPath, resolved.absPath, Buffer.from(script.content, 'utf8'));
      written.push(script.finalPath);
    }
    for (const asset of plan.assets || []) {
      if (asset.action === 'skip' || asset.action === 'identical') continue;
      const resolved = sanitizeAssetPath(asset.path);
      writeOne(asset.path, resolved.absPath, assetToBuffer(asset));
      assetsWritten.push(asset.path);
    }
  } catch (error) {
    restoreScriptFiles(undo);
    throw error;
  }
  return { undo, written, assetsWritten };
}

function restoreScriptFiles(undo) {
  for (const item of undo.slice().reverse()) {
    try {
      if (item.content === null) fs.rmSync(item.absPath, { force: true });
      // content 是 Buffer(附加文件可能是二进制),不能按 utf8 写回。
      else fs.writeFileSync(item.absPath, item.content);
    } catch {
      // 还原已尽力,不再抛,避免掩盖原始错误
    }
  }
}

function buildTaskRow(plan, profileIdByName, groupIdByName, existing = null) {
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
    daily_day_min: config_.daily_day_min == null ? null : Number(config_.daily_day_min),
    daily_day_max: config_.daily_day_max == null ? null : Number(config_.daily_day_max),
    // 运行态一律重置:导入后由调度器重新算,不继承备份里的时间点。
    next_run_at: null,
    // 导入后一律停用。否则文件一传,一批任务立刻按 cron 在新机器上开跑,
    // 而代理 / Chrome 路径 / Xvfb 可能都还没配好。
    enabled: 0,
    use_browser: Number(config_.use_browser) === 0 ? 0 : 1,
    // 固定数据目录和代理都不进备份,所以导入后一律临时模式 —— 旧版备份里可能
    // 还带着 use_persistent=1,照搬会指向一个目标机上并不存在的目录。
    use_persistent: 0,
    timeout_sec: Number(config_.timeout_sec) > 0 ? Number(config_.timeout_sec) : 300,
    params_json: existing ? (existing.params_json || '{}') : '{}',
    extra_paths: plan.preserveExistingExtraPaths && existing
      ? (existing.extra_paths || '[]')
      : JSON.stringify(plan.extraPaths || []),
    browser_profile_id: profileId,
    group_id: plan.preserveExistingGroup && existing
      ? (existing.group_id || null)
      : (plan.groupName && !plan.groupMissing ? (groupIdByName.get(plan.groupName) || null) : null),
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
    if (!item || !item.name || isBackupExcludedEnvKey(item.name)) continue;
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
  const backup = parseBackup(input, { passphrase: options.passphrase });
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
        proxy: '',
        proxy_mode: 'inherit',
        proxy_value: '',
        ruyi_fpfile: '',
        runtime_stack: profile.config.runtime_stack || '',
        locale: profile.config.locale || '',
        timezone_id: profile.config.timezone_id || '',
      });
      profileIdByName.set(String(created.name), Number(created.id));
      db.replaceEnvEntriesTxn('profile', Number(created.id), normalizeEnvForImport(profile.env));
      result.profiles_created.push(created.name);
    }

    const groupIdByName = new Map(db.listTaskGroups().map((row) => [String(row.name), Number(row.id)]));
    for (const group of plan.groups) {
      if (group.action !== 'create') continue;
      const created = db.createTaskGroup(group.name);
      groupIdByName.set(String(created.name), Number(created.id));
    }

    for (const taskPlan of plan.tasks) {
      if (taskPlan.action === 'skip') {
        result.skipped.push(taskPlan.name);
        continue;
      }

      const existing = taskPlan.existingId ? db.getTask(taskPlan.existingId) : null;
      const row = buildTaskRow(taskPlan, profileIdByName, groupIdByName, existing);

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
    assets_written: fileState.assetsWritten || [],
    warnings: plan.warnings,
  };
}

function sanitizeExportFilenamePart(value, fallback = 'task') {
  const sanitized = String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80);
  return sanitized || fallback;
}

function buildExportFilename(date = new Date(), {
  encrypted = false,
  allTasks = false,
  taskCount = 0,
  taskName = '',
} = {}) {
  const stamp = date.toISOString().slice(0, 19).replace(/[:T]/g, '').replace(/-/g, '');
  const label = taskName
    ? sanitizeExportFilenamePart(taskName)
    : (allTasks ? 'all-tasks' : `${Math.max(1, Number(taskCount) || 1)}-tasks`);
  const extension = encrypted ? 'bpenc' : 'json';
  return `browser-panel-${label}-${stamp}.${extension}`;
}

module.exports = {
  SCHEMA_VERSION,
  CONFLICT_STRATEGIES,
  TASK_CONFIG_COLUMNS,
  ASSET_EXCLUDED_NAMES,
  normalizeTaskIds,
  normalizeStrategy,
  normalizeExtraPaths,
  scanTaskDependencies,
  exportBackup,
  parseBackup,
  isEncryptedEnvelope,
  encryptBackup,
  decryptBackup,
  analyze,
  toPreview,
  importBackup,
  buildExportFilename,
  sanitizeExportFilenamePart,
};
