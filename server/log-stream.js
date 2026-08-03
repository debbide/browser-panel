'use strict';

const HEARTBEAT_MS = 25000;
const FLUSH_MS = 100;
const MAX_BATCH_BYTES = 64 * 1024;

// 日志流与全局状态 SSE 分开：日志只发给正在查看该文件的客户端。
const streams = new Map();

function frame(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload === undefined ? null : payload)}\n\n`;
}

function write(res, chunk) {
  if (res.writableEnded || res.destroyed) return false;
  try {
    return res.write(chunk);
  } catch {
    return false;
  }
}

function removeClient(logPath, client) {
  const set = streams.get(logPath);
  if (!set) return;
  set.delete(client);
  if (!set.size) streams.delete(logPath);
}

function subscribe(logPath, res, initialSize = 0) {
  const client = { res, chunks: [], bytes: 0, timer: null };
  let set = streams.get(logPath);
  if (!set) streams.set(logPath, (set = new Set()));
  set.add(client);

  const cleanup = () => {
    if (client.timer) clearTimeout(client.timer);
    removeClient(logPath, client);
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
  const keepalive = setInterval(() => {
    if (!write(res, ': keepalive\n\n')) cleanup();
  }, HEARTBEAT_MS);
  if (keepalive.unref) keepalive.unref();
  client.cleanup = () => {
    clearInterval(keepalive);
    cleanup();
  };
  write(res, frame('ready', { size: initialSize }));
  return client.cleanup;
}

function flush(client) {
  client.timer = null;
  if (!client.chunks.length) return;
  const text = client.chunks.join('');
  client.chunks = [];
  client.bytes = 0;
  if (!write(client.res, frame('log', { text }))) client.cleanup();
}

function publish(logPath, text) {
  const set = streams.get(logPath);
  if (!set || !set.size) return;
  for (const client of set) {
    const value = String(text || '');
    client.chunks.push(value);
    client.bytes += Buffer.byteLength(value);
    if (client.bytes >= MAX_BATCH_BYTES) flush(client);
    else if (!client.timer) client.timer = setTimeout(() => flush(client), FLUSH_MS);
  }
}

function end(logPath, payload = {}) {
  const set = streams.get(logPath);
  if (!set) return;
  for (const client of [...set]) {
    flush(client);
    write(client.res, frame('end', payload));
    client.cleanup();
  }
}

module.exports = { subscribe, publish, end };
