'use strict';

const fs = require('fs');

const HEARTBEAT_MS = 25000;
const FLUSH_MS = 100;

// 日志流与全局状态 SSE 分开：日志只发给正在查看该文件的客户端。
// 磁盘文件是唯一事实来源；SSE 只通知客户端当前可读到的最高字节位置。
const streams = new Map();

function frame(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload === undefined ? null : payload)}\n\n`;
}

function write(res, chunk) {
  if (res.writableEnded || res.destroyed) return false;
  try {
    // res.write(false) 表示背压而非断线。高水位事件很小，Node 会自行排队；
    // 只有抛错或 response 已销毁才清理订阅。
    res.write(chunk);
    return true;
  } catch {
    return false;
  }
}

function getSize(logPath) {
  try { return Number(fs.statSync(logPath).size) || 0; } catch { return 0; }
}

function removeClient(logPath, client) {
  const set = streams.get(logPath);
  if (!set) return;
  set.delete(client);
  if (!set.size) streams.delete(logPath);
}

function flush(logPath, client) {
  if (client.timer) clearTimeout(client.timer);
  client.timer = null;
  if (!client.dirty) return;
  client.dirty = false;
  const size = getSize(logPath);
  if (size <= client.lastSize) return;
  client.lastSize = size;
  if (!write(client.res, frame('log', { size }))) client.cleanup();
}

/**
 * 先注册，再在同一同步调用栈读取文件大小并发送 ready：注册前写入的字节包含在
 * ready.size，注册后的写入则一定会把 client 标脏，因此快照与订阅之间没有盲区。
 */
function subscribe(logPath, res) {
  const client = {
    res,
    dirty: false,
    timer: null,
    lastSize: 0,
    closed: false,
    cleanup: null,
  };
  let set = streams.get(logPath);
  if (!set) streams.set(logPath, (set = new Set()));
  set.add(client);

  const keepalive = setInterval(() => {
    if (!write(res, ': keepalive\n\n')) client.cleanup();
  }, HEARTBEAT_MS);
  if (keepalive.unref) keepalive.unref();

  client.cleanup = () => {
    if (client.closed) return;
    client.closed = true;
    if (client.timer) clearTimeout(client.timer);
    clearInterval(keepalive);
    removeClient(logPath, client);
  };
  res.on('close', client.cleanup);
  res.on('error', client.cleanup);

  const size = getSize(logPath);
  client.lastSize = size;
  if (!write(res, frame('ready', { size }))) client.cleanup();
  return client.cleanup;
}

function publish(logPath) {
  const set = streams.get(logPath);
  if (!set || !set.size) return;
  for (const client of set) {
    if (client.closed) continue;
    client.dirty = true;
    if (!client.timer) client.timer = setTimeout(() => flush(logPath, client), FLUSH_MS);
  }
}

function finishClient(client, logPath, payload = {}) {
  flush(logPath, client);
  const ok = write(client.res, frame('end', { ...payload, size: getSize(logPath) }));
  if (ok && typeof client.res.end === 'function' && !client.res.writableEnded) {
    try { client.res.end(); } catch { /* response already closed */ }
  }
  client.cleanup();
}

function end(logPath, payload = {}) {
  const set = streams.get(logPath);
  if (!set) return;
  for (const client of [...set]) finishClient(client, logPath, payload);
}

/** 只结束当前 response，用于任务已结束后才打开日志的客户端。 */
function endClient(logPath, res, payload = {}) {
  const set = streams.get(logPath);
  if (!set) return;
  const client = [...set].find((item) => item.res === res);
  if (!client) return;
  finishClient(client, logPath, payload);
}

module.exports = { subscribe, publish, end, endClient };
