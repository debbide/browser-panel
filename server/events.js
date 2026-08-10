/**
 * 轻量事件总线 + SSE 推送。
 *
 * 状态变化方（scheduler 的任务开始/结束、browser 的手动浏览器开/关/崩溃）只需调用
 * emit(event, payload)，不必知道谁在听；SSE 连接在这里统一管理。
 *
 * 连接数 = 打开的标签页数。事件是"状态变了，自己去拉"的信号，不带完整状态：
 * 前端复用已有的 loadTasks / loadRuns / loadBrowserStatus，服务端不必再维护一份
 * 序列化逻辑，而且拉取走 fetchJson，会话失效时能正常走 401 跳登录页那条路。
 */
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(0); // 监听者数量由标签页数决定，不设上限

/** @type {Set<import('http').ServerResponse>} */
const clients = new Set();

// 心跳：CF Tunnel / nginx 一类中间层会掐掉长时间静默的连接，定期发注释行保活。
const HEARTBEAT_MS = 25000;

function write(res, chunk) {
  try {
    res.write(chunk);
    return true;
  } catch {
    // 连接已断。清理由 on('close') 负责，这里不让异常冒到调用方 —— 状态变更的
    // 主流程不能因为某个已死的 SSE 连接而失败。
    return false;
  }
}

function frame(event, payload) {
  const data = payload === undefined ? null : payload;
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * 注册一个 SSE 客户端。响应头由路由层设置。
 */
function addClient(res) {
  clients.add(res);

  const keepalive = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(keepalive);
      clients.delete(res);
      return;
    }
    // 以 ':' 开头是 SSE 注释行，浏览器不会当成消息派发给 onmessage
    write(res, ': keepalive\n\n');
  }, HEARTBEAT_MS);
  // 心跳定时器不该拖着进程不退出
  if (typeof keepalive.unref === 'function') keepalive.unref();

  const cleanup = () => {
    clearInterval(keepalive);
    clients.delete(res);
  };
  res.on('close', cleanup);
  res.on('error', cleanup);

  // 只给这条新连接发一次，不广播 —— 否则新开一个标签页会让其它所有标签页跟着刷。
  // 作用是补上"连接建立前发生的变化"，前端收到后拉一次全量状态。
  write(res, frame('state', null));
}

/** 广播一个事件给所有已连接的客户端。 */
function emit(event, payload) {
  bus.emit(event, payload);
  const chunk = frame(event, payload);
  for (const res of clients) write(res, chunk);
}

function clientCount() {
  return clients.size;
}

function closeAll() {
  for (const res of clients) {
    try { res.end(); } catch { /* ignore disconnected clients */ }
  }
  clients.clear();
}

module.exports = {
  emit,
  addClient,
  clientCount,
  closeAll,
  bus,
};
