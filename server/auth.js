'use strict';

/**
 * 面板登录鉴权。
 *
 * 不引入新依赖：密码用 Node 内置 crypto 的 scrypt，会话存 SQLite，
 * Cookie 手写解析（全站只有一个 Cookie，不值得为它装 cookie-parser）。
 *
 * 两个容易踩的点，改动时别改回去：
 *   1) /api/* 的未鉴权响应必须是 401 JSON，不能重定向 —— public/app.js 的
 *      fetchJson 遇到 HTML 响应会报"后端路由可能异常"，把真实原因盖掉。
 *   2) Secure 属性只在请求本身是 HTTPS 时才加 —— 当前是纯 HTTP 部署，
 *      无条件加 Secure 会让浏览器直接丢弃 Cookie，表现为"登录成功但立刻被踢回登录页"。
 */

const crypto = require('crypto');
const express = require('express');

const db = require('./db');

const COOKIE_NAME = 'panel_sess';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天（默认，不勾"记住我"）
const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天（勾选"记住我"）
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const MIN_PASSWORD_LEN = 8;

// 登录失败限流：内存 Map，重启即清空。防的是在线爆破，不是持久封禁。
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const loginFailures = new Map(); // ip -> { count, firstAt, lockedUntil }

// ---------------------------------------------------------------------------
// 密码哈希
// ---------------------------------------------------------------------------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    // 长度不等时 timingSafeEqual 会抛，先挡一道
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// ---------------------------------------------------------------------------
// Cookie
// ---------------------------------------------------------------------------

function parseCookies(header) {
  const out = {};
  String(header || '')
    .split(';')
    .forEach((part) => {
      const idx = part.indexOf('=');
      if (idx < 0) return;
      const key = part.slice(0, idx).trim();
      if (!key) return;
      try {
        out[key] = decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        out[key] = part.slice(idx + 1).trim();
      }
    });
  return out;
}

