'use strict';

// Minimal RFC 6455 WebSocket client, written from scratch so the project keeps
// its "no third-party binary, no extra runtime dependency" property.
//
// Only what a VLESS-over-WS tunnel needs is implemented: the upgrade handshake,
// binary data frames with mandatory client masking, fragmentation reassembly,
// control frames (ping/pong/close) and keep-alive. Permessage-deflate, text
// messages and extensions are deliberately out of scope.

const crypto = require('node:crypto');
const { Duplex } = require('node:stream');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa
});

const MAX_HEADER_BYTES = 16 * 1024;
const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

function acceptKeyFor(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function encodeFrame(opcode, payload, { mask = true } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '');
  const length = body.length;
  let headerLength = 2;
  if (length >= 65536) headerLength += 8;
  else if (length > 125) headerLength += 2;
  if (mask) headerLength += 4;

  const frame = Buffer.allocUnsafe(headerLength + length);
  frame[0] = 0x80 | opcode; // FIN + opcode, RSV bits stay clear
  let offset = 2;

  if (length >= 65536) {
    frame[1] = 127;
    frame.writeUInt32BE(Math.floor(length / 0x100000000), offset);
    frame.writeUInt32BE(length >>> 0, offset + 4);
    offset += 8;
  } else if (length > 125) {
    frame[1] = 126;
    frame.writeUInt16BE(length, offset);
    offset += 2;
  } else {
    frame[1] = length;
  }

  if (mask) {
    frame[1] |= 0x80;
    const maskKey = crypto.randomBytes(4);
    maskKey.copy(frame, offset);
    offset += 4;
    for (let index = 0; index < length; index += 1) {
      frame[offset + index] = body[index] ^ maskKey[index & 3];
    }
  } else {
    body.copy(frame, offset);
  }

  return frame;
}

class WebSocketConnection extends Duplex {
  constructor(socket, { maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES } = {}) {
    super({ allowHalfOpen: true });
    this.socket = socket;
    this.maxMessageBytes = maxMessageBytes;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = null;
    // Named `isClosed` on purpose: `closed` is a read-only getter on Stream.
    this.isClosed = false;
    this.closeSent = false;
    this.writeChain = Promise.resolve();

    socket.on('data', (chunk) => this.consume(chunk));
    socket.on('error', (error) => this.destroy(error));
    socket.on('close', () => this.finish());
    socket.setNoDelay(true);
  }

  get remoteAddress() {
    return this.socket.remoteAddress;
  }

  // Writes are chained so two concurrent senders can never interleave the
  // halves of a single frame on the wire.
  send(payload, opcode = OPCODE.BINARY) {
    this.writeChain = this.writeChain.then(() => this.rawSend(payload, opcode));
    return this.writeChain;
  }

  rawSend(payload, opcode) {
    if (this.isClosed || this.socket.destroyed) {
      return Promise.reject(new Error('WebSocket 已关闭'));
    }
    const frame = encodeFrame(opcode, payload);
    return new Promise((resolve, reject) => {
      this.socket.write(frame, (error) => (error ? reject(error) : resolve()));
    });
  }

  ping(payload = Buffer.alloc(0)) {
    return this.send(payload, OPCODE.PING);
  }

  pong(payload = Buffer.alloc(0)) {
    return this.send(payload, OPCODE.PONG);
  }

  closeFrame(code = 1000) {
    if (this.closeSent) return Promise.resolve();
    this.closeSent = true;
    const payload = Buffer.allocUnsafe(2);
    payload.writeUInt16BE(code, 0);
    return this.send(payload, OPCODE.CLOSE).catch(() => undefined);
  }

  consume(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (this.parseOne()) {
      // keep draining
    }
  }

  parseOne() {
    const buffer = this.buffer;
    if (buffer.length < 2) return false;

    const fin = (buffer[0] & 0x80) !== 0;
    const rsv = buffer[0] & 0x70;
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7f;
    let offset = 2;

    if (rsv !== 0) {
      this.destroy(new Error('WebSocket 帧使用了不支持的扩展位'));
      return false;
    }

    if (length === 126) {
      if (buffer.length < offset + 2) return false;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < offset + 8) return false;
      const high = buffer.readUInt32BE(offset);
      const low = buffer.readUInt32BE(offset + 4);
      if (high !== 0) {
        this.destroy(new Error('WebSocket 帧过大'));
        return false;
      }
      length = low;
      offset += 8;
    }

    // Servers must not mask; a masked frame from the peer is a protocol error.
    if (masked) {
      this.destroy(new Error('服务端返回了带掩码的 WebSocket 帧'));
      return false;
    }

    const isControl = (opcode & 0x08) !== 0;
    if (isControl && (length > 125 || !fin)) {
      this.destroy(new Error('WebSocket 控制帧格式非法'));
      return false;
    }

    if (buffer.length < offset + length) return false;

