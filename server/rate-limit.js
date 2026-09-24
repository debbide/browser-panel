'use strict';
// P2 /api/* 全局限流：按 IP 滑动窗口，只防扫爆，不影响正常使用。
//
// IP 识别必须走 auth.clientIp —— 它已经处理了"可信代理"设置
// （设置 → 安全 → 可信反向代理）：
//   只有 TCP 对端落在可信代理名单里才采信 X-Forwarded-For，
//   否则直接用连接 IP。
// 这样既不会把 127.0.0.1（CF Tunnel 本机回环）当成所有人的 IP，
// 也不会被伪造 XFF 绕过（P0 S6 的教训）。
const { clientIp } = require('./auth');

// 宽松阈值：前端正常轮询（连接表 3s/次等）一个 IP 一分钟也就几十次，
// 600 次/分钟只拦扫描器。如需调整改这里两个常量即可，无需环境变量。
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 600;
// 内存有界：跟踪的 IP 数超过上限时淘汰最久未见的
const MAX_TRACKED_IPS = 10000;

function createApiRateLimiter({ windowMs = WINDOW_MS, maxRequests = MAX_REQUESTS, now = Date.now } = {}) {
  const hits = new Map(); // ip -> number[]，时间戳升序

  // 返回 0 表示放行；返回 >0 表示本窗口已满，值为建议的 Retry-After（秒）
  function takeSlot(ip, t) {
    let arr = hits.get(ip);
    if (!arr) {
      arr = [];
      hits.set(ip, arr);
    }
    const cutoff = t - windowMs;
    while (arr.length && arr[0] <= cutoff) arr.shift();
    if (arr.length >= maxRequests) {
      return Math.max(1, Math.ceil((arr[0] + windowMs - t) / 1000));
    }
    arr.push(t);
    return 0;
  }

  function evictOverflow() {
    // Map 按插入顺序迭代，删到的就是最久未见的
    while (hits.size > MAX_TRACKED_IPS) {
      const oldest = hits.keys().next();
      if (oldest.done) break;
      hits.delete(oldest.value);
    }
  }

  function apiRateLimiter(req, res, next) {
    const p = req.path || req.url || '';
    if (typeof p !== 'string' || !p.startsWith('/api/')) return next();
    // /healthz 不在 /api/ 下，天然豁免；监控探针不会被限流误伤
    const ip = clientIp(req) || 'unknown';
    const retryAfter = takeSlot(ip, now());
    if (retryAfter > 0) {
      evictOverflow();
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ message: '请求过于频繁，请稍后再试', code: 'rate_limited' });
    }
    evictOverflow();
    return next();
  }

  apiRateLimiter.stats = () => ({ trackedIps: hits.size, windowMs, maxRequests });
  return apiRateLimiter;
}

module.exports = {
  createApiRateLimiter,
  RATE_LIMIT_WINDOW_MS: WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS: MAX_REQUESTS,
};
