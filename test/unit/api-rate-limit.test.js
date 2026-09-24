const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../../server/db');
const auth = require('../../server/auth');
const {
  createApiRateLimiter,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS,
} = require('../../server/rate-limit');

// Mirrors the helper in login-xff-bypass-regression.test.js: the trusted
// proxy list lives in the panel setting security_trust_proxy.
function withTrustProxy(value, fn) {
  const prev = db.getSetting('security_trust_proxy');
  db.setSetting('security_trust_proxy', value || null);
  auth.refreshTrustProxyCache();
  try {
    fn();
  } finally {
    db.setSetting('security_trust_proxy', prev);
    auth.refreshTrustProxyCache();
  }
}

function fakeReq({ path = '/api/tasks', socketIp = '1.2.3.4', xff = null } = {}) {
  return {
    path,
    headers: xff ? { 'x-forwarded-for': xff } : {},
    socket: { remoteAddress: socketIp },
  };
}

function fakeRes() {
  const headers = {};
  const res = {
    headers,
    statusCode: 200,
    body: null,
    set(k, v) { headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  return res;
}

function runThrough(limiter, req) {
  const res = fakeRes();
  let nexted = false;
  limiter(req, res, () => { nexted = true; });
  return { res, nexted };
}

test('rate limiter exposes sane defaults', () => {
  assert.equal(RATE_LIMIT_WINDOW_MS, 60 * 1000);
  assert.ok(RATE_LIMIT_MAX_REQUESTS >= 100, 'threshold must stay generous for normal panel polling');
});

test('non-/api paths (e.g. /healthz) are never limited', () => {
  const limiter = createApiRateLimiter({ maxRequests: 2, windowMs: 60_000 });
  for (const path of ['/healthz', '/login.html', '/api']) {
    for (let i = 0; i < 5; i++) {
      const { res, nexted } = runThrough(limiter, fakeReq({ path }));
      assert.ok(nexted, `${path} should pass through`);
      assert.equal(res.statusCode, 200);
    }
  }
});

test('requests under the threshold pass; over it get 429 with Retry-After', () => {
  let t = 1_000_000;
  const limiter = createApiRateLimiter({ maxRequests: 3, windowMs: 60_000, now: () => t });
  const req = fakeReq({});
  for (let i = 0; i < 3; i++) {
    const { nexted } = runThrough(limiter, req);
    assert.ok(nexted, `request ${i + 1} should pass`);
  }
  const over = runThrough(limiter, req);
  assert.equal(over.nexted, false);
  assert.equal(over.res.statusCode, 429);
  assert.equal(over.res.body.code, 'rate_limited');
  assert.match(over.res.headers['Retry-After'], /^\d+$/);
  assert.ok(Number(over.res.headers['Retry-After']) >= 1);
});

test('sliding window frees slots as time passes', () => {
  let t = 1_000_000;
  const limiter = createApiRateLimiter({ maxRequests: 2, windowMs: 10_000, now: () => t });
  const req = fakeReq({});
  runThrough(limiter, req);
  runThrough(limiter, req);
  assert.equal(runThrough(limiter, req).res.statusCode, 429);
  t += 10_001; // window slides past the first two hits
  const { nexted } = runThrough(limiter, req);
  assert.ok(nexted, 'slots should free up after the window slides');
});

test('buckets are per IP', () => {
  const limiter = createApiRateLimiter({ maxRequests: 2, windowMs: 60_000 });
  const a = () => runThrough(limiter, fakeReq({ socketIp: '10.0.0.1' }));
  const b = () => runThrough(limiter, fakeReq({ socketIp: '10.0.0.2' }));
  a(); a();
  assert.equal(a().res.statusCode, 429);
  assert.ok(b().nexted, 'a different IP must not share the bucket');
  assert.ok(b().nexted);
  assert.equal(b().res.statusCode, 429);
});

test('forged X-Forwarded-For does not change the bucket without trusted proxy (P0 S6)', () => {
  withTrustProxy('', () => {
    const limiter = createApiRateLimiter({ maxRequests: 2, windowMs: 60_000 });
    const hit = (xff) => runThrough(limiter, fakeReq({ socketIp: '5.6.7.8', xff }));
    hit('1.2.3.4');
    hit('9.9.9.9'); // rotating the header must not open a fresh bucket
    const over = hit('7.7.7.7');
    assert.equal(over.res.statusCode, 429, 'spoofed XFF must not bypass the limiter');
  });
});

test('CF Tunnel scenario: trusted 127.0.0.1 proxy, real client IP comes from XFF', () => {
  withTrustProxy('127.0.0.1', () => {
    const limiter = createApiRateLimiter({ maxRequests: 2, windowMs: 60_000 });
    // Two distinct visitors behind the same tunnel must not share one bucket keyed on 127.0.0.1
    const visitor = (realIp) => runThrough(limiter, fakeReq({ socketIp: '127.0.0.1', xff: realIp }));
    visitor('203.0.113.10'); visitor('203.0.113.10');
    assert.equal(visitor('203.0.113.10').res.statusCode, 429);
    assert.ok(visitor('203.0.113.20').nexted, 'different real IPs get separate buckets');
  });
});

test('tracked IP map stays bounded', () => {
  const limiter = createApiRateLimiter({ maxRequests: 1, windowMs: 60_000 });
  for (let i = 0; i < 12_000; i++) {
    runThrough(limiter, fakeReq({ socketIp: `10.9.${i >> 8}.${i & 0xff}` }));
  }
  assert.ok(limiter.stats().trackedIps <= 10_000, `tracked=${limiter.stats().trackedIps}`);
});