    const payload = buffer.subarray(offset, offset + length);
    this.buffer = buffer.subarray(offset + length);
    this.handleFrame(fin, opcode, payload);
    return this.buffer.length >= 2;
  }

  handleFrame(fin, opcode, payload) {
    if (opcode === OPCODE.PING) {
      this.pong(payload).catch(() => undefined);
      this.emit('ping', payload);
      return;
    }
    if (opcode === OPCODE.PONG) {
      this.emit('pong', payload);
      return;
    }
    if (opcode === OPCODE.CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      this.closeSent = true;
      // Echo the peer's code when it sent one; otherwise a bare 1000.
      const reply = payload.length >= 2 ? payload.subarray(0, 2) : Buffer.from([0x03, 0xe8]);
      this.socket.end(encodeFrame(OPCODE.CLOSE, reply));
      this.emit('closing', code);
      return;
    }

    if (opcode === OPCODE.CONTINUATION) {
      if (this.fragmentOpcode === null) {
        this.destroy(new Error('收到意外的 WebSocket 续帧'));
        return;
      }
    } else {
      if (this.fragmentOpcode !== null) {
        this.destroy(new Error('WebSocket 分片未结束就开始了新消息'));
        return;
      }
      this.fragmentOpcode = opcode;
    }

    if (payload.length > 0) {
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > this.maxMessageBytes) {
        this.destroy(new Error('WebSocket 消息超过大小上限'));
        return;
      }
      this.fragments.push(payload);
    }

    if (!fin) return;

    const message = this.fragments.length === 1
      ? this.fragments[0]
      : Buffer.concat(this.fragments);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = null;

    if (opcode === OPCODE.TEXT) {
      // A VLESS tunnel never needs text frames; surface it as bytes anyway so
      // a chatty peer cannot stall the stream.
      this.push(message);
      return;
    }
    this.push(message);
  }

  finish() {
    if (this.isClosed) return;
    this.isClosed = true;
    this.push(null);
  }

  _read() {
    // Data is pushed directly from the parser; nothing to pull.
  }

  _write(chunk, encoding, callback) {
    this.send(chunk).then(() => callback(), (error) => callback(error));
  }

  _final(callback) {
    this.closeFrame(1000).then(() => {
      this.socket.end();
      callback();
    }, () => callback());
  }

  _destroy(error, callback) {
    this.isClosed = true;
    this.socket.destroy();
    callback(error);
  }
}
// Performs the HTTP upgrade over an already-connected socket. `host` and `path`
// come from the vless:// link; `headers` carries the extra Host/SNI-derived
// fields some CDN frontends expect.
function upgrade(socket, { host, path = '/', headers = {}, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const expected = acceptKeyFor(key);
    let settled = false;
    let buffered = Buffer.alloc(0);

    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      if (timer) clearTimeout(timer);
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };

    const timer = timeoutMs > 0
      ? setTimeout(() => fail(new Error('WebSocket 握手超时')), timeoutMs)
      : null;

    function onError(error) {
      fail(error);
    }

    function onClose() {
      fail(new Error('WebSocket 握手期间连接被关闭'));
    }

    function onData(chunk) {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_HEADER_BYTES) {
        fail(new Error('WebSocket 响应头过大'));
        return;
      }
      const end = buffered.indexOf('\r\n\r\n');
      if (end === -1) return;

      const head = buffered.subarray(0, end).toString('latin1');
      const rest = buffered.subarray(end + 4);
      const lines = head.split('\r\n');
      const statusLine = lines.shift() || '';
      const statusMatch = statusLine.match(/^HTTP\/1\.[01]\s+(\d{3})/);
      if (!statusMatch) {
        fail(new Error('WebSocket 握手响应格式无效'));
        return;
      }
      const statusCode = Number(statusMatch[1]);

      const responseHeaders = new Map();
      for (const line of lines) {
        const index = line.indexOf(':');
        if (index === -1) continue;
        responseHeaders.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim());
      }

      if (statusCode !== 101) {
        const details = [
          responseHeaders.get('server') ? `server=${responseHeaders.get('server')}` : '',
          responseHeaders.get('location') ? `location=${responseHeaders.get('location')}` : '',
          responseHeaders.get('cf-ray') ? `cf-ray=${responseHeaders.get('cf-ray')}` : '',
          responseHeaders.get('content-type') ? `content-type=${responseHeaders.get('content-type')}` : ''
        ].filter(Boolean).join(', ');
        fail(new Error(`WebSocket 握手失败，HTTP ${statusCode}${details ? `（${details}）` : ''}`));
        return;
      }

      if ((responseHeaders.get('upgrade') || '').toLowerCase() !== 'websocket') {
        fail(new Error('WebSocket 握手缺少 Upgrade 头'));
        return;
      }
      if (responseHeaders.get('sec-websocket-accept') !== expected) {
        fail(new Error('WebSocket 握手校验失败，Sec-WebSocket-Accept 不匹配'));
        return;
      }

      settled = true;
      cleanup();
      const connection = new WebSocketConnection(socket);
      if (rest.length > 0) {
        connection.consume(rest);
      }
      resolve(connection);
    }

    const requestHeaders = [
      `GET ${path} HTTP/1.1`,
      `Host: ${headers.host || host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13'
    ];
    if (headers.origin) requestHeaders.push(`Origin: ${headers.origin}`);
    if (headers.userAgent) requestHeaders.push(`User-Agent: ${headers.userAgent}`);

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.write(`${requestHeaders.join('\r\n')}\r\n\r\n`);
  });
}

module.exports = {
  OPCODE,
  WebSocketConnection,
  upgrade,
  encodeFrame,
  acceptKeyFor
};
