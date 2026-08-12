/**
 * 全量快照：一致性 db 快照 + tasks/ 整目录 + manifest，流式加密成 .bpsnap。
 *
 * .bpsnap 二进制信封（字节序均为大端）：
 *   [0..6]   magic "BPSNAP1"
 *   [7]      version = 1
 *   [8..11]  scrypt N (u32)
 *   [12..15] scrypt r (u32)
 *   [16..19] scrypt p (u32)
 *   [20..35] salt (16B)
 *   [36..47] nonce (12B)
 *   [48..-17] ciphertext
 *   [末16]   AES-256-GCM auth tag
 *
 * 加密用与 backup.js 相同的 scrypt 约定（N=16384,R=8,P=1，派生 64B 取前 32 做 AES key）。
 * 全程流式：tar 打好的压缩包直接管道进 cipher / 从 file stream 进 decipher，
 * 不把整包读进内存 —— 快照预期在 100MB 内，但流式实现不需要为这点赌运气。
 *
 * 解密后做三层校验：magic/参数、manifest 的 schema_version 不高于当前、以及
 * PRAGMA integrity_check + 关键表存在性。校验通过返回 staging 目录，由调用方决定落盘位置。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const config = require('../../config');
const db = require('../db');
const { getVersion } = require('../version');
const { SCHEMA_VERSION, ASSET_EXCLUDED_NAMES } = require('../backup');

const SNAP_MAGIC = 'BPSNAP1';
const SNAP_VERSION = 1;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const AES_KEYLEN = 32;
const AES_NONCE_LEN = 12;
const AES_TAG_LEN = 16;

const HEADER_LEN = 7 + 1 + 4 * 3 + 16 + 12;   // magic+version+params+salt+nonce = 48

// 与 backup.js 相同的排除集：venv/node_modules 这类体积大、可重建的东西不进快照。
// 额外的 *.pyc 和隐藏文件也在拷贝/打包时过滤。
const TASK_EXCLUDE_NAMES = new Set([...ASSET_EXCLUDED_NAMES, '__pycache__']);

function deriveKey(passphrase, salt) {
  const key = crypto.scryptSync(String(passphrase), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
  });
  return key.subarray(0, AES_KEYLEN);
}

function buildHeader(salt, nonce) {
  const header = Buffer.alloc(HEADER_LEN);
  header.write(SNAP_MAGIC, 0, 'utf8');
  header[7] = SNAP_VERSION;
  header.writeUInt32BE(SCRYPT_N, 8);
  header.writeUInt32BE(SCRYPT_R, 12);
  header.writeUInt32BE(SCRYPT_P, 16);
  salt.copy(header, 20);
  nonce.copy(header, 36);
  return header;
}

/** 读信封头部与尾部 tag，做格式/参数校验，返回 { salt, nonce, tag }。 */
function readEnvelope(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size < HEADER_LEN + AES_TAG_LEN) {
    throw new Error('文件太短，不是有效的 .bpsnap 快照');
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(HEADER_LEN);
    fs.readSync(fd, header, 0, HEADER_LEN, 0);
    if (header.slice(0, SNAP_MAGIC.length).toString('utf8') !== SNAP_MAGIC) {
      throw new Error('不是 .bpsnap 快照（缺少 BPSNAP1 头）');
    }
    if (header[7] !== SNAP_VERSION) throw new Error(`不支持的快照版本 ${header[7]}`);
    const n = header.readUInt32BE(8);
    const r = header.readUInt32BE(12);
    const p = header.readUInt32BE(16);
    if (n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) {
      throw new Error('不支持的加密参数（快照由新版面板创建？）');
    }
    const tag = Buffer.alloc(AES_TAG_LEN);
    fs.readSync(fd, tag, 0, AES_TAG_LEN, stat.size - AES_TAG_LEN);
    return {
      salt: header.slice(20, 36),
      nonce: header.slice(36, 48),
      tag,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** 流式加密：读 inputPath 明文，写出带头的密文到 outputPath。 */
async function encryptFileToFile(inputPath, outputPath, passphrase) {
  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(AES_NONCE_LEN);
  const aesKey = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, nonce);
  const input = fs.createReadStream(inputPath);
  const output = fs.createWriteStream(outputPath);
  output.write(buildHeader(salt, nonce));

  await new Promise((resolve, reject) => {
    input.on('error', reject);
    output.on('error', reject);
    cipher.on('error', reject);
    input.pipe(cipher)
      .on('data', (chunk) => output.write(chunk))
      .on('end', () => {
        // GCM tag 只有 final() 之后才知道，不能塞进 pipeline，追加在密文末尾。
        output.write(cipher.getAuthTag());
        output.end(() => resolve());
      });
  });
}

/** 流式解密：读 inputPath 密文，写明文到 outputPath。密码错/损坏抛明确错误。 */
async function decryptFileToFile(inputPath, outputPath, passphrase) {
  const { salt, nonce, tag } = readEnvelope(inputPath);
  const aesKey = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, nonce);
  decipher.setAuthTag(tag);
  const stat = fs.statSync(inputPath);
  const input = fs.createReadStream(inputPath, { start: HEADER_LEN, end: stat.size - AES_TAG_LEN - 1 });
  const output = fs.createWriteStream(outputPath);

  await new Promise((resolve, reject) => {
    input.on('error', reject);
    output.on('error', reject);
    decipher.on('error', reject);
    input.pipe(decipher)
      .on('data', (chunk) => output.write(chunk))
      .on('end', () => output.end(() => resolve()));
  }).catch((error) => {
    // GCM 认证失败统一提示；别把 internal error 糊到界面上。
    const msg = String(error && error.message || '');
    if (msg.includes('unable to auth') || msg.includes('bad decrypt')) {
      throw new Error('密码错误或快照已损坏');
    }
    throw error;
  });
}

