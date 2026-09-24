// Panel-wide at-rest encryption for secrets (Telegram/S3 credentials, TOTP
// secrets, proxy passwords, task secret env values).
//
// Versioned AES-256-GCM envelope: "enc:v1:<iv>.<tag>.<ciphertext>" with
// base64url parts, mirroring the approach in proxy-manager/proxy-crypto.js
// (kept independent on purpose — no cross-module coupling).
//
// The master key comes from PANEL_MASTER_KEY (64 hex chars = 32 bytes) and is
// used directly as the AES-256 key. Values that are not envelopes are treated
// as legacy plaintext: reads pass them through, writes re-encrypt them when
// a master key is configured.

const crypto = require('node:crypto');

const ENVELOPE_PREFIX = 'enc:v1:';
const MASTER_KEY_RE = /^[0-9a-fA-F]{64}$/;

function describeMasterKey() {
  const raw = String(process.env.PANEL_MASTER_KEY || '').trim();
  if (!raw) return { state: 'missing' };
  if (!MASTER_KEY_RE.test(raw)) return { state: 'invalid' };
  return { state: 'ok', key: Buffer.from(raw, 'hex') };
}

function hasMasterKey() {
  return describeMasterKey().state === 'ok';
}

function requireMasterKey() {
  const described = describeMasterKey();
  if (described.state === 'missing') {
    throw new Error('未配置 PANEL_MASTER_KEY，无法加解密敏感数据');
  }
  if (described.state === 'invalid') {
    throw new Error('PANEL_MASTER_KEY 格式无效：必须是 64 位十六进制字符（32 字节）');
  }
  return described.key;
}

function isEncryptedEnvelope(value) {
  return typeof value === 'string' && value.startsWith(ENVELOPE_PREFIX);
}

// Encrypt a non-empty plaintext secret. Refuses (throws) when no master key
// is configured so secrets are never silently stored as plaintext.
function encryptSecret(plaintext) {
  const text = String(plaintext ?? '');
  if (!text) return '';
  if (isEncryptedEnvelope(text)) return text;
  const key = requireMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

// Decrypt a stored value. Non-envelope values are legacy plaintext and pass
// through untouched so historical data stays readable without a master key.
function decryptSecret(stored) {
  const text = String(stored ?? '');
  if (!text || !isEncryptedEnvelope(text)) return text;
  const key = requireMasterKey();
  const parts = text.slice(ENVELOPE_PREFIX.length).split('.');
  if (parts.length !== 3) throw new Error('敏感数据密文格式无效');
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, 'base64url'));
  if (iv.length !== 12 || tag.length !== 16) throw new Error('敏感数据密文格式无效');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// Best-effort decrypt for display/masking paths: never throws, returns ''
// when the value cannot be decrypted (e.g. key not configured).
function tryDecryptSecret(stored) {
  try {
    return decryptSecret(stored);
  } catch {
    return '';
  }
}

module.exports = {
  ENVELOPE_PREFIX,
  describeMasterKey,
  hasMasterKey,
  requireMasterKey,
  isEncryptedEnvelope,
  encryptSecret,
  decryptSecret,
  tryDecryptSecret,
};
