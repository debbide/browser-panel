const http = require('http');
const https = require('https');
const { URL } = require('url');

const MAX_BODY_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;

function parseSuccessStatuses(spec) {
  const text = String(spec || '200-399').trim() || '200-399';
  const ranges = [];
  for (const part of text.split(/[\s,;]+/).filter(Boolean)) {
    const m = /^(\d{3})(?:-(\d{3}))?$/.exec(part);
    if (!m) continue;
    const lo = Number(m[1]);
    const hi = m[2] ? Number(m[2]) : lo;
    ranges.push([Math.min(lo, hi), Math.max(lo, hi)]);
  }
  if (!ranges.length) ranges.push([200, 399]);
  return ranges;
}

function statusMatches(code, ranges) {
  const n = Number(code);
  return ranges.some(([lo, hi]) => n >= lo && n <= hi);
}

function requestOnce(urlString, { method, headers, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch (err) {
      reject(new Error(`Invalid URL: ${urlString}`));
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error(`Unsupported protocol: ${parsed.protocol}`));
      return;
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname || '/'}${parsed.search || ''}`,
        method: method || 'GET',
        headers: headers || {},
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          if (total >= MAX_BODY_BYTES) return;
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const room = MAX_BODY_BYTES - total;
          chunks.push(buf.length > room ? buf.subarray(0, room) : buf);
          total += Math.min(buf.length, room);
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers || {},
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchWithRedirects(urlString, options, redirectsLeft = MAX_REDIRECTS) {
  const res = await requestOnce(urlString, options);
  const code = res.statusCode;
  if (code >= 300 && code < 400 && res.headers.location && redirectsLeft > 0) {
    const next = new URL(res.headers.location, urlString).toString();
    return fetchWithRedirects(next, options, redirectsLeft - 1);
  }
  return res;
}

/**
 * HTTP health check — trigger when the check FAILS.
 * @returns {Promise<{ok:boolean, shouldTrigger:boolean, status:string, detail:string, meta?:object}>}
 */
async function evaluate(config = {}, _ctx = {}) {
  const url = String(config.url || '').trim();
  if (!url) {
    return {
      ok: false,
      shouldTrigger: false,
      status: 'error',
      detail: 'URL 未配置',
    };
  }

  const method = String(config.method || 'GET').toUpperCase() || 'GET';
  const timeoutMs = Math.min(60000, Math.max(1000, Number(config.timeout_ms) || 10000));
  const successRanges = parseSuccessStatuses(config.success_statuses);
  const expectBody = String(config.expect_body_includes || '').trim();
  const headers = config.headers && typeof config.headers === 'object' ? config.headers : {};

  try {
    const res = await fetchWithRedirects(url, { method, headers, timeoutMs });
    const code = res.statusCode;
    if (!statusMatches(code, successRanges)) {
      return {
        ok: false,
        shouldTrigger: true,
        status: 'fail',
        detail: `HTTP ${code}`,
        meta: { statusCode: code },
      };
    }
    if (expectBody && !String(res.body || '').includes(expectBody)) {
      return {
        ok: false,
        shouldTrigger: true,
        status: 'fail',
        detail: `HTTP ${code} 响应未包含期望内容`,
        meta: { statusCode: code },
      };
    }
    return {
      ok: true,
      shouldTrigger: false,
      status: 'ok',
      detail: `HTTP ${code}`,
      meta: { statusCode: code },
    };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return {
      ok: false,
      shouldTrigger: true,
      status: 'error',
      detail: msg.slice(0, 200),
    };
  }
}

function normalizeConfig(raw = {}) {
  const url = String(raw.url || '').trim();
  if (!url) throw new Error('条件 HTTP 检测需要填写 URL');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`无效的 URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('URL 仅支持 http/https');
  }

  const method = String(raw.method || 'GET').toUpperCase() || 'GET';
  const allowed = new Set(['GET', 'HEAD', 'POST']);
  if (!allowed.has(method)) throw new Error(`不支持的 HTTP 方法: ${method}`);

  const timeout_ms = Math.min(60000, Math.max(1000, Number(raw.timeout_ms) || 10000));
  const success_statuses = String(raw.success_statuses || '200-399').trim() || '200-399';
  const expect_body_includes = String(raw.expect_body_includes || '').trim();
  const headers = raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)
    ? raw.headers
    : {};

  return {
    url,
    method,
    timeout_ms,
    success_statuses,
    expect_body_includes,
    headers,
  };
}

module.exports = {
  type: 'http_check',
  label: 'HTTP 检测（失败触发）',
  evaluate,
  normalizeConfig,
};