/** 拷贝 tasks/ 到 staging，过滤隐藏文件、venv/node_modules、*.pyc。 */
function copyTaskDir(srcDir, destDir) {
  const walk = (src, dest) => {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (TASK_EXCLUDE_NAMES.has(entry.name)) continue;
      if (entry.name.endsWith('.pyc')) continue;
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      let stat;
      try { stat = fs.statSync(srcPath); } catch { continue; }   // 悬空符号链接跳过
      if (stat.isDirectory()) walk(srcPath, destPath);
      else if (stat.isFile()) fs.copyFileSync(srcPath, destPath);
    }
  };
  walk(srcDir, destDir);
}

function runTar(cwd, tarPath) {
  const args = [
    '-czf', tarPath,
    '--exclude=node_modules', '--exclude=.git', '--exclude=.venv', '--exclude=venv',
    '--exclude=__pycache__', '--exclude=*.pyc',
    'app.db', 'tasks', 'manifest.json',
  ];
  const result = spawnSync('tar', args, { cwd, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim() || 'tar 不可用';
    throw new Error(`tar 打包失败: ${detail}`);
  }
  if (!fs.existsSync(tarPath) || fs.statSync(tarPath).size === 0) {
    throw new Error('tar 未生成有效的压缩包');
  }
}

/** 解包前先列出内容，拒绝越界路径（../、绝对路径），防恶意快照逃逸。 */
function assertSafeTarEntries(tarPath) {
  const result = spawnSync('tar', ['-tzf', tarPath], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`无法读取快照内容: ${String(result.stderr || result.stdout || '').trim()}`);
  }
  for (const raw of String(result.stdout || '').split('\n')) {
    const name = raw.trim().replace(/\\/g, '/');
    if (!name || name.endsWith('/')) continue;
    if (name.startsWith('/') || name.split('/').includes('..')) {
      throw new Error('快照包含越界路径，已中止恢复');
    }
  }
}

function runUntar(tarPath, destDir) {
  assertSafeTarEntries(tarPath);
  const result = spawnSync('tar', ['-xzf', tarPath, '-C', destDir], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`快照解包失败: ${String(result.stderr || result.stdout || '').trim()}`);
  }
}

function collectCounts() {
  const counts = {};
  for (const [key, table] of [['tasks', 'tasks'], ['profiles', 'browser_profiles'], ['users', 'panel_users'], ['envEntries', 'env_entries']]) {
    try {
      counts[key] = db.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
    } catch {
      counts[key] = 0;
    }
  }
  return counts;
}

function baseManifest(extra = {}) {
  let panelVersion = 'dev';
  try { panelVersion = getVersion().label; } catch { /* 版本解析失败不阻塞备份 */ }
  return {
    format: 'bpsnap',
    version: SNAP_VERSION,
    schema_version: SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    panel_version: panelVersion,
    includes: ['app.db', 'tasks/', 'manifest.json'],
    counts: collectCounts(),
    engine: { node: process.version },
    ...extra,
  };
}

/**
 * 创建全量快照。
 * @param {object} opts
 * @param {string} opts.outPath  .bpsnap 输出路径
 * @param {string} opts.passphrase 加密口令
 * @param {object} [opts.meta]  写入 manifest 的附加字段（trigger / label 等）
 * @returns {Promise<{filePath: string, size: number, manifest: object}>}
 */
