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
const totp = require('./totp');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { isoBase64URL } = require('@simplewebauthn/server/helpers');

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
// 登录票据（二步验证用）
// ---------------------------------------------------------------------------

// 密码校验通过但开了 TOTP 时，不直接发会话，先发票据。票据单次有效、
// 2 分钟过期、连续输错 5 次即作废——作废后只能重新输密码换新票据。
const TICKET_TTL_MS = 2 * 60 * 1000;
const TICKET_MAX_ATTEMPTS = 5;
const loginTickets = new Map(); // ticket -> { userId, ip, expiresAt, attempts }

function issueLoginTicket(userId, ip) {
  const ticket = crypto.randomBytes(32).toString('base64url');
  loginTickets.set(ticket, { userId, ip, expiresAt: Date.now() + TICKET_TTL_MS, attempts: 0 });
  return ticket;
}

// 只读取出，不删——验码成功/失败时由调用方决定去留（失败要留着累计次数）。
function consumeLoginTicket(ticket) {
  if (!ticket) return null;
  const rec = loginTickets.get(ticket);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) {
    loginTickets.delete(ticket);
    return null;
  }
  return rec;
}

function invalidateLoginTicket(ticket) {
  if (ticket) loginTickets.delete(ticket);
}

// ---------------------------------------------------------------------------
// Passkey challenge（注册/登录各一次，5 分钟过期）
// ---------------------------------------------------------------------------

const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const passkeyChallenges = new Map(); // challenge -> { kind, userId?, name?, expiresAt }

function storePasskeyChallenge(challenge, payload) {
  passkeyChallenges.set(challenge, { ...payload, expiresAt: Date.now() + PASSKEY_CHALLENGE_TTL_MS });
}

// 取用即删除（单次）。kind 不匹配或过期返回 null。
function takePasskeyChallenge(challenge, kind) {
  if (!challenge) return null;
  const rec = passkeyChallenges.get(challenge);
  if (!rec) return null;
  passkeyChallenges.delete(challenge);
  if (rec.kind !== kind || Date.now() > rec.expiresAt) return null;
  return rec;
}

// ---------------------------------------------------------------------------
// TOTP 启用流程：setup 生成秘钥但先不落库，confirm 输对一次码才启用，
// 避免"生成了没验证就保存"把自己锁在门外。
// ---------------------------------------------------------------------------

const TOTP_SETUP_TTL_MS = 10 * 60 * 1000;
const pendingTotpSecrets = new Map(); // userId -> { secret, expiresAt }

function getPendingTotpSecret(userId) {
  const rec = pendingTotpSecrets.get(userId);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) {
    pendingTotpSecrets.delete(userId);
    return null;
  }
  return rec.secret;
}

// ---------------------------------------------------------------------------
// WebAuthn RP 解析
// ---------------------------------------------------------------------------

// RP ID 必须是"请求的主机名"（去掉端口）。CF 隧道把域名放在 x-forwarded-host，
// 直连时才用 Host 头。登录/注册都发生在同一 origin，按请求动态解析即可，不用配死域名。
function rpID(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0].trim();
  return host.replace(/:\d+$/, '').toLowerCase();
}

// 浏览器 clientDataJSON.origin 必须和这个一致，否则 verify 抛错。
// 隧道场景：cloudflared 只转发 HTTP，真实协议在 x-forwarded-proto 里。
function originFromRequest(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (isHttps(req) ? 'https' : 'http');
  return `${proto}://${host}`;
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

  // 开了 TOTP：不直接发会话，先发票据，等第二步验码换会话。
  if (db.getUserTotpSecret(user.id)) {
    const ticket = issueLoginTicket(user.id, ip);
    return res.json({
      data: {
        username: user.username,
        twoFactor: { required: true, ticket },
      },
    });
  }

  // 记住我：勾选后 30 天，否则 7 天
  issueSession(req, res, user, parseRememberFlag(req.body));
  res.json({ data: { username: user.username } });
});

