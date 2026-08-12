/**
 * 手写 SigV4 + HTTP 传输层，零新依赖。
 *
 * 只做 S3 协议这一件事，不碰备份业务。签名头固定 host;x-amz-content-sha256;x-amz-date
 * （与 evernote-lite 的 Rust 实现一致）。传输层 curl 优先 —— 这台机器很可能走代理出网，
 * curl 的 --socks5-hostname / -x 原生支持代理 —— curl 缺失或失败时落 fetch
 * （fetch 无法走代理，所以配置了代理时只信 curl，并在失败时把原因说清楚）。
 *
 * 文件上传/下载全程流式（fs.createReadStream / curl -o），不把整包读进内存。
 * 大对象用 x-amz-content-sha256: UNSIGNED-PAYLOAD 免去二次 SHA256 计算，
 * 代价是必须强制 HTTPS —— 路径完整性靠 TLS 兜底。
 *
 * 注意：SigV4 里 SignedHeaders 只签 host;x-amz-content-sha256;x-amz-date 三个头。
 * Content-Length / Content-Type 等作为未签名头发出去 —— S3 对 Content-Length 有特殊
 * 处理，签了反而容易因为服务端重算不匹配而 403。
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');

const S3_TIMEOUT_MS = 5 * 60 * 1000;
const CURL_MAX_TIME_SEC = 280;
const SIGNED_HEADER_NAMES = ['host', 'x-amz-content-sha256', 'x-amz-date'];

function hasCurl() {
  try {
    const result = spawnSync('curl', ['--version'], { stdio: 'ignore', timeout: 5000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

function normalizeHost(endpoint) {
  const raw = String(endpoint || '').trim().replace(/\/+$/, '');
  if (!raw) throw new Error('缺少 S3 endpoint');
  return raw.replace(/^https?:\/\//i, '');
}

function assertHttps(endpoint) {
  if (!/^https:\/\//i.test(String(endpoint || '').trim())) {
    throw new Error('S3 endpoint 必须使用 HTTPS（UNSIGNED-PAYLOAD 依赖 TLS 保证传输完整性）');
  }
}

function encodeKey(key) {
  return String(key || '').split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

/** path-style 默认开（MinIO / 自建都吃这套），带 virtual-host 开关。 */
function buildTarget({ endpoint, bucket, key, pathStyle, virtualHost }) {
  const host = normalizeHost(endpoint);
  if (virtualHost) {
    return { host: `${bucket}.${host}`, url: `https://${bucket}.${host}/${encodeKey(key)}` };
  }
  if (pathStyle === false) {
    return { host, url: `https://${host}/${bucket}/${encodeKey(key)}` };
  }
  return { host, url: `https://${host}/${bucket}/${encodeKey(key)}` };
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * 返回 SigV4 签名。headers 必须是最终要发的、且只含 SIGNED_HEADER_NAMES 里的头。
 * canonicalRequest 的 URI 用实际请求路径（path-style 下就是 /bucket/key）。
 */
function buildSigV4({ method, urlPath, query, headers, region, accessKey, secretKey, dateObj }) {
  const now = dateObj || new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  // 用真实 amzDate 覆盖调用方占位，保证 canonicalHeaders 与发出的头一致。
  headers['x-amz-date'] = amzDate;

  const names = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map((k) => `${k}:${String(headers[k] ?? '').trim()}\n`).join('');

  const canonicalRequest = [
    method.toUpperCase(),
    urlPath,
    query,
    canonicalHeaders,
    signedHeaders,
    headers['x-amz-content-sha256'],
  ].join('\n');

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  return {
    amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** 代理判定：复用 telegram.js 里 normalizeProxyForCurl 的协议判定逻辑。 */
function normalizeProxyForCurl(proxy) {
  const value = String(proxy || '').trim();
  if (!value) return { mode: '', value: '' };
  const lower = value.toLowerCase();
  if (lower.startsWith('socks5h://') || lower.startsWith('socks5://')) {
    return { mode: 'socks5', value: value.replace(/^socks5h?:\/\//i, '') };
  }
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    return { mode: 'http', value };
  }
  return { mode: 'socks5', value };
}

function getProxyFromEnv() {
  return String(
    process.env.S3_PROXY
    || process.env.AWS_PROXY
    || process.env.ALL_PROXY
    || process.env.all_proxy
    || process.env.HTTPS_PROXY
    || process.env.https_proxy
    || process.env.HTTP_PROXY
    || process.env.http_proxy
    || ''
  ).trim();
}

function proxyCurlArgs(proxy) {
  const norm = normalizeProxyForCurl(proxy);
  if (norm.mode === 'socks5' && norm.value) return ['--socks5-hostname', norm.value];
  if (norm.mode === 'http' && norm.value) return ['-x', norm.value];
  return [];
}

function runCurl(args, timeoutMs = S3_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0);
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('S3 curl 请求超时'));
    }, timeoutMs);

    child.stdout.on('data', (buf) => {
      stdout = Buffer.concat([stdout, buf]);
    });
    child.stderr.on('data', (buf) => {
      stderr += buf.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error((stderr || stdout.toString() || `curl exit ${code}`).trim()));
        return;
      }
      resolve(stdout);
    });
  });
}

