const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
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

function maskProxy(proxyUrl) {
  const raw = String(proxyUrl || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
    if (u.username || u.password) {
      return `${u.protocol}//***@${u.hostname}${u.port ? `:${u.port}` : ''}`;
    }
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
  } catch {
    return raw.slice(0, 40);
  }
}

function normalizeProxyUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) {
    return `http://${text}`;
  }
  return text;
}

function proxyAuthHeader(proxyUrl) {
  try {
    const u = new URL(proxyUrl);
    if (!u.username && !u.password) return null;
    const token = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
    return `Basic ${token}`;
  } catch {
    return null;
  }
}

function readResponse(res) {
  return new Promise((resolve, reject) => {
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
    res.on('error', reject);
  });
}

function directRequest(urlString, { method, headers, timeoutMs }) {
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
        family: 0, // allow dual-stack; v6-only hosts still work when AAAA exists
      },
      (res) => {
        readResponse(res).then(resolve, reject);
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error(`Timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

/** HTTP target via HTTP proxy (absolute-form request). */
function httpViaHttpProxy(targetUrl, proxyUrl, { method, headers, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl);
    const target = new URL(targetUrl);
    const proxyHeaders = { ...(headers || {}), Host: target.host };
    const auth = proxyAuthHeader(proxyUrl);
    if (auth) proxyHeaders['Proxy-Authorization'] = auth;

    const req = http.request(
      {
        protocol: proxy.protocol === 'https:' ? 'https:' : 'http:',
        hostname: proxy.hostname,
        port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
        path: targetUrl, // absolute-form
        method: method || 'GET',
        headers: proxyHeaders,
        timeout: timeoutMs,
      },
      (res) => {
        readResponse(res).then(resolve, reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error(`Timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

/** HTTPS target via HTTP proxy using CONNECT + TLS. */
function httpsViaHttpProxy(targetUrl, proxyUrl, { method, headers, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(val);
    };

    const proxy = new URL(proxyUrl);
    const target = new URL(targetUrl);
    const connectPort = target.port || 443;
    const connectHost = `${target.hostname}:${connectPort}`;

    const proxyHeaders = {
      Host: connectHost,
      Connection: 'close',
    };
    const auth = proxyAuthHeader(proxyUrl);
    if (auth) proxyHeaders['Proxy-Authorization'] = auth;

    const connectReq = http.request({
      hostname: proxy.hostname,
      port: proxy.port || 80,
      method: 'CONNECT',
      path: connectHost,
      headers: proxyHeaders,
      timeout: timeoutMs,
    });

    const timer = setTimeout(() => {
      connectReq.destroy(new Error(`Timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    connectReq.on('connect', (res, socket) => {
      clearTimeout(timer);
      if (res.statusCode !== 200) {
        socket.destroy();
        done(new Error(`Proxy CONNECT failed: HTTP ${res.statusCode}`));
        return;
      }

      const tlsSocket = tls.connect({
        socket,
        servername: target.hostname,
        timeout: timeoutMs,
      }, () => {
        const path = `${target.pathname || '/'}${target.search || ''}`;
        const hdrs = { ...(headers || {}), Host: target.host, Connection: 'close' };
        const lines = [
          `${method || 'GET'} ${path} HTTP/1.1`,
          ...Object.entries(hdrs).map(([k, v]) => `${k}: ${v}`),
          '',
          '',
        ];
        tlsSocket.write(lines.join('\r\n'));
      });

      tlsSocket.setTimeout(timeoutMs, () => {
        tlsSocket.destroy(new Error(`Timeout after ${timeoutMs}ms`));
      });

      let buf = Buffer.alloc(0);
      let headersParsed = false;
      let statusCode = 0;
      let bodyStart = 0;
      const responseHeaders = {};

      tlsSocket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!headersParsed) {
          const sep = buf.indexOf('\r\n\r\n');
          if (sep === -1) return;
          headersParsed = true;
          const head = buf.subarray(0, sep).toString('utf8');
          bodyStart = sep + 4;
          const headLines = head.split('\r\n');
          const statusLine = headLines[0] || '';
          const m = /HTTP\/\d\.\d\s+(\d+)/.exec(statusLine);
          statusCode = m ? Number(m[1]) : 0;
          for (let i = 1; i < headLines.length; i += 1) {
            const idx = headLines[i].indexOf(':');
            if (idx > 0) {
              const k = headLines[i].slice(0, idx).trim().toLowerCase();
              const v = headLines[i].slice(idx + 1).trim();
              responseHeaders[k] = v;
            }
          }
        }

        // For HEAD or when we already have enough body, finish
        if (headersParsed) {
          const bodyBuf = buf.subarray(bodyStart);
          const cl = responseHeaders['content-length'];
          const doneBody = method === 'HEAD'
            || (cl !== undefined && bodyBuf.length >= Number(cl))
            || bodyBuf.length >= MAX_BODY_BYTES
            || responseHeaders['transfer-encoding'] === 'chunked' && bodyBuf.includes(Buffer.from('0\r\n\r\n'));
          // Prefer connection close end event for simplicity; also cap size
          if (bodyBuf.length >= MAX_BODY_BYTES) {
            tlsSocket.destroy();
            done(null, {
              statusCode,
              headers: responseHeaders,
              body: bodyBuf.subarray(0, MAX_BODY_BYTES).toString('utf8'),
            });
          }
        }
      });

      tlsSocket.on('end', () => {
        const bodyBuf = headersParsed ? buf.subarray(bodyStart) : Buffer.alloc(0);
        done(null, {
          statusCode,
          headers: responseHeaders,
          body: bodyBuf.subarray(0, MAX_BODY_BYTES).toString('utf8'),
        });
      });
      tlsSocket.on('error', (err) => done(err));
    });

    connectReq.on('timeout', () => {
      clearTimeout(timer);
      connectReq.destroy(new Error(`Timeout after ${timeoutMs}ms`));
    });
    connectReq.on('error', (err) => {
      clearTimeout(timer);
      done(err);
    });
    connectReq.end();
  });
}

function requestOnce(urlString, options) {
  const proxy = normalizeProxyUrl(options.proxy || '');
  if (!proxy) {
    return directRequest(urlString, options);
  }

  let proxyParsed;
  try {
    proxyParsed = new URL(proxy);
  } catch {
    return Promise.reject(new Error(`Invalid proxy URL: ${proxy}`));
  }

  const scheme = (proxyParsed.protocol || '').toLowerCase();
  if (scheme === 'socks:' || scheme === 'socks5:' || scheme === 'socks4:') {
    return Promise.reject(new Error(
      '条件检测暂不支持 SOCKS 代理，请使用 http:// 或 https:// 代理（或在条件里填 HTTP 代理）'
    ));
  }
  if (scheme !== 'http:' && scheme !== 'https:') {
    return Promise.reject(new Error(`不支持的代理协议: ${scheme}`));
  }

  // Proxy itself over HTTPS is uncommon for CONNECT; only support http proxy endpoint for CONNECT
  const target = new URL(urlString);
  if (target.protocol === 'http:') {
    return httpViaHttpProxy(urlString, proxy, options);
  }
  if (target.protocol === 'https:') {
    if (scheme === 'https:') {
      return Promise.reject(new Error('HTTPS 代理端点暂不支持，请使用 http://host:port 形式的代理'));
    }
    return httpsViaHttpProxy(urlString, proxy, options);
  }
  return Promise.reject(new Error(`Unsupported target protocol: ${target.protocol}`));
}

async function fetchWithRedirects(urlString, options, redirectsLeft = MAX_REDIRECTS) {
  const res = await requestOnce(urlString, options);
  const code = res.statusCode;
  if (code >= 300 && code < 400 && res.headers.location && redirectsLeft > 0) {
    const loc = Array.isArray(res.headers.location) ? res.headers.location[0] : res.headers.location;
    const next = new URL(loc, urlString).toString();
    return fetchWithRedirects(next, options, redirectsLeft - 1);
  }
  return res;
}

/**
 * HTTP health check — trigger when the check FAILS.
 * Network: uses config.proxy || ctx.proxy (task/profile/global BROWSER_PROXY).
 * @returns {Promise<{ok:boolean, shouldTrigger:boolean, status:string, detail:string, meta?:object}>}
 */
async function evaluate(config = {}, ctx = {}) {
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
  const proxy = String(config.proxy || ctx.proxy || '').trim();

  try {
    const res = await fetchWithRedirects(url, { method, headers, timeoutMs, proxy });
    const code = res.statusCode;
    const via = proxy ? ` via ${maskProxy(proxy)}` : ' direct';
    if (!statusMatches(code, successRanges)) {
      return {
        ok: false,
        shouldTrigger: true,
        status: 'fail',
        detail: `HTTP ${code}${via}`,
        meta: { statusCode: code, proxy: maskProxy(proxy) || null },
      };
    }
    if (expectBody && !String(res.body || '').includes(expectBody)) {
      return {
        ok: false,
        shouldTrigger: true,
        status: 'fail',
        detail: `HTTP ${code} 响应未包含期望内容${via}`,
        meta: { statusCode: code, proxy: maskProxy(proxy) || null },
      };
    }
    return {
      ok: true,
      shouldTrigger: false,
      status: 'ok',
      detail: `HTTP ${code}${via}`,
      meta: { statusCode: code, proxy: maskProxy(proxy) || null },
    };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const via = proxy ? ` via ${maskProxy(proxy)}` : ' (直连，未配置代理)';
    return {
      ok: false,
      shouldTrigger: true,
      status: 'error',
      detail: `${msg.slice(0, 160)}${via}`,
      meta: { proxy: maskProxy(proxy) || null },
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
  // optional per-condition override; empty = use task/profile/global proxy at evaluate time
  const proxy = String(raw.proxy || '').trim();

  return {
    url,
    method,
    timeout_ms,
    success_statuses,
    expect_body_includes,
    headers,
    proxy,
  };
}

module.exports = {
  type: 'http_check',
  label: 'HTTP 检测（失败触发）',
  evaluate,
  normalizeConfig,
  maskProxy,
};
