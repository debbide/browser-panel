'use strict';

// TOTP（RFC 6238）零依赖实现。
//
// 只依赖 Node 内置 crypto：base32 解码 + HMAC-SHA1 取动态码。30 秒窗口，
// 验证时 ±1 步容差（容忍设备时钟偏移）。
//
// 为什么不用第三方库：实现很薄（本文件约 60 行），且密码学原语全在 crypto
// 里，自己写反而更好审计。passkey 没有这么幸运——WebAuthn 的 CBOR/COSE/
// ASN.1 太容易写错，所以它用了 @simplewebauthn/server。

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_MS = 30 * 1000;
const DIGITS = 6;
const WINDOW = 1; // ±1 步，共查 3 个时间窗口

// 生成随机 base32 秘钥（160 位 = 32 个 base32 字符，无填充）。
// 必须直接用 base32 字母表编码——base64 里的 0/1/8/9 不是合法 base32，
// 那种"秘钥"身份验证器 App 会拒收或解码错乱。
// 注意位运算要锁在 32 位里：JS 的 >> 是 32 位有符号，累加器超过 2^32 就丢高位。
function generateSecret() {
  const bytes = crypto.randomBytes(20); // 160 bit，正好整除 5，无余数
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffffffff; // 只留最近 32 位（够用了，最多 12 位待编码）
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >>> bits) & 31];
    }
  }
  return out;
}

// base32 解码：接受小写、去掉空格和 '=' 填充。
function base32Decode(input) {
  const clean = String(input || '').toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) continue; // 非法字符直接跳过
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

// HMAC 拆成 6 位数字（RFC 4226 dynamic truncation）
function hotpFromBuffer(hmac) {
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24)
    | (hmac[offset + 1] << 16)
    | (hmac[offset + 2] << 8)
    | hmac[offset + 3];
  return String(bin % 1000000).padStart(DIGITS, '0');
}

// 指定时间点（ms）对应的 TOTP 码
function generateCode(secret, atMs = Date.now()) {
  const key = base32Decode(secret);
  const counter = Math.floor(atMs / STEP_MS);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  return hotpFromBuffer(hmac);
}

// 校验用户输入的 6 位码。接受时区偏移 ±WINDOW 步。
// 返回布尔；不消费/不记录（防重放的"一次性"由登录票据侧负责）。
function verifyCode(secret, code, atMs = Date.now()) {
  const userCode = String(code || '').trim().replace(/\s+/g, '');
  if (!/^\d{6}$/.test(userCode)) return false;
  const counter = Math.floor(atMs / STEP_MS);
  for (let i = -WINDOW; i <= WINDOW; i += 1) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter + i));
    const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
    if (hotpFromBuffer(hmac) === userCode) return true;
  }
  return false;
}

// otpauth 链接，供二维码 / 手动输入。issuer 里不带冒号，避免某些 App 解析错乱。
function otpauthUrl(issuer, account, secret) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

module.exports = { generateSecret, generateCode, verifyCode, otpauthUrl };