async function fetchWithTimeout(url, options, timeoutMs = S3_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const XML_UNESCAPE = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

function decodeXml(s) {
  return String(s || '')
    .replace(/&(lt|gt|quot|apos|amp);/g, (_, name) => XML_UNESCAPE[name] || `&${name};`);
}

/**
 * @param {object} config
 * @param {string} config.endpoint  形如 https://minio.example.com:9000
 * @param {string} config.region    默认 us-east-1
 * @param {string} config.accessKey
 * @param {string} config.secretKey
 * @param {string} [config.token]
 * @param {string} [config.proxy]   可选 http(s):// 或 socks5://
 * @param {boolean} [config.pathStyle=true]  path-style 寻址
 * @param {boolean} [config.virtualHost=false] virtual-host 寻址
 */
function createS3Client(config) {
  const endpoint = String(config.endpoint || '').trim().replace(/\/+$/, '');
  const bucket = String(config.bucket || '').trim().replace(/^\/+/, '');
  const region = String(config.region || '').trim() || 'us-east-1';
  const accessKey = String(config.accessKey || '').trim();
  const secretKey = String(config.secretKey || '').trim();
  const token = String(config.token || '').trim();
  const proxy = String(config.proxy || '').trim();
  const pathStyle = config.pathStyle !== false;
  const virtualHost = Boolean(config.virtualHost);

  if (!endpoint) throw new Error('缺少 S3 endpoint');
  if (!bucket) throw new Error('缺少 S3 bucket');
  if (!accessKey || !secretKey) throw new Error('缺少 S3 AccessKey / SecretKey');
  assertHttps(endpoint);

  const curlAvailable = hasCurl();
  // fetch 不能走代理；配了代理且没 curl 时，任何请求都不可能成功，直接亮明错误。
  if (proxy && !curlAvailable) {
    throw new Error('配置了 S3 代理但没有 curl 可执行文件，无法发起请求');
  }

  function sign({ method, target, query = '', extra } = {}) {
    const url = new URL(target.url);
    const baseHeaders = { host: target.host, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': '' };
    const sig = buildSigV4({
      method,
      urlPath: url.pathname,
      query,
      headers: baseHeaders,
      region,
      accessKey,
      secretKey,
    });
    return {
      ...sig,
      token,
      // 签名后回填真实 amzDate，保证发出的头与签名严格一致
      headers: {
        host: target.host,
        'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
        'x-amz-date': sig.amzDate,
        ...(token ? { 'x-amz-security-token': token } : {}),
        ...extra,
      },
    };
  }

  function curlHeaders(headers, method) {
    return [
      ...proxyCurlArgs(proxy),
      '-X', method,
      '-H', `Authorization: ${headers.authorization}`,
      '-H', `x-amz-date: ${headers.amzDate}`,
      '-H', `x-amz-content-sha256: UNSIGNED-PAYLOAD`,
      ...(headers.token ? ['-H', `x-amz-security-token: ${headers.token}`] : []),
    ];
  }

  async function putObject({ key, filePath }) {
    const stat = fs.statSync(filePath);
    const target = buildTarget({ endpoint, bucket, key, pathStyle, virtualHost });
    const s = sign({
      method: 'PUT',
      target,
      extra: { 'content-length': String(stat.size), 'content-type': 'application/octet-stream' },
    });
    const url = target.url;

    if (curlAvailable) {
      try {
        const args = [
          '-sS', '-f', '--max-time', String(CURL_MAX_TIME_SEC),
          ...curlHeaders(s, 'PUT'),
          '-H', `Content-Length: ${stat.size}`,
          '-H', 'Content-Type: application/octet-stream',
          '--data-binary', `@${filePath}`,
          url,
        ];
        await runCurl(args);
        return { status: 200 };
      } catch (curlError) {
        if (!proxy) {
          // 没代理：fetch 还能试一次
          try { return await putViaFetch(url, s, filePath); } catch (fetchError) {
            throw new Error(`S3 上传失败（curl: ${curlError.message}; fetch: ${fetchError.message}）`);
          }
        }
        throw new Error(`S3 上传失败（经代理 curl）: ${curlError.message}`);
      }
    }
    return putViaFetch(url, s, filePath);
  }

  async function putViaFetch(url, s, filePath) {
    const stat = fs.statSync(filePath);
    const response = await fetchWithTimeout(url, {
      method: 'PUT',
      headers: {
        Authorization: s.authorization,
        'x-amz-date': s.amzDate,
        'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
        ...(s.token ? { 'x-amz-security-token': s.token } : {}),
        'Content-Length': String(stat.size),
        'Content-Type': 'application/octet-stream',
      },
      body: fs.createReadStream(filePath),
    });
    if (!response.ok) throw new Error(`S3 PUT 失败: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
    return { status: response.status };
  }

  async function getObject({ key, destPath }) {
    const target = buildTarget({ endpoint, bucket, key, pathStyle, virtualHost });
    const s = sign({ method: 'GET', target });
    const url = target.url;

    if (curlAvailable) {
      try {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const args = [
          '-sS', '-f', '--max-time', String(CURL_MAX_TIME_SEC),
          ...curlHeaders(s, 'GET'),
          '-o', destPath,
          url,
        ];
        await runCurl(args);
        if (!fs.existsSync(destPath) || fs.statSync(destPath).size === 0) {
          throw new Error('S3 下载结果为空文件');
        }
        return destPath;
      } catch (curlError) {
        if (!proxy) {
          try { return await getViaFetch(url, s, destPath); } catch (fetchError) {
            throw new Error(`S3 下载失败（curl: ${curlError.message}; fetch: ${fetchError.message}）`);
          }
        }
        throw new Error(`S3 下载失败（经代理 curl）: ${curlError.message}`);
      }
    }
    return getViaFetch(url, s, destPath);
  }

  async function getViaFetch(url, s, destPath) {
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        Authorization: s.authorization,
        'x-amz-date': s.amzDate,
        'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
        ...(s.token ? { 'x-amz-security-token': s.token } : {}),
      },
    });
    if (!response.ok) throw new Error(`S3 GET 失败: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const write = fs.createWriteStream(destPath);
    await pipeline(response.body, write);
    return destPath;
  }

  async function listObjects({ prefix = '', maxKeys = 1000 } = {}) {
    const target = buildTarget({ endpoint, bucket, key: '', pathStyle, virtualHost });
    // SigV4 的 canonical query 必须按键名升序。URLSearchParams 保持插入序不会排序，
    // 必须自己排好再拼 —— 否则签名里的 query 和 S3 重算的顺序不一致，LIST 会 403。
    const params = [
      ['list-type', '2'],
      ...(prefix ? [['prefix', prefix]] : []),
      ...(maxKeys ? [['max-keys', String(maxKeys)]] : []),
    ].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const s = sign({ method: 'GET', target, query });
    const url = `${target.url}?${query}`;

    let body;
    if (curlAvailable) {
      try {
        const args = [
          '-sS', '-f', '--max-time', String(CURL_MAX_TIME_SEC),
          ...curlHeaders(s, 'GET'),
          url,
        ];
        body = (await runCurl(args)).toString('utf8');
      } catch (curlError) {
        if (!proxy) {
          try { body = await listViaFetch(url, s); } catch (fetchError) {
            throw new Error(`S3 LIST 失败（curl: ${curlError.message}; fetch: ${fetchError.message}）`);
          }
        } else {
          throw new Error(`S3 LIST 失败（经代理 curl）: ${curlError.message}`);
        }
      }
    } else {
      body = await listViaFetch(url, s);
    }

    const objects = [];
    const contentsRe = /<Contents>(.*?)<\/Contents>/gs;
    let m;
    while ((m = contentsRe.exec(body)) !== null) {
      const block = m[1];
      const keyMatch = /<Key>(.*?)<\/Key>/s.exec(block);
      const sizeMatch = /<Size>(\d+)<\/Size>/.exec(block);
      const lastMatch = /<LastModified>(.*?)<\/LastModified>/.exec(block);
      if (!keyMatch) continue;
      objects.push({
        key: decodeXml(keyMatch[1]),
        size: sizeMatch ? Number(sizeMatch[1]) : 0,
        lastModified: lastMatch ? lastMatch[1] : null,
      });
    }
    return objects;
  }

  async function listViaFetch(url, s) {
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        Authorization: s.authorization,
        'x-amz-date': s.amzDate,
        'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
        ...(s.token ? { 'x-amz-security-token': s.token } : {}),
      },
    });
    if (!response.ok) throw new Error(`S3 LIST 失败: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
    return await response.text();
  }

  async function deleteObject({ key }) {
    const target = buildTarget({ endpoint, bucket, key, pathStyle, virtualHost });
    const s = sign({ method: 'DELETE', target });
    const url = target.url;

    if (curlAvailable) {
      try {
        await runCurl(['-sS', '--max-time', String(CURL_MAX_TIME_SEC), ...curlHeaders(s, 'DELETE'), url]);
        return { status: 204 };
      } catch (curlError) {
        if (!proxy) {
          try { return await deleteViaFetch(url, s); } catch (fetchError) {
            throw new Error(`S3 DELETE 失败（curl: ${curlError.message}; fetch: ${fetchError.message}）`);
          }
        }
        throw new Error(`S3 DELETE 失败（经代理 curl）: ${curlError.message}`);
      }
    }
    return deleteViaFetch(url, s);
  }

  async function deleteViaFetch(url, s) {
    const response = await fetchWithTimeout(url, {
      method: 'DELETE',
      headers: {
        Authorization: s.authorization,
        'x-amz-date': s.amzDate,
        'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
        ...(s.token ? { 'x-amz-security-token': s.token } : {}),
      },
    });
    if (!response.ok && response.status !== 204) {
      throw new Error(`S3 DELETE 失败: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
    }
    return { status: response.status };
  }

  async function testConnection() {
    const probeKey = `.panel-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tmpFile = path.join(os.tmpdir(), `s3-probe-${Date.now()}.tmp`);
    try {
      fs.writeFileSync(tmpFile, 'panel-s3-probe');
      await putObject({ key: probeKey, filePath: tmpFile });
      await deleteObject({ key: probeKey });
      return { ok: true };
    } finally {
      try { fs.rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
    }
  }

  return { putObject, getObject, listObjects, deleteObject, testConnection };
}

module.exports = { createS3Client };