function isHttps(req) {
  if (req.secure) return true;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function setSessionCookie(req, res, token, maxAgeMs) {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (isHttps(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(req, res) {
  const attrs = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (isHttps(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function readToken(req) {
  return parseCookies(req.headers.cookie)[COOKIE_NAME] || '';
}

// ---------------------------------------------------------------------------
// 限流
// ---------------------------------------------------------------------------

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.ip || req.socket?.remoteAddress || 'unknown';
}

function loginLockRemainingMs(ip) {
  const rec = loginFailures.get(ip);
  if (!rec || !rec.lockedUntil) return 0;
  const left = rec.lockedUntil - Date.now();
  if (left <= 0) {
    loginFailures.delete(ip);
    return 0;
  }
  return left;
}

function recordLoginFailure(ip) {
  const rec = loginFailures.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= LOGIN_MAX_FAILURES) {
    rec.lockedUntil = Date.now() + LOGIN_LOCK_MS;
    rec.count = 0;
  }
  loginFailures.set(ip, rec);
}

function clearLoginFailures(ip) {
  loginFailures.delete(ip);
}

// ---------------------------------------------------------------------------
// 中间件
// ---------------------------------------------------------------------------

// 免鉴权的静态资源。登录页自己要能加载，否则连输密码的界面都出不来。
const PUBLIC_PATHS = new Set([
  '/login.html',
  '/login.js',
  '/styles.css',
  '/favicon.ico',
]);

// Telegram webhook 必须免鉴权：它是 Telegram 服务器发起的回调，带不了 Cookie，
// 靠 URL 里的 bot token 自证身份（index.js 里已有 token 校验）。
//
// 这里用路径前缀放行、而不是把路由挪到 requireAuth 之前，是有意的：
// 靠"注册顺序"来保证免鉴权太脆——以后谁重排一下 index.js 的路由，
// webhook 就会被静默拦住，表现为 Telegram 重试按钮全部失灵，很难查。
const PUBLIC_PATH_PREFIXES = ['/api/telegram/webhook/'];

function isPublicPath(pathname) {
  const p = String(pathname || '');
  if (PUBLIC_PATHS.has(p)) return true;
  return PUBLIC_PATH_PREFIXES.some((prefix) => p.startsWith(prefix));
}

function requireAuth(req, res, next) {
  if (isPublicPath(req.path)) return next();

  const token = readToken(req);
  const session = token ? db.getSessionUser(hashToken(token)) : null;

  if (session) {
    req.panelUser = { id: session.id, username: session.username };
    req.panelSessionTokenHash = hashToken(token);
    return next();
  }

  // 无效/过期 token 就把 Cookie 清掉，免得浏览器一直带着它重试
  if (token) clearSessionCookie(req, res);

  // API 要 JSON，页面要跳转 —— 见文件头注释第 1 条
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ message: '请先登录', code: 'unauthenticated' });
  }
  // 带上原路径，登录后能回到原来想去的地方（login.js 只接受站内相对路径）
  const wanted = req.originalUrl && req.originalUrl !== '/' ? req.originalUrl : '';
  const suffix = wanted ? `?next=${encodeURIComponent(wanted)}` : '';
  return res.redirect(302, `/login.html${suffix}`);
}

// ---------------------------------------------------------------------------
// 路由：/api/auth/*
// ---------------------------------------------------------------------------

function validatePasswordInput(password, confirm) {
  const pwd = String(password || '');
  if (pwd.length < MIN_PASSWORD_LEN) {
    return `密码至少 ${MIN_PASSWORD_LEN} 位`;
  }
  if (confirm !== undefined && pwd !== String(confirm || '')) {
    return '两次输入的密码不一致';
  }
  return null;
}

function issueSession(req, res, user, remember = false) {
  const token = crypto.randomBytes(32).toString('base64url');
  const ttl = remember ? REMEMBER_TTL_MS : SESSION_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl).toISOString();
  db.createSession(hashToken(token), user.id, expiresAt, req.headers['user-agent'] || '');
  setSessionCookie(req, res, token, ttl);
  return { token, expiresAt };
}

// 前端 checkbox 可能送来 true / 1 / 'true' / '1'，统一收敛成布尔。
function parseRememberFlag(payload) {
  const v = payload && payload.remember;
  return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
}

const router = express.Router();

// 免鉴权：前端靠这个决定是走引导页还是登录页
router.get('/state', (req, res) => {
  const token = readToken(req);
  const session = token ? db.getSessionUser(hashToken(token)) : null;
  res.json({
    data: {
      needsSetup: !db.hasAnyUser(),
      authenticated: Boolean(session),
      username: session ? session.username : '',
    },
  });
});

// 免鉴权，但只能用一次：已有用户后返回 409
router.post('/setup', (req, res) => {
  if (db.hasAnyUser()) {
    return res.status(409).json({ message: '已经初始化过了，请直接登录' });
  }
  const payload = req.body || {};
  const username = String(payload.username || '').trim();
  if (!username || username.length > 64) {
    return res.status(400).json({ message: '用户名不能为空且不超过 64 字符' });
  }
  const bad = validatePasswordInput(payload.password, payload.confirmPassword);
  if (bad) return res.status(400).json({ message: bad });

  try {
    const user = db.createUser(username, hashPassword(payload.password));
    issueSession(req, res, user, parseRememberFlag(payload));
    res.json({ data: { username: user.username } });
  } catch (error) {
    res.status(400).json({ message: error.message || '初始化失败' });
  }
});

router.post('/login', (req, res) => {
  const ip = clientIp(req);
  const lockLeft = loginLockRemainingMs(ip);
  if (lockLeft > 0) {
    const mins = Math.ceil(lockLeft / 60000);
    return res.status(429).json({ message: `失败次数过多，请 ${mins} 分钟后再试` });
  }

  const payload = req.body || {};
  const username = String(payload.username || '').trim();
  const password = String(payload.password || '');
  const user = username ? db.getUserByUsername(username) : null;

  // 用户不存在时也走一遍哈希校验，避免用响应时间区分"用户名对不对"
  const ok = user
    ? verifyPassword(password, user.password_hash)
    : verifyPassword(password, hashPassword('__nonexistent__'));

  if (!user || !ok) {
    recordLoginFailure(ip);
    return res.status(401).json({ message: '用户名或密码错误' });
  }

  clearLoginFailures(ip);
  db.purgeExpiredSessions();
  // 记住我：勾选后 30 天，否则 7 天
  issueSession(req, res, user, parseRememberFlag(req.body));
  res.json({ data: { username: user.username } });
});

router.post('/logout', (req, res) => {
  const token = readToken(req);
  if (token) db.deleteSession(hashToken(token));
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

// 需鉴权。requireAuth 挂在这个 router 之后，所以这里手动查一次身份。
router.post('/change-password', (req, res) => {
  const token = readToken(req);
  const session = token ? db.getSessionUser(hashToken(token)) : null;
  if (!session) {
    return res.status(401).json({ message: '请先登录', code: 'unauthenticated' });
  }

  const payload = req.body || {};
  const user = db.getUserById(session.id);
  if (!user || !verifyPassword(String(payload.currentPassword || ''), user.password_hash)) {
    return res.status(400).json({ message: '当前密码不正确' });
  }
  const bad = validatePasswordInput(payload.newPassword, payload.confirmPassword);
  if (bad) return res.status(400).json({ message: bad });

  db.updateUserPassword(user.id, hashPassword(payload.newPassword));
  // 改完密码把其他会话踢掉，只留当前这个
  db.deleteSessionsForUser(user.id, hashToken(token));
  res.json({ ok: true, data: { username: user.username } });
});

module.exports = {
  router,
  requireAuth,
  hashPassword,
  verifyPassword,
  hashToken,
  parseCookies,
  isPublicPath,
  COOKIE_NAME,
  SESSION_TTL_MS,
  REMEMBER_TTL_MS,
  MIN_PASSWORD_LEN,
};