// 登录第二步：票据 + TOTP 动态码换会话。
// 票据 2 分钟过期、连错 5 次作废——作废后必须重新输密码换新票据。
router.post('/totp/verify', (req, res) => {
  const payload = req.body || {};
  const rec = consumeLoginTicket(payload.ticket);
  if (!rec) {
    return res.status(401).json({ message: '登录会话已过期，请重新输入密码' });
  }

  // 票据绑定发放时的 IP：换 IP 了（或票据被搬到别处）直接作废，重新输密码
  if (rec.ip !== clientIp(req)) {
    invalidateLoginTicket(payload.ticket);
    return res.status(401).json({ message: '登录环境已变化，请重新输入密码' });
  }

  const user = db.getUserById(rec.userId);
  const secret = user ? db.getUserTotpSecret(user.id) : null;
  if (!user || !secret) {
    invalidateLoginTicket(payload.ticket);
    return res.status(401).json({ message: '登录会话已过期，请重新输入密码' });
  }

  if (!totp.verifyCode(secret, payload.code)) {
    rec.attempts += 1;
    if (rec.attempts >= TICKET_MAX_ATTEMPTS) {
      invalidateLoginTicket(payload.ticket);
      return res.status(401).json({ message: '验证码错误次数过多，请重新输入密码' });
    }
    return res.status(401).json({ message: `验证码不正确，还可尝试 ${TICKET_MAX_ATTEMPTS - rec.attempts} 次` });
  }

  invalidateLoginTicket(payload.ticket);
  // 记住我：勾选后 30 天，否则 7 天
  issueSession(req, res, user, parseRememberFlag(payload));
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

// ---------------------------------------------------------------------------
// 2FA 管理（TOTP 开关 + 通行密钥增删）
// ---------------------------------------------------------------------------

// 统一入口：既要在有效会话里，又要验当前密码。返回 user；失败时已写好响应，返回 null。
// 注意失败分支不要 return res.status(...) 链——那是响应对象（truthy），调用方会当成用户。
function require2faAccess(req, res) {
  const token = readToken(req);
  const session = token ? db.getSessionUser(hashToken(token)) : null;
  if (!session) {
    res.status(401).json({ message: '请先登录', code: 'unauthenticated' });
    return null;
  }
  const user = db.getUserById(session.id);
  if (!user) {
    res.status(401).json({ message: '请先登录', code: 'unauthenticated' });
    return null;
  }
  if (!verifyPassword(String((req.body || {}).currentPassword || ''), user.password_hash)) {
    res.status(400).json({ message: '当前密码不正确' });
    return null;
  }
  return user;
}

function safeParseTransports(raw) {
  try {
    const arr = JSON.parse(String(raw || '[]'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// 返回当前两步验证状态：TOTP 是否开启 + 已注册的通行密钥列表。
router.post('/2fa/status', (req, res) => {
  const user = require2faAccess(req, res);
  if (!user) return;
  res.json({
    data: {
      totpEnabled: Boolean(db.getUserTotpSecret(user.id)),
      passkeys: db.listPasskeys(user.id),
    },
  });
});

// 生成 TOTP 秘钥和 otpauth 链接，先不落库。
router.post('/2fa/totp/setup', (req, res) => {
  const user = require2faAccess(req, res);
  if (!user) return;
  if (db.getUserTotpSecret(user.id)) {
    return res.status(400).json({ message: 'TOTP 已启用，请先关闭再重新设置' });
  }
  const secret = totp.generateSecret();
  pendingTotpSecrets.set(user.id, { secret, expiresAt: Date.now() + TOTP_SETUP_TTL_MS });
  const otpauthUrl = totp.otpauthUrl('BrowserPanel', user.username, secret);
  res.json({ data: { secret, otpauthUrl } });
});

// 输对一次动态码才启用 TOTP，防止生成完没验证就锁死自己。
router.post('/2fa/totp/confirm', (req, res) => {
  const user = require2faAccess(req, res);
  if (!user) return;
  const secret = getPendingTotpSecret(user.id);
  if (!secret) {
    return res.status(400).json({ message: '设置已过期，请重新开始' });
  }
  if (!totp.verifyCode(secret, req.body.code)) {
    return res.status(400).json({ message: '验证码不正确' });
  }
  db.setUserTotpSecret(user.id, secret);
  pendingTotpSecrets.delete(user.id);
  res.json({ ok: true, data: { totpEnabled: true } });
});

router.post('/2fa/totp/disable', (req, res) => {
  const user = require2faAccess(req, res);
  if (!user) return;
  db.setUserTotpSecret(user.id, null);
  pendingTotpSecrets.delete(user.id);
  res.json({ ok: true, data: { totpEnabled: false } });
});

// 注册通行密钥：第一步发 challenge。residentKey=required 让它成为 discoverable
// 凭证，登录页才能不输账号直接列出候选。userVerification=required 保证密钥
// 本身做过生物/PIN 解锁——它是免密通道，必须比"密码+TOTP"更严。
router.post('/2fa/passkey/register/challenge', async (req, res) => {
  const user = require2faAccess(req, res);
  if (!user) return;
  const name = String((req.body || {}).name || '').trim().slice(0, 60);
  const existing = db.listPasskeys(user.id);
  try {
    const options = await generateRegistrationOptions({
      rpName: 'BrowserPanel',
      rpID: rpID(req),
      userName: user.username,
      userID: Buffer.from(String(user.id)),
      userDisplayName: user.username,
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
      excludeCredentials: existing.map((pk) => ({
        id: pk.credential_id,
        transports: safeParseTransports(pk.transports),
      })),
    });
    storePasskeyChallenge(options.challenge, { kind: 'register', userId: user.id, name });
    res.json({ data: options });
  } catch (error) {
    res.status(500).json({ message: error.message || '生成注册凭证失败' });
  }
});

// 注册通行密钥：第二步验响应、存公钥。
router.post('/2fa/passkey/register/verify', async (req, res) => {
  const user = require2faAccess(req, res);
  if (!user) return;
  const payload = req.body || {};
  const rec = takePasskeyChallenge(payload.challenge, 'register');
  if (!rec || rec.userId !== user.id) {
    return res.status(400).json({ message: '注册凭证已过期，请重新开始' });
  }
  try {
    const { verified, registrationInfo } = await verifyRegistrationResponse({
      response: payload.response,
      expectedChallenge: payload.challenge,
      expectedOrigin: originFromRequest(req),
      expectedRPID: rpID(req),
    });
    if (!verified || !registrationInfo) {
      return res.status(400).json({ message: '通行密钥注册校验失败' });
    }
    const { credential } = registrationInfo;
    if (db.getPasskeyByCredentialId(credential.id)) {
      return res.status(400).json({ message: '该通行密钥已注册过' });
    }
    db.addPasskey({
      userId: user.id,
      credentialId: credential.id,
      publicKey: isoBase64URL.fromBuffer(credential.publicKey),
      counter: credential.counter,
      transports: JSON.stringify(credential.transports || []),
      userHandle: isoBase64URL.fromBuffer(Buffer.from(String(user.id))),
      name: rec.name || '',
    });
    res.json({ ok: true, data: { passkeys: db.listPasskeys(user.id) } });
  } catch (error) {
    res.status(400).json({ message: error.message || '通行密钥注册校验失败' });
  }
});

router.post('/2fa/passkey/delete', (req, res) => {
  const user = require2faAccess(req, res);
  if (!user) return;
  const id = Number((req.body || {}).id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ message: '缺少通行密钥 ID' });
  }
  db.deletePasskey(id, user.id);
  res.json({ ok: true, data: { passkeys: db.listPasskeys(user.id) } });
});

// ---------------------------------------------------------------------------
// 通行密钥直接登录（免密）。与"密码+TOTP"完全分开的两条路。
// ---------------------------------------------------------------------------

// 第一步：发 challenge。allowCredentials 为空 → 浏览器列出所有本站的
// discoverable 凭证，用户挑一把解锁。
router.post('/passkey/login/challenge', async (req, res) => {
  // 一个都没有时直接说清楚，免得浏览器弹"无可用凭证"让人摸不着头脑
  if (!db.hasAnyPasskey()) {
    return res.status(400).json({ message: '还没有注册任何通行密钥，请先在设置里添加' });
  }
  try {
    const options = await generateAuthenticationOptions({
      rpID: rpID(req),
      allowCredentials: [],
      userVerification: 'required',
    });
    storePasskeyChallenge(options.challenge, { kind: 'login' });
    res.json({ data: options });
  } catch (error) {
    res.status(500).json({ message: error.message || '生成登录凭证失败' });
  }
});

// 第二步：按 credential_id 找到这把钥匙属于哪个账号，验断言签名后发 30 天会话。
router.post('/passkey/login/verify', async (req, res) => {
  const payload = req.body || {};
  const rec = takePasskeyChallenge(payload.challenge, 'login');
  if (!rec) {
    return res.status(401).json({ message: '登录凭证已过期，请刷新后重试' });
  }

  const response = payload.response;
  const passkey = response && response.id ? db.getPasskeyByCredentialId(response.id) : null;
  if (!passkey) {
    return res.status(400).json({ message: '该通行密钥未在本站注册' });
  }

  // 库不校验 userHandle，这里自己兜一道：凭证声明属于谁，登录就必须是那个账号
  const returnedHandle = response.response && response.response.userHandle;
  if (returnedHandle && passkey.user_handle && returnedHandle !== passkey.user_handle) {
    return res.status(400).json({ message: '通行密钥与账号不匹配' });
  }

  const user = db.getUserById(passkey.user_id);
  if (!user) {
    return res.status(400).json({ message: '该通行密钥所属账号已不存在' });
  }

  try {
    const { verified, authenticationInfo } = await verifyAuthenticationResponse({
      response,
      expectedChallenge: payload.challenge,
      expectedOrigin: originFromRequest(req),
      expectedRPID: rpID(req),
      credential: {
        id: passkey.credential_id,
        publicKey: isoBase64URL.toBuffer(passkey.public_key),
        counter: passkey.counter,
      },
    });
    if (!verified) {
      return res.status(400).json({ message: '通行密钥校验失败' });
    }
    db.updatePasskeyCounter(passkey.credential_id, authenticationInfo.newCounter);
  } catch (error) {
    return res.status(400).json({ message: error.message || '通行密钥校验失败' });
  }

  // 通行密钥登录固定 30 天，不受"记住我"影响
  issueSession(req, res, user, true);
  res.json({ data: { username: user.username } });
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
