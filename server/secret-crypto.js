// Panel-wide at-rest encryption for secrets (Telegram/S3 credentials, TOTP
// secrets, proxy passwords, task secret env values).
//
// Versioned AES-256-GCM envelope: "enc:v1:<iv>.<tag>.<ciphertext>" with
// base64url parts, mirroring the approach in proxy-manager/proxy-crypto.js
// (kept independent on purpose — no cross-module coupling).
//
// The master key is auto-managed: on first use (and eagerly at module load,
// i.e. server startup) a random 32-byte key is generated at
// <dataDir>/.master_key (mode 0600) when the file does not exist yet. It
// travels with cloud snapshots, so restores on another machine keep working.
// PANEL_MASTER_KEY (64 hex chars) remains as an optional override for advanced
// users who want to manage the key themselves; an invalid value is ignored
// with a loud warning and the file key is used instead.
//
// Values that are not envelopes are treated as legacy plaintext: reads pass
// them through, writes re-encrypt them.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../config');

const ENVELOPE_PREFIX = 'enc:v1:';
const MASTER_KEY_RE = /^[0-9a-fA-F]{64}$/;
const MASTER_KEY_FILE_NAME = '.master_key';

function masterKeyFilePath() {
  return path.join(config.paths.dataDir, MASTER_KEY_FILE_NAME);
}

function readEnvOverride() {
  const raw = String(process.env.PANEL_MASTER_KEY || '').trim();
  if (!raw) return { state: 'missing' };
  if (!MASTER_KEY_RE.test(raw)) return { state: 'invalid' };
  return { state: 'ok', key: Buffer.from(raw, 'hex') };
}

// Cached file key, invalidated when the file changes on disk (e.g. a cloud
// restore swaps in the snapshot's key file while the server is running).
let fileKeyCache = null; // { key: Buffer, mtimeMs: number, size: number } | null
let warnedInvalidEnv = false;

function readKeyFile(file) {
  const data = fs.readFileSync(file);
  if (data.length !== 32) {
    throw new Error(
      `主密钥文件损坏（${file}）：长度应为 32 字节。确认备份无误后可删除该文件让面板重新生成，`
      + '但旧密文将无法解密'
    );
  }
  return data;
}

function ensureMode0600(file) {
  try {
    const mode = fs.statSync(file).mode & 0o777;
    if (mode !== 0o600) fs.chmodSync(file, 0o600);
  } catch {
    // Best effort: the key stays usable even if chmod fails.
  }
}

// Generate the key file when missing. 'wx' makes concurrent startups race
// safely: the loser reads the winner's file instead of overwriting it.
function generateKeyFile(file) {
  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if (err && err.code === 'EEXIST') return readKeyFile(file);
    throw new Error(
      `主密钥文件无法写入（${file}）：${err && err.message}. 请检查 data 目录的写权限`
    );
  }
  ensureMode0600(file);
  return key;
}

function resolveFileKey() {
  const file = masterKeyFilePath();
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      throw new Error(`读取主密钥文件失败（${file}）：${err && err.message}`);
    }
  }
  if (!stat) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch (err) {
      throw new Error(
        `主密钥目录无法创建（${path.dirname(file)}）：${err && err.message}，敏感数据加解密不可用`
      );
    }
    const key = generateKeyFile(file);
    console.log(`[security] 已自动生成数据加密主密钥：${file}（0600，随云快照备份）`);
    try {
      const fresh = fs.statSync(file);
      fileKeyCache = { key, mtimeMs: fresh.mtimeMs, size: fresh.size };
    } catch {
      fileKeyCache = null;
    }
    return key;
  }
  if (stat.size !== 32) {
    throw new Error(
      `主密钥文件损坏（${file}）：长度应为 32 字节。确认备份无误后可删除该文件让面板重新生成，`
      + '但旧密文将无法解密'
    );
  }
  if (fileKeyCache && fileKeyCache.mtimeMs === stat.mtimeMs && fileKeyCache.size === stat.size) {
    return fileKeyCache.key;
  }
  const key = readKeyFile(file);
  ensureMode0600(file);
  fileKeyCache = { key, mtimeMs: stat.mtimeMs, size: stat.size };
  return key;
}

function getMasterKey() {
  const env = readEnvOverride();
  if (env.state === 'ok') return env.key;
  if (env.state === 'invalid' && !warnedInvalidEnv) {
    warnedInvalidEnv = true;
    console.warn(
      '[security] PANEL_MASTER_KEY 格式无效（必须是 64 位十六进制字符），已忽略该环境变量，改用 data/.master_key 文件密钥。'
    );
  }
  return resolveFileKey();
}

function describeMasterKey() {
  const env = readEnvOverride();
  if (env.state === 'ok') return { state: 'ok', source: 'env', key: env.key };
  if (env.state === 'invalid') return { state: 'invalid', source: 'env' };
  return { state: 'ok', source: 'file' };
}

// True when a usable master key is available (env override or key file).
// Never throws: on filesystem errors it reports false and the actual crypto
// operation surfaces the detailed error.
function hasMasterKey() {
  try {
    getMasterKey();
    return true;
  } catch {
    return false;
  }
}

function requireMasterKey() {
  return getMasterKey();
}

function isEncryptedEnvelope(value) {
  return typeof value === 'string' && value.startsWith(ENVELOPE_PREFIX);
}

// Encrypt a non-empty plaintext secret. The master key is auto-managed, so
// this only throws in extreme cases (e.g. the data directory is not writable)
// with a message that says exactly what is wrong.
function encryptSecret(plaintext) {
  const text = String(plaintext ?? '');
  if (!text) return '';
  if (isEncryptedEnvelope(text)) return text;
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

// Decrypt a stored value. Non-envelope values are legacy plaintext and pass
// through untouched so historical data stays readable.
function decryptSecret(stored) {
  const text = String(stored ?? '');
  if (!text || !isEncryptedEnvelope(text)) return text;
  const key = getMasterKey();
  const parts = text.slice(ENVELOPE_PREFIX.length).split('.');
  if (parts.length !== 3) throw new Error('敏感数据密文格式无效');
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, 'base64url'));
  if (iv.length !== 12 || tag.length !== 16) throw new Error('敏感数据密文格式无效');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// Best-effort decrypt for display/masking paths: never throws, returns ''
// when the value cannot be decrypted.
function tryDecryptSecret(stored) {
  try {
    return decryptSecret(stored);
  } catch {
    return '';
  }
}

// Eagerly ensure the key file exists at startup (this module is required by
// db.js). Failures are warned, not thrown: the server can still boot and the
// real error surfaces if a secret is actually written.
try {
  if (readEnvOverride().state !== 'ok') resolveFileKey();
} catch (err) {
  console.warn(`[security] 主密钥初始化失败：${err && err.message}`);
}

module.exports = {
  ENVELOPE_PREFIX,
  MASTER_KEY_FILE_NAME,
  masterKeyFilePath,
  describeMasterKey,
  hasMasterKey,
  requireMasterKey,
  isEncryptedEnvelope,
  encryptSecret,
  decryptSecret,
  tryDecryptSecret,
};
