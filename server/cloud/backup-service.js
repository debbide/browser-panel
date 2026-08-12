/**
 * 云端备份编排：备份 / 列表 / 预览 / 恢复 / 轮转 / 定时。
 *
 * object key 方案：
 *   手动  <prefix>/manual/<label>-<stamp>.bpsnap   （label 是用户起的自定义名称）
 *   自动  <prefix>/auto/panel-snapshot-auto-<stamp>.bpsnap
 *   stamp 为 UTC YYYYMMDDHHMMSS，保证 key 字典序即时间序，轮转按 lastModified 兜底。
 *
 * 并发锁：一次只允许一个备份或恢复在跑（busyOp），否则抛 code=operation_in_progress，
 * 由 routes 映射成 409。定时任务与恢复共用这把锁 —— 恢复要关库换文件，绝不能撞上备份。
 *
 * 密码悖论的处理：无人值守要求密码可读，所以支持 PANEL_S3_BACKUP_PASSPHRASE 环境变量
 * （写在 .env.panel，而 .env.panel 不在快照里），优先级高于 app_settings 里的存值。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const config = require('../../config');
const db = require('../db');
const scheduler = require('../scheduler');
const { sanitizeExportFilenamePart } = require('../backup');
const { createS3Client } = require('./s3-client');
const { createSnapshot, restoreSnapshot, peekManifest } = require('./snapshot');

const DEFAULT_PREFIX = 'panel-backups';
const DEFAULT_RETENTION = 7;
const TICK_MS = 60 * 1000;
const SERVICE_NAME = 'browser-automation-panel';

let busyOp = null;        // 'backup' | 'restore'
let timerHandle = null;
// 由 index.js 注入的「关库 + 换文件」回调。恢复必须关掉 better-sqlite3 后才能动 app.db，
// 而关库涉及 scheduler/events/warp 的停机序列，那是 index.js 的职责，service 不碰。
let performRestoreSwap = null;

function setPerformRestoreSwap(fn) {
  performRestoreSwap = typeof fn === 'function' ? fn : null;
}

function opInProgress() {
  const error = new Error('已有备份/恢复操作在进行中，请稍候');
  error.code = 'operation_in_progress';
  return error;
}

function requireFields(settings, names, what) {
  const missing = names.filter((n) => !String(settings[n] || '').trim());
  if (missing.length) {
    throw new Error(`云端备份缺少配置: ${missing.join(', ')}（${what}需要）`);
  }
}

function getPassphrase(settings) {
  const envPass = String(process.env.PANEL_S3_BACKUP_PASSPHRASE || '').trim();
  if (envPass) return envPass;
  return String(settings.passphrase || '').trim();
}

function buildClient(settings) {
  return createS3Client({
    endpoint: settings.endpoint,
    region: settings.region || 'us-east-1',
    bucket: settings.bucket,
    accessKey: settings.accessKey,
    secretKey: settings.secretKey,
    token: settings.token,
    proxy: settings.proxy,
    pathStyle: settings.pathStyle !== false,
  });
}

function normalizePrefix(value) {
  return String(value || DEFAULT_PREFIX).trim().replace(/^\/+|\/+$/g, '');
}

function buildStamp(date = new Date()) {
  return date.toISOString().slice(0, 19).replace(/[:T]/g, '').replace(/-/g, '');
}

function buildObjectKey(settings, { trigger, label = '' }) {
  const prefix = normalizePrefix(settings.prefix);
  const stamp = buildStamp();
  if (trigger === 'manual') {
    const safe = sanitizeExportFilenamePart(label, 'backup');
    return `${prefix}/manual/${safe}-${stamp}.bpsnap`;
  }
  return `${prefix}/auto/panel-snapshot-auto-${stamp}.bpsnap`;
}

function displayName(key) {
  return String(key).split('/').pop() || String(key);
}

// --- 备份 ---

async function runCloudBackup(trigger = 'manual', { label = '' } = {}) {
  if (busyOp) throw opInProgress();
  const settings = db.getS3BackupSettings();
  requireFields(settings, ['endpoint', 'bucket', 'accessKey', 'secretKey'], `${trigger} 备份`);
  const passphrase = getPassphrase(settings);
  if (!passphrase) throw new Error('尚未设置备份密码（设置页或 PANEL_S3_BACKUP_PASSPHRASE 环境变量）');

  const client = buildClient(settings);
  const key = buildObjectKey(settings, { trigger, label });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpsnap-out-'));
  busyOp = 'backup';
  try {
    const outPath = path.join(dir, path.basename(key));
    const { size, manifest } = await createSnapshot({
      outPath,
      passphrase,
      meta: { trigger, label: trigger === 'manual' && label ? label : null },
    });

    await client.putObject({ key, filePath: outPath });

    const warnings = await rotateRemote(settings, client);

    if (trigger === 'auto') {
      scheduleNextAuto(settings);
    }

    return {
      ok: true,
      key,
      name: displayName(key),
      size,
      createdAt: manifest.created_at,
      panelVersion: manifest.panel_version,
      counts: manifest.counts,
      warnings,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    busyOp = null;
  }
}

/** 保留最新 N 份，删除更老的；把删了哪些写进日志并作为 warnings 返回。 */
async function rotateRemote(settings, client) {
  const retention = Math.max(1, Number(settings.retention) || DEFAULT_RETENTION);
  const prefix = normalizePrefix(settings.prefix);
  const objects = (await client.listObjects({ prefix, maxKeys: 1000 }))
    .filter((o) => String(o.key).endsWith('.bpsnap'))
    .sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));

  const warnings = [];
  const deleted = [];
  for (const obj of objects.slice(retention)) {
    try {
      await client.deleteObject({ key: obj.key });
      deleted.push(obj.key);
    } catch (error) {
      warnings.push(`删除过期备份失败 ${obj.key}: ${error.message}`);
    }
  }
  if (deleted.length) {
    const log = `[cloud-backup] 轮转删除 ${deleted.length} 个旧备份（保留 ${retention}）: ${deleted.join(', ')}`;
    console.log(log);
    warnings.push(log);
  }
  return warnings;
}

