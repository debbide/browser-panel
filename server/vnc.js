'use strict';

// 内嵌 noVNC：面板进程内提供 WebSocket→VNC(TCP) 桥接，替代独立的 websockify 进程。
//
// 架构：
// - 静态客户端文件 public/vnc/* 由面板统一静态托管（挂在 requireAuth 之后，天然带登录态）。
// - 浏览器 noVNC 连 wss://<panel>/vnc/websockify，本模块在 upgrade 阶段验会话，
//   通过后把 WS 双向管道接到 VNC 服务端（默认 127.0.0.1:5901 的 x11vnc）。
// - x11vnc 只监听 127.0.0.1，唯一入口是这条带鉴权的桥；VNC 密码由 noVNC 客户端
//   与 x11vnc 直接协商（字节透传），桥本身不碰 RFB 认证。

const net = require('net');
const { WebSocketServer } = require('ws');
const auth = require('./auth');

const VNC_WS_PATH = '/vnc/websockify';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 5901;
const TEST_TIMEOUT_MS = 5000;

function getVncSettings(db) {
  const enabled = db.getSetting('vnc_enabled') === '1';
  const host = (db.getSetting('vnc_host') || '').trim() || DEFAULT_HOST;
  const portRaw = Number.parseInt(db.getSetting('vnc_port'), 10);
  const port = Number.isInteger(portRaw) && portRaw >= 1 && portRaw <= 65535 ? portRaw : DEFAULT_PORT;
  return { enabled, host, port };
}

function normalizeVncInput(body) {
  const input = body || {};
  const enabled = Boolean(input.enabled);
  const host = String(input.host == null ? '' : input.host).trim();
  const portRaw = input.port;
  const port = typeof portRaw === 'number' ? portRaw : Number.parseInt(String(portRaw), 10);
  if (!host) throw new Error('VNC 地址不能为空');
  if (host.length > 255) throw new Error('VNC 地址过长');
  // 主机名/IP 的宽松校验：拒绝空白与明显非法的字符，细粒度留给连接阶段报错。
  if (/[\s'"`;|&$<>\\]/.test(host)) throw new Error('VNC 地址含非法字符');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('VNC 端口必须是 1-65535 的整数');
  return { enabled, host, port };
}

function saveVncSettings(db, body) {
  const normalized = normalizeVncInput(body);
  db.setSetting('vnc_enabled', normalized.enabled ? '1' : '0');
  db.setSetting('vnc_host', normalized.host);
  db.setSetting('vnc_port', String(normalized.port));
  console.log(`[vnc] settings saved: enabled=${normalized.enabled} ${normalized.host}:${normalized.port}`);
  return getVncSettings(db);
}

// 只测 TCP 可达性：连上即成功，不发 RFB 握手。
function testVncConnection(host, port, timeoutMs = TEST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(result);
    };
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      finish({ ok: false, error: `连接超时（${timeoutMs}ms）` });
    }, timeoutMs);
    if (timer.unref) timer.unref();
    socket.once('connect', () => {
      clearTimeout(timer);
      finish({ ok: true, latencyMs: Date.now() - started });
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      finish({ ok: false, error: error.message || '连接失败' });
    });
  });
}

function createVncRouter({ db } = {}) {
  if (!db) throw new Error('db is required');
  const express = require('express');
  const router = express.Router();

  router.get('/settings', (req, res) => {
    res.json({ data: getVncSettings(db) });
  });

  router.post('/settings', (req, res) => {
    try {
      res.json({ data: saveVncSettings(db, req.body) });
    } catch (error) {
      res.status(400).json({ message: error.message || '保存远程桌面设置失败' });
    }
  });

  router.post('/test', async (req, res) => {
    try {
      const saved = getVncSettings(db);
      const body = req.body || {};
      const host = String(body.host == null || body.host === '' ? saved.host : body.host).trim();
      const portRaw = body.port == null || body.port === '' ? saved.port : body.port;
      const port = typeof portRaw === 'number' ? portRaw : Number.parseInt(String(portRaw), 10);
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        res.status(400).json({ message: 'VNC 地址或端口无效' });
        return;
      }
      const result = await testVncConnection(host, port);
      res.json({ data: { host, port, ...result } });
    } catch (error) {
      res.status(500).json({ message: error.message || '测试连接失败' });
    }
  });

  return router;
}

// WS→TCP 桥：ws 的 message（Buffer，二进制帧）直写 TCP；TCP 回包 ws.send(Buffer) 发二进制帧。
function bridgeConnection(ws, host, port) {
  const target = net.connect(port, host);
  let closed = false;
  const closeBoth = () => {
    if (closed) return;
    closed = true;
    try { ws.close(); } catch { /* ignore */ }
    try { target.destroy(); } catch { /* ignore */ }
  };
  target.on('data', (chunk) => {
    if (ws.readyState === 1) {
      try {
        ws.send(chunk);
      } catch {
        closeBoth();
      }
    }
  });
  target.on('error', closeBoth);
  target.on('close', closeBoth);
  ws.on('message', (data) => {
    try {
      target.write(data);
    } catch {
      closeBoth();
    }
  });
  ws.on('error', closeBoth);
  ws.on('close', closeBoth);
}

function createVncUpgradeHandler({ db } = {}) {
  if (!db) throw new Error('db is required');
  const wss = new WebSocketServer({ noServer: true });

  return function handleVncUpgrade(req, socket, head) {
    const deny = (code, text) => {
      try {
        socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      } catch { /* ignore */ }
      socket.destroy();
    };
    // 开关没开：桥不存在，直接拒。
    if (!getVncSettings(db).enabled) {
      deny(403, 'Forbidden');
      return;
    }
    // upgrade 阶段没有 Express 中间件，手动验面板会话 Cookie。
    let session = null;
    try {
      const token = auth.parseCookies(req.headers.cookie)[auth.COOKIE_NAME] || '';
      session = token ? db.getSessionUser(auth.hashToken(token)) : null;
    } catch { /* ignore -> session stays null */ }
    if (!session) {
      deny(401, 'Unauthorized');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const settings = getVncSettings(db);
      console.log(`[vnc] bridge opened by ${session.username || session.id} -> ${settings.host}:${settings.port}`);
      bridgeConnection(ws, settings.host, settings.port);
    });
  };
}

module.exports = {
  VNC_WS_PATH,
  DEFAULT_HOST,
  DEFAULT_PORT,
  getVncSettings,
  saveVncSettings,
  normalizeVncInput,
  testVncConnection,
  createVncRouter,
  createVncUpgradeHandler,
};