async function createSnapshot({ outPath, passphrase, meta = {} } = {}) {
  if (!passphrase) throw new Error('缺少备份密码');
  if (!outPath) throw new Error('缺少输出路径');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'bpsnap-create-'));
  try {
    // 1) 一致性数据库快照。WAL 库直接 cp 会拿到撕裂状态，必须走 better-sqlite3 的 backup。
    const dbFile = path.join(staging, 'app.db');
    fs.rmSync(dbFile, { force: true });
    await db.db.backup(dbFile);

    // 2) tasks/ 整目录（含排除集过滤）
    copyTaskDir(config.paths.tasksDir, path.join(staging, 'tasks'));

    // 3) manifest
    const manifest = baseManifest(meta);
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // 4) 打包
    const tarPath = path.join(staging, 'snapshot.tar.gz');
    runTar(staging, tarPath);

    // 5) 流式加密
    await encryptFileToFile(tarPath, outPath, passphrase);
    const stat = fs.statSync(outPath);
    return { filePath: outPath, size: stat.size, manifest };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * 校验解包出来的 app.db：integrity_check + 关键表存在。
 */
function validateDb(dbFile) {
  let readDb;
  try {
    readDb = new Database(dbFile, { readonly: true });
    const check = readDb.prepare('PRAGMA integrity_check').get();
    if (!check || check.integrity_check !== 'ok') {
      throw new Error(`数据库完整性检查未通过: ${check ? check.integrity_check : '无结果'}`);
    }
    const tables = readDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    const required = ['tasks', 'browser_profiles', 'panel_users', 'app_settings', 'env_entries'];
    const missing = required.filter((t) => !tables.includes(t));
    if (missing.length) throw new Error(`快照缺少关键表: ${missing.join(', ')}`);
  } catch (error) {
    if (error.message && error.message.includes('schema')) throw error;
    throw new Error(`快照数据库校验失败: ${error.message}`);
  } finally {
    if (readDb) readDb.close();
  }
}

/**
 * 解密并校验快照。
 * @param {object} opts
 * @param {string} opts.filePath   .bpsnap 文件
 * @param {string} opts.passphrase 口令
 * @returns {Promise<{stagingRoot: string, stagingDir: string, manifest: object}>}
 *    stagingDir 是解包校验通过后的目录；调用方用完负责 rm stagingRoot（含 dir）。
 */
async function restoreSnapshot({ filePath, passphrase } = {}) {
  if (!passphrase) throw new Error('缺少备份密码');
  if (!filePath) throw new Error('缺少快照文件');
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'bpsnap-restore-'));
  try {
    const tarPath = path.join(staging, 'snapshot.tar.gz');
    await decryptFileToFile(filePath, tarPath, passphrase);

    const extractDir = path.join(staging, 'snap');
    fs.mkdirSync(extractDir, { recursive: true });
    runUntar(tarPath, extractDir);

    const manifestPath = path.join(extractDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error('快照缺少 manifest.json');
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
    catch { throw new Error('manifest.json 解析失败，快照损坏'); }
    if (manifest.format !== 'bpsnap') throw new Error('快照格式不正确');
    if (Number(manifest.schema_version) > SCHEMA_VERSION) {
      throw new Error(`快照 schema 版本 ${manifest.schema_version} 高于当前 ${SCHEMA_VERSION}，请先升级面板`);
    }

    const dbFile = path.join(extractDir, 'app.db');
    if (!fs.existsSync(dbFile)) throw new Error('快照缺少 app.db');
    validateDb(dbFile);

    return { stagingRoot: staging, stagingDir: extractDir, manifest };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * 只读 manifest 的轻量预览：解密 + 解包 + 读 manifest.json，不校验数据库，用完即清理。
 * 用于恢复前的预览（远端对象只有密文，拿不到任务计数之类信息，除非先解开）。
 */
async function peekManifest({ filePath, passphrase }) {
  if (!passphrase) throw new Error('缺少备份密码');
  if (!filePath) throw new Error('缺少快照文件');
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'bpsnap-peek-'));
  try {
    const tarPath = path.join(staging, 'snapshot.tar.gz');
    await decryptFileToFile(filePath, tarPath, passphrase);
    const extractDir = path.join(staging, 'snap');
    fs.mkdirSync(extractDir, { recursive: true });
    runUntar(tarPath, extractDir);
    const manifestPath = path.join(extractDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error('快照缺少 manifest.json');
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = {
  SNAP_MAGIC,
  SNAP_VERSION,
  HEADER_LEN,
  createSnapshot,
  restoreSnapshot,
  peekManifest,
};
