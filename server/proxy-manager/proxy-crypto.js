const crypto = require('node:crypto');

const PREFIX = 'enc:v1:';

function createProxyCrypto(secret) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('PROXY_ENCRYPTION_KEY 必须至少包含 16 个字符');
  }

  const key = crypto.createHash('sha256').update(secret, 'utf8').digest();

  function isEncrypted(value) {
    return typeof value === 'string' && value.startsWith(PREFIX);
  }

  function encrypt(value) {
    if (isEncrypted(value)) return value;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
  }

  function decrypt(value) {
    if (!isEncrypted(value)) return value;
    const parts = value.slice(PREFIX.length).split('.');
    if (parts.length !== 3) {
      throw new Error('上游代理地址密文格式无效');
    }
    const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]).toString('utf8');
  }

  return { encrypt, decrypt, isEncrypted };
}

module.exports = { createProxyCrypto };
