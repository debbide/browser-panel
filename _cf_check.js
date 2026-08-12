'use strict';
// 验证 CF Tunnel 场景：回源是 HTTP，但带 X-Forwarded-Proto: https
const dbPath = require.resolve('./server/db.js');
const users = []; const sessions = new Map();
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, children: [], paths: [], exports: {
  hasAnyUser: () => users.length > 0,
  getUserByUsername: (u) => users.find((x) => x.username === u) || null,
  getUserById: (id) => users.find((x) => x.id === id) || null,
  createUser: (username, h) => { const u = { id: users.length + 1, username, password_hash: h }; users.push(u); return u; },
  updateUserPassword: () => {},
  createSession: (th, uid, exp) => sessions.set(th, { user_id: uid, expires_at: exp }),
  getSessionUser: (th) => { const s = sessions.get(th); if (!s || new Date(s.expires_at) <= Date.now()) return null; const u = users.find((x) => x.id === s.user_id); return u ? { id: u.id, username: u.username } : null; },
  deleteSession: (th) => sessions.delete(th),
  deleteSessionsForUser: () => {}, purgeExpiredSessions: () => {},
} };

const express = require('express');
const { router, requireAuth } = require('./server/auth');
const app = express();
app.use(express.json());
app.use('/api/auth', router);
app.use(requireAuth);
app.get('/api/whoami', (req, res) => res.json({ user: req.panelUser.username, ip: req.ip }));

let pass = 0; let fail = 0;
const ck = (n, c, e) => { if (c) { pass += 1; console.log('  PASS  ' + n); } else { fail += 1; console.log('  FAIL  ' + n + (e ? '  <' + e + '>' : '')); } };
const srv = app.listen(0, '127.0.0.1', main);
const B = () => 'http://127.0.0.1:' + srv.address().port;

async function main() {
  const setup = (h) => fetch(B() + '/api/auth/setup', { method: 'POST', redirect: 'manual', headers: Object.assign({ 'Content-Type': 'application/json' }, h), body: JSON.stringify({ username: 'admin', password: 'hunter2hunter2', confirmPassword: 'hunter2hunter2' }) });
  const login = (h) => fetch(B() + '/api/auth/login', { method: 'POST', redirect: 'manual', headers: Object.assign({ 'Content-Type': 'application/json' }, h), body: JSON.stringify({ username: 'admin', password: 'hunter2hunter2' }) });

  console.log('\n[A] 直连（无 XFP）——不该加 Secure');
  let r = await setup();
  let sc = r.headers.getSetCookie()[0] || '';
  ck('无 Secure', !/Secure/.test(sc), sc);

  console.log('\n[B] CF Tunnel 回源（X-Forwarded-Proto: https）——应该加 Secure');
  r = await login({ 'x-forwarded-proto': 'https' });
  sc = r.headers.getSetCookie()[0] || '';
  ck('加了 Secure', /Secure/.test(sc), sc);
  ck('同时保留 HttpOnly/SameSite', /HttpOnly/.test(sc) && /SameSite=Strict/.test(sc), sc);

  console.log('\n[C] CF 常见的多值 XFP（"https,http"）——取第一个');
  r = await login({ 'x-forwarded-proto': 'https,http' });
  sc = r.headers.getSetCookie()[0] || '';
  ck('多值仍判定 https', /Secure/.test(sc), sc);

  console.log('\n[D] XFP=http（纯 HTTP 反代）——不加 Secure');
  r = await login({ 'x-forwarded-proto': 'http' });
  sc = r.headers.getSetCookie()[0] || '';
  ck('不加 Secure', !/Secure/.test(sc), sc);

  console.log('\n[E] 限流按真实客户端 IP（X-Forwarded-For）而非隧道 IP');
  const cookie = ((await login({ 'x-forwarded-proto': 'https' })).headers.getSetCookie()[0] || '').split(';')[0];
  const bad = (ip) => fetch(B() + '/api/auth/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ username: 'admin', password: 'wrongwrongwrong' }) });
  const codesA = []; for (let i = 0; i < 6; i += 1) codesA.push((await bad('203.0.113.9')).status);
  ck('客户端 A 连错 5 次 → 第 6 次 429', codesA.slice(0, 5).every((c) => c === 401) && codesA[5] === 429, codesA.join(','));
  const codeB = (await bad('198.51.100.7')).status;
  ck('客户端 B 不受 A 的锁定影响（→401 非 429）', codeB === 401, 'got ' + codeB);

  console.log('\n[F] 已登录 Cookie 在 CF 场景下正常识别');
  r = await fetch(B() + '/api/whoami', { headers: { cookie, 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' } });
  const j = await r.json().catch(() => ({}));
  ck('/api/whoami → 200 admin', r.status === 200 && j.user === 'admin', r.status + ' ' + JSON.stringify(j));

  console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed');
  srv.close(); process.exit(fail ? 1 : 0);
}
