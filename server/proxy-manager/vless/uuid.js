'use strict';

// VLESS identifies a user by a 16-byte UUID that is sent verbatim in the
// request header. Xray accepts the canonical 8-4-4-4-12 textual form, so we
// normalise it once here and hand raw bytes to the protocol layer.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseUuid(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error('UUID 格式无效，应为 8-4-4-4-12 的十六进制字符串');
  }
  return Buffer.from(normalized.replace(/-/g, ''), 'hex');
}

function formatUuid(buffer) {
  const hex = Buffer.from(buffer).toString('hex');
  if (hex.length !== 32) {
    throw new Error('UUID 字节长度必须为 16');
  }
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join('-');
}

module.exports = { parseUuid, formatUuid };