// --- 列表 / 预览 / 恢复 ---

async function listRemoteBackups() {
  const settings = db.getS3BackupSettings();
  requireFields(settings, ['endpoint', 'bucket', 'accessKey', 'secretKey'], '列表');
  const client = buildClient(settings);
  const prefix = normalizePrefix(settings.prefix);
  const objects = (await client.listObjects({ prefix, maxKeys: 1000 }))
    .filter((o) => String(o.key).endsWith('.bpsnap'))
    .sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
  return objects.map((o) => ({
    key: o.key,
    name: displayName(o.key),
    size: o.size,
    lastModified: o.lastModified,
  }));
}

async function previewRemoteBackup(key) {
  const settings = db.getS3BackupSettings();
  requireFields(settings, ['endpoint', 'bucket', 'accessKey', 'secretKey'], '预览');
  const passphrase = getPassphrase(settings);
  if (!passphrase) throw new Error('尚未设置备份密码，无法预览');

  const client = buildClient(settings);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpsnap-preview-'));
  try {
    const filePath = path.join(dir, 'preview.bpsnap');
    await client.getObject({ key, destPath: filePath });
    const manifest = await peekManifest({ filePath, passphrase });
    return { key, name: displayName(key), manifest };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 恢复远端快照。流程：下载 → 解密校验 → 关库换文件 → 触发重启。
 * 返回后进程即将退出（systemd 重启或 exit），pre-restore 目录留作回滚路径。
 */
async function restoreFromRemote(key) {
  if (busyOp) throw opInProgress();
  if (scheduler.isAnyTaskRunning()) {
    const error = new Error('有任务正在运行，无法恢复。请先停止所有任务');
    error.code = 'operation_in_progress';
    throw error;
  }
  const settings = db.getS3BackupSettings();
  requireFields(settings, ['endpoint', 'bucket', 'accessKey', 'secretKey'], '恢复');
  const passphrase = getPassphrase(settings);
  if (!passphrase) throw new Error('尚未设置备份密码，无法恢复');

  const client = buildClient(settings);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpsnap-restore-in-'));
  busyOp = 'restore';
  try {
    const filePath = path.join(dir, path.basename(key) || 'snapshot.bpsnap');
    await client.getObject({ key, destPath: filePath });

    // 解密 + 校验到 staging（此时库还没动，失败可安全回退）
    const restored = await restoreSnapshot({ filePath, passphrase });

    // 进入不可逆段：先关库，再换文件
    let preRestoreDir;
    try {
      preRestoreDir = await performSwap(restored.stagingDir);
    } finally {
      // staging 里是解密后的明文（含全部密钥），换完文件立刻清掉，不留在 /tmp
      try { fs.rmSync(restored.stagingRoot, { recursive: true, force: true }); } catch { /* 清理失败不阻塞 */ }
    }

    const restartMode = triggerRestart();
    return {
      ok: true,
      key,
      manifest: restored.manifest,
      preRestoreDir,
      restartMode,
      message: restartMode === 'systemd'
        ? '还原完成，面板即将通过 systemd 重启'
        : '还原完成，请手动重启面板生效',
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    busyOp = null;
  }
}

/**
 * 关库并把当前数据挪到 data/pre-restore-<stamp>/，然后把 staging 内容落盘。
 * swap 本身（service 注入的 performSwap）由 index.js 提供 —— 它握有关库和重启的细节。
 */
async function performSwap(stagingDir) {
  if (performRestoreSwap) {
    return performRestoreSwap(stagingDir);
  }
  // 未接线（如单测环境）：直接挪文件
  return swapDataDir(stagingDir);
}

/**
 * 把当前 data 目录挪到 pre-restore-<stamp>/（绝不删除，这是回滚路径），
 * 再把 staging 里的 app.db + tasks/ 落盘。调用方负责先关掉数据库。
 */
function swapDataDir(stagingDir) {
  const stamp = buildStamp();
  const dataDir = config.paths.dataDir;
  const preRestoreDir = path.join(dataDir, `pre-restore-${stamp}`);
  fs.mkdirSync(preRestoreDir, { recursive: true });

  const pairs = [
    [path.join(dataDir, 'app.db'), path.join(preRestoreDir, 'app.db')],
    [path.join(dataDir, 'app.db-wal'), path.join(preRestoreDir, 'app.db-wal')],
    [path.join(dataDir, 'app.db-shm'), path.join(preRestoreDir, 'app.db-shm')],
    [config.paths.tasksDir, path.join(preRestoreDir, 'tasks')],
  ];
  for (const [from, to] of pairs) {
    if (fs.existsSync(from)) fs.renameSync(from, to);
  }
  fs.mkdirSync(config.paths.tasksDir, { recursive: true });
  copyDirContents(path.join(stagingDir, 'tasks'), config.paths.tasksDir);
  fs.copyFileSync(path.join(stagingDir, 'app.db'), path.join(dataDir, 'app.db'));
  return preRestoreDir;
}

function copyDirContents(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) copyDirContents(srcPath, destPath);
    else if (entry.isFile()) fs.copyFileSync(srcPath, destPath);
  }
}

function triggerRestart() {
  try {
    const probe = spawnSync('systemctl', ['--version'], { stdio: 'ignore', timeout: 5000 });
    if (probe.status === 0) {
      // 脱钩启动：systemd 会在停掉当前服务后把新进程拉起来
      const child = spawn('systemctl', ['restart', SERVICE_NAME], {
        detached: true, stdio: 'ignore',
      });
      child.on('error', (err) => {
        console.error('[cloud-backup] systemctl restart 失败:', err.message);
      });
      child.unref();
      return 'systemd';
    }
  } catch { /* 无 systemd 环境走下面 */ }
  // 没有 systemd：靠 supervisor / 手工重启。这里用退出码 1 让 Restart=on-failure 兜底。
  setImmediate(() => process.exit(1));
  return 'exit';
}

// --- 定时 ---

/** 计算下一次自动备份时间。schedule: off | hourly | daily。 */
function computeNextAutoRun(settings, fromDate = new Date()) {
  const schedule = String(settings.schedule || 'off');
  const clamp = (v, lo, hi, dft) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dft;
    return Math.max(lo, Math.min(hi, Math.round(n)));
  };
  const minute = clamp(settings.minute, 0, 59, 0);
  const hour = clamp(settings.hour, 0, 23, 3);

  if (schedule === 'hourly') {
    const next = new Date(fromDate);
    next.setUTCMinutes(minute, 0, 0);
    if (next.getTime() <= fromDate.getTime()) next.setUTCHours(next.getUTCHours() + 1);
    return next.toISOString();
  }
  if (schedule === 'daily') {
    const targetMin = hour * 60 + minute;
    const next = scheduler.getTzDate(fromDate, targetMin, 0);
    if (next.getTime() <= fromDate.getTime()) {
      return scheduler.getTzDate(fromDate, targetMin, 1).toISOString();
    }
    return next.toISOString();
  }
  return null;   // off 或未知值 → 不排
}

