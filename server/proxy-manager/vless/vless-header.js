'use strict';

// VLESS request/response header codec.
//
// Request:
//   1B version | 16B uuid | 1B addons length | 1B command | 2B port (BE)
//   | 1B address type | N bytes address | payload
//
// Response:
//   1B version | 1B addons length | N bytes addons | payload
//
// The protocol performs no encryption of its own: confidentiality comes from
// the TLS layer underneath, so the codec is pure byte assembly.

const net = require('node:net');
const { parseUuid } = require('./uuid');

const VERSION = 0x00;

const COMMAND = Object.freeze({
  TCP: 0x01,
  UDP: 0x02,
  MUX: 0x03
});

const ADDRESS_TYPE = Object.freeze({
  IPV4: 0x01,
  DOMAIN: 0x02,
  IPV6: 0x03
});

function ipv4ToBuffer(address) {
  const parts = String(address).trim().split('.');
  if (parts.length !== 4) {
    throw new Error('IPv4 地址无效');
  }
  const buffer = Buffer.allocUnsafe(4);
  parts.forEach((part, index) => {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new Error('IPv4 地址无效');
    }
    buffer[index] = value;
  });
  return buffer;
}

// Handles the `::` shorthand and the trailing dotted-quad form (::ffff:1.2.3.4).
function ipv6ToBuffer(address) {
  let value = String(address).trim().replace(/^\[|\]$/g, '');
  let tailWords = [];

  if (value.includes('.')) {
    const index = value.lastIndexOf(':');
    if (index === -1) {
      throw new Error('IPv6 地址无效');
    }
    const octets = value.slice(index + 1).split('.').map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      throw new Error('IPv6 地址无效');
    }
    tailWords = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
    value = value.slice(0, index + 1);
  }

  const marker = value.indexOf('::');
  let words;
  if (marker === -1) {
    words = value.split(':').filter((part) => part !== '').map((part) => Number.parseInt(part, 16));
  } else {
    const head = value.slice(0, marker).split(':').filter((part) => part !== '')
      .map((part) => Number.parseInt(part, 16));
    const tail = value.slice(marker + 2).split(':').filter((part) => part !== '')
      .map((part) => Number.parseInt(part, 16));
    const used = head.length + tail.length + tailWords.length;
    if (used > 8) {
      throw new Error('IPv6 地址无效');
    }
    words = [...head, ...new Array(8 - used).fill(0), ...tail];
  }

  words = [...words, ...tailWords];
  if (words.length !== 8 || words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) {
    throw new Error('IPv6 地址无效');
  }

  const buffer = Buffer.allocUnsafe(16);
  words.forEach((word, index) => buffer.writeUInt16BE(word, index * 2));
  return buffer;
}

function encodeAddress(host) {
  // CONNECT targets and share links both occasionally wrap IPv6 in brackets;
  // net.isIP only understands the bare form, so normalise first.
  const value = String(host ?? '').trim().replace(/^\[|\]$/g, '');
  if (!value) {
    throw new Error('目标地址不能为空');
  }
  const family = net.isIP(value);
  if (family === 4) {
    return Buffer.concat([Buffer.from([ADDRESS_TYPE.IPV4]), ipv4ToBuffer(value)]);
  }
  if (family === 6) {
    return Buffer.concat([Buffer.from([ADDRESS_TYPE.IPV6]), ipv6ToBuffer(value)]);
  }
  const domain = Buffer.from(value, 'utf8');
  if (domain.length === 0 || domain.length > 255) {
    throw new Error('目标域名长度无效');
  }
  return Buffer.concat([Buffer.from([ADDRESS_TYPE.DOMAIN, domain.length]), domain]);
}

function encodeRequestHeader({ uuid, host, port, command = COMMAND.TCP }) {
  const id = Buffer.isBuffer(uuid) ? uuid : parseUuid(uuid);
  if (id.length !== 16) {
    throw new Error('UUID 字节长度必须为 16');
  }
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    throw new Error('目标端口无效');
  }
  const portBuffer = Buffer.allocUnsafe(2);
  portBuffer.writeUInt16BE(portNumber, 0);

  return Buffer.concat([
    Buffer.from([VERSION]),
    id,
    Buffer.from([0x00]),
    Buffer.from([command]),
    portBuffer,
    encodeAddress(host)
  ]);
}

function decodeResponseHeader(buffer) {
  if (buffer.length < 2) {
    throw new Error('VLESS 响应头不完整');
  }
  const addonsLength = buffer[1];
  if (buffer.length < 2 + addonsLength) {
    throw new Error('VLESS 响应头不完整');
  }
  return {
    version: buffer[0],
    addons: buffer.subarray(2, 2 + addonsLength)
  };
}

// The response header length is self-describing: 2 bytes, then `addonsLength`.
function responseHeaderSize(prefix) {
  if (prefix.length < 2) {
    return 2;
  }
  return 2 + prefix[1];
}

module.exports = {
  VERSION,
  COMMAND,
  ADDRESS_TYPE,
  encodeAddress,
  encodeRequestHeader,
  decodeResponseHeader,
  responseHeaderSize,
  ipv4ToBuffer,
  ipv6ToBuffer
};
