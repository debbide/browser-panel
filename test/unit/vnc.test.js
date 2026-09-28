const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { WebSocket } = require('ws');

const auth = require('../../server/auth');
const {
  VNC_WS_PATH,
  DEFAULT_HOST,
  DEFAULT_PORT,
  getVncSettings,
  saveVncSettings,
  normalizeVncInput,
  testVncConnection,
  createVncUpgradeHandler,
} = require('../../server/vnc');

// 用内存 fake db，避免碰真实 app.db（参考其它单测的 withXxx 恢复模式，这里直接隔离）。
function fakeDb(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getSetting: (k) => (store.has(k) ? store.get(k) : null),
    setSetting: (k, v) => {
      if (v === null || v === undefined || v === '') store.delete(k);
      else store.set(k, v);
    },
    getSessionUser: () => null,
  };
}

test('getVncSettings: 默认值', () => {
  const s = getVncSettings(fakeDb());
  assert.equal(s.enabled, false);
  assert.equal(s.host, DEFAULT_HOST);
  assert.equal(s.port, DEFAULT_PORT);
});

test('saveVncSettings: 正常保存与回读', () => {
  const db = fakeDb();
  const saved = saveVncSettings(db, { enabled: true, host: '10.0.0.5', port: 5902 });
  assert.deepEqual(saved, { enabled: true, host: '10.0.0.5', port: 5902 });
  assert.deepEqual(getVncSettings(db), saved);
});

test('normalizeVncInput: 非法输入抛错', () => {
  assert.throws(() => normalizeVncInput({ enabled: true, host: '', port: 5901 }), /地址不能为空/);
  assert.throws(() => normalizeVncInput({ enabled: true, host: '127.0.0.1', port: 0 }), /端口/);
  assert.throws(() => normalizeVncInput({ enabled: true, host: '127.0.0.1', port: 70000 }), /端口/);
  assert.throws(() => normalizeVncInput({ enabled: true, host: 'a b', port: 5901 }), /非法字符/);
  assert.throws(() => normalizeVncInput({ enabled: true, host: '127.0.0.1;rm', port: 5901 }), /非法字符/);
  // 字符串端口也要能转
  assert.deepEqual(normalizeVncInput({ enabled: false, host: '127.0.0.1', port: '5901' }), {
    enabled: false, host: '127.0.0.1', port: 5901,
  });
});

test('testVncConnection: 通/不通两种结果', async () => {
  const server = net.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const ok = await testVncConnection('127.0.0.1', port);
  assert.equal(ok.ok, true);
  assert.ok(typeof ok.latencyMs === 'number');
  await new Promise((resolve) => server.close(resolve));

  const fail = await testVncConnection('127.0.0.1', port, 2000);
  assert.equal(fail.ok, false);
  assert.ok(fail.error);
});

// 端到端：fake VNC 服务端 <-> 面板 upgrade 桥 <-> 真实 ws 客户端
async function withBridgeEnv(t, { enabled = true, withCookie = true } = {}) {
  // fake VNC：连上先发 HELLO，之后原样 echo
  const vncServer = net.createServer((socket) => {
    socket.write(Buffer.from('HELLO'));
    socket.on('data', (chunk) => socket.write(chunk));
  });
  await new Promise((resolve) => vncServer.listen(0, '127.0.0.1', resolve));
  const vncPort = vncServer.address().port;

  const token = 'vnc-test-token';
  const db = fakeDb({
    vnc_enabled: enabled ? '1' : '0',
    vnc_host: '127.0.0.1',
    vnc_port: String(vncPort),
  });
  db.getSessionUser = (hash) => (hash === auth.hashToken(token) ? { id: 1, username: 'tester' } : null);

  const handleUpgrade = createVncUpgradeHandler({ db });
  const httpServer = http.createServer();
  httpServer.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://127.0.0.1').pathname === VNC_WS_PATH) handleUpgrade(req, socket, head);
    else socket.destroy();
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const httpPort = httpServer.address().port;

  t.after(() => {
    httpServer.close();
    vncServer.close();
  });
  return { httpPort, cookie: withCookie ? `${auth.COOKIE_NAME}=${token}` : '' };
}

test('upgrade 桥：带合法会话时双向透传', async (t) => {
  const { httpPort, cookie } = await withBridgeEnv(t);
  const ws = new WebSocket(`ws://127.0.0.1:${httpPort}${VNC_WS_PATH}`, { headers: { Cookie: cookie } });
  t.after(() => ws.close());
  const received = [];
  await new Promise((resolve, reject) => {
    ws.on('message', (data) => {
      received.push(Buffer.from(data).toString());
      if (received.join('').includes('HELLO') && received.join('').includes('PING')) resolve();
    });
    ws.on('open', () => ws.send(Buffer.from('PING')));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('timeout waiting for echo')), 5000);
  });
  assert.ok(received.join('').includes('HELLO'));
  assert.ok(received.join('').includes('PING'));
});

test('upgrade 桥：无会话时被拒', async (t) => {
  const { httpPort, cookie } = await withBridgeEnv(t, { withCookie: false });
  assert.equal(cookie, '');
  const ws = new WebSocket(`ws://127.0.0.1:${httpPort}${VNC_WS_PATH}`);
  await new Promise((resolve, reject) => {
    ws.on('unexpected-response', (req, res) => {
      assert.equal(res.statusCode, 401);
      resolve();
    });
    ws.on('open', () => reject(new Error('should not open without session')));
    setTimeout(() => reject(new Error('timeout waiting for rejection')), 5000);
  });
});

test('upgrade 桥：开关关闭时被拒', async (t) => {
  const { httpPort, cookie } = await withBridgeEnv(t, { enabled: false });
  const ws = new WebSocket(`ws://127.0.0.1:${httpPort}${VNC_WS_PATH}`, { headers: { Cookie: cookie } });
  await new Promise((resolve, reject) => {
    ws.on('unexpected-response', (req, res) => {
      assert.equal(res.statusCode, 403);
      resolve();
    });
    ws.on('open', () => reject(new Error('should not open when disabled')));
    setTimeout(() => reject(new Error('timeout waiting for rejection')), 5000);
  });
});