/** 把下次运行时间写回设置。返回 ISO 字符串或 null。 */
function scheduleNextAuto(settings, fromDate = new Date()) {
  const next = computeNextAutoRun(settings, fromDate);
  if (next) db.setS3BackupSettings({ nextAt: next });
  return next;
}

/** 设置保存后调用：启用且开了定时就补一个 nextAt（没有或已过期时）。 */
function ensureScheduled(settings) {
  const s = settings || db.getS3BackupSettings();
  if (!s.enabled || String(s.schedule) === 'off') {
    db.setS3BackupSettings({ nextAt: null });
    return null;
  }
  const existing = s.nextAt ? new Date(s.nextAt).getTime() : 0;
  if (existing && existing > Date.now()) return s.nextAt;
  return scheduleNextAuto(s);
}

async function checkAutoBackup() {
  if (busyOp) return;                       // 有操作在跑，下一 tick 再试
  if (scheduler.isAnyTaskRunning()) return; // 有任务在跑，避免快照与任务状态打架
  const settings = db.getS3BackupSettings();
  if (!settings.enabled || String(settings.schedule) === 'off') return;
  const nextAt = settings.nextAt ? new Date(settings.nextAt).getTime() : 0;
  if (!nextAt || Date.now() < nextAt) return;

  try {
    await runCloudBackup('auto');
  } catch (error) {
    // 失败不空转：往后推 5 分钟再试，避免每 60s 撞一次网络错误刷屏
    console.error('[cloud-backup] 自动备份失败:', error.message);
    db.setS3BackupSettings({
      nextAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
  }
}

function startTicker() {
  if (timerHandle) return;
  timerHandle = setInterval(() => {
    checkAutoBackup().catch((error) => {
      console.error('[cloud-backup] tick error:', error.message);
    });
  }, TICK_MS);
}

function stopTicker() {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}

// --- 测试连接 ---

async function testConnection() {
  const settings = db.getS3BackupSettings();
  requireFields(settings, ['endpoint', 'bucket', 'accessKey', 'secretKey'], '测试连接');
  const client = buildClient(settings);
  await client.testConnection();
  return { ok: true };
}

module.exports = {
  DEFAULT_PREFIX,
  DEFAULT_RETENTION,
  setPerformRestoreSwap,
  swapDataDir,
  runCloudBackup,
  listRemoteBackups,
  previewRemoteBackup,
  restoreFromRemote,
  testConnection,
  computeNextAutoRun,
  scheduleNextAuto,
  ensureScheduled,
  startTicker,
  stopTicker,
  isBusy: () => Boolean(busyOp),
};
