'use strict';

// Parses the VLESS share link format that clients export, e.g.
//
//   vless://<uuid>@<host>:<port>?encryption=none&security=tls&type=ws
//     &host=example.com&path=%2Fws&sni=example.com&fp=chrome#name
//
// Only the subset this dialer can actually honour is accepted. Anything else
// (Reality, XTLS Vision, gRPC, XHTTP, ...) is rejected loudly at parse time
// instead of failing later with an opaque network error.

const { parseUuid } = require('./uuid');

const SUPPORTED_TRANSPORTS = new Set(['ws']);
const SUPPORTED_SECURITY = new Set(['tls']);
const SUPPORTED_FLOWS = new Set(['', 'none']);

// `fp` asks for a specific uTLS fingerprint. Node's tls module cannot forge a
// ClientHello, so the value is recorded for diagnostics but never applied.
const KNOWN_FINGERPRINTS = new Set(['chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random', 'randomized']);

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function splitHostPort(authority) {
  const value = String(authority ?? '').trim();
  if (!value) {
    throw new Error('VLESS 链接缺少服务器地址');
  }
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end === -1) {
      throw new Error('VLESS 链接的 IPv6 地址格式无效');
    }
    const host = value.slice(1, end);
    const rest = value.slice(end + 1);
    const port = rest.startsWith(':') ? rest.slice(1) : '';
    return { host, port };
  }
  const index = value.lastIndexOf(':');
  if (index === -1) {
    return { host: value, port: '' };
  }
  return { host: value.slice(0, index), port: value.slice(index + 1) };
}

function parseVlessLink(input) {
  const raw = String(input ?? '').trim();
  if (!/^vless:\/\//i.test(raw)) {
    throw new Error('仅支持 vless:// 链接');
  }

  let url;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new Error('VLESS 链接格式无效');
  }

  const uuid = url.username ? decodeURIComponent(url.username) : '';
  if (!uuid) {
    throw new Error('VLESS 链接缺少 UUID');
  }
  parseUuid(uuid);

  // `vless:` is not a WHATWG "special" scheme, so url.hostname/url.port are not
  // guaranteed to be populated. Fall back to parsing the authority ourselves.
  const authority = splitHostPort(url.host);
  const host = url.hostname || authority.host;
  const port = url.port || authority.port;
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    throw new Error('VLESS 链接缺少有效的端口');
  }

  const params = url.searchParams;
  const get = (name) => {
    const value = params.get(name);
    return value === null ? '' : value;
  };

  const encryption = (get('encryption') || 'none').toLowerCase();
  if (encryption !== 'none') {
    throw new Error(`暂不支持 VLESS 加密方式：${encryption}`);
  }

  const security = (get('security') || 'none').toLowerCase();
  if (!SUPPORTED_SECURITY.has(security)) {
    throw new Error(`暂不支持 VLESS 传输安全类型：${security || 'none'}（当前仅支持 tls）`);
  }

  const transport = (get('type') || 'tcp').toLowerCase();
  if (!SUPPORTED_TRANSPORTS.has(transport)) {
    throw new Error(`暂不支持 VLESS 传输方式：${transport}（当前仅支持 ws）`);
  }

  const flow = (get('flow') || '').toLowerCase();
  if (!SUPPORTED_FLOWS.has(flow)) {
    throw new Error(`暂不支持 VLESS flow：${flow}（当前仅支持无 flow）`);
  }

  const sni = get('sni') || get('peer') || host;
  const wsHost = get('host') || sni;
  const path = get('path') || '/';
  const fingerprint = get('fp').toLowerCase();
  const alpn = get('alpn')
    ? get('alpn').split(',').map((item) => item.trim()).filter(Boolean)
    : [];

  const name = url.hash ? decodeURIComponent(url.hash.slice(1)) : '';

  return {
    uuid,
    host,
    port: portNumber,
    encryption,
    security,
    transport,
    sni,
    wsHost,
    path: path.startsWith('/') ? path : `/${path}`,
    fingerprint,
    fingerprintApplied: false,
    fingerprintSupported: !fingerprint || KNOWN_FINGERPRINTS.has(fingerprint),
    alpn,
    allowInsecure: toBoolean(get('allowInsecure') || get('insecure')),
    name,
    raw
  };
}

function isVlessLink(value) {
  return /^vless:\/\//i.test(String(value ?? '').trim());
}

module.exports = { parseVlessLink, isVlessLink, SUPPORTED_TRANSPORTS, SUPPORTED_SECURITY };
