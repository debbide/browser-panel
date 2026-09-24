const net = require('node:net');
const dns = require('node:dns').promises;
const { request } = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const ProxyChain = require('proxy-chain');
const { isPortConflict } = require('./database');
const { badRequest } = require('./http-error');
const { parseVlessLink, isVlessLink } = require('./vless/link');
const { VlessHttpProxy } = require('./vless/http-proxy');

const SUPPORTED_PROTOCOLS = ['http', 'https', 'socks5', 'socks5h', 'vless'];

function createTunnelAgent(secureSocket) {
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = () => secureSocket;
  return agent;
}

function checkPortAvailable(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host, port }, () => {
      server.close(() => resolve(true));
    });
  });
}

// `vless://` links are not a standard proxy URI: the host is the CDN front and
// the real parameters live in the query string. They are validated by the VLESS
// parser instead of the generic checks, and are reported as protocol `vless`.
function parseProxyUri(value) {
  if (isVlessLink(value)) {
    // Throws with a specific reason for Reality/gRPC/XTLS and missing fields.
    parseVlessLink(value);
    return new URL(String(value).trim());
  }

  const normalizedValue = typeof value === 'string'
    ? value.replace(/^socks:\/\//i, 'socks5://')
    : value;
  let parsed;
  try {
    parsed = new URL(normalizedValue);
  } catch (error) {
    throw new Error('代理链接格式无效');
  }

  const protocol = parsed.protocol.slice(0, -1).toLowerCase();
  if (!['http', 'https', 'socks5', 'socks5h'].includes(protocol)) {
    throw new Error('仅支持 HTTP、HTTPS、SOCKS5、SOCKS5H 和 VLESS 代理');
  }
  if (!parsed.hostname || !parsed.port) {
    throw new Error('代理链接必须包含主机和端口');
  }
  return parsed;
}

function sanitizeProxy(proxy) {
  const parsed = parseProxyUri(proxy.uri);
  return {
    id: proxy.id,
    name: proxy.name,
    protocol: parsed.protocol.slice(0, -1),
    local_port: proxy.local_port,
    is_running: Boolean(proxy.is_running)
  };
}

// Strips control characters (including newlines) so a name can never break the
// panel layout or smuggle escape sequences into logs.
function normalizeNodeName(value, { maxLength = 80 } = {}) {
  const collapsed = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!collapsed) {
    throw new Error('节点名称不能为空');
  }
  if (collapsed.length > maxLength) {
    throw new Error(`节点名称不能超过 ${maxLength} 个字符`);
  }
  return collapsed;
}

// A node whose upstream points at one of our own managed ports would forward
// into itself and spin at full CPU until the request times out. Remote hosts
// and unrelated local ports (say a separate local proxy on 1080) stay allowed
// here — the SSRF guard below (assertUpstreamHostAllowed) is what decides
// whether loopback upstreams are acceptable at all.
function assertNotSelfReferential(uri, managedPorts) {
  const parsed = parseProxyUri(uri);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isLocal = hostname === 'localhost' || hostname === '::1' || hostname === '::'
    || hostname === '0.0.0.0'
    || (net.isIP(hostname) === 4 && (hostname.split('.')[0] === '127' || hostname.split('.')[0] === '0'))
    || (net.isIP(hostname) === 6 && (hostname === '0:0:0:0:0:0:0:1' || hostname === '0:0:0:0:0:0:0:0'));
  if (!isLocal) {
    return;
  }

  const upstreamPort = Number(parsed.port);
  if (managedPorts.has(upstreamPort)) {
    throw badRequest(`上游代理指向本机托管端口 ${upstreamPort}，会形成代理回环`);
  }
}

function normalizeUpstreamHostname(hostname) {
  return String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
}

function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const v = Number(part);
    if (v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function ipv4InCidr(ipInt, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipInt & mask) >>> 0) === ((base & mask) >>> 0);
}

// Expand an IPv6 literal into 8 numeric hextets (handles "::" compression
// and embedded IPv4, dotted or hex). Returns null when unparseable.
function ipv6ToHextets(ip) {
  let s = String(ip).toLowerCase();
  const v4match = s.match(/:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4match) {
    const n = ipv4ToInt(v4match[1]);
    if (n === null) return null;
    s = `${s.slice(0, -v4match[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (head.length + tail.length > 8) return null;
  const zeros = new Array(8 - head.length - tail.length).fill('0');
  const hextets = [...head, ...zeros, ...tail].map((h) => parseInt(h, 16));
  if (hextets.some((h) => !Number.isFinite(h) || h < 0 || h > 0xffff)) return null;
  return hextets;
}

// Returns a block reason when a literal IP is not safe as a proxy upstream:
// loopback, unspecified, RFC1918 private, link-local (which also covers the
// cloud metadata address 169.254.169.254). Returns null for public IPs.
function blockedUpstreamIpReason(ip) {
  const lower = String(ip).toLowerCase();
  if (net.isIP(lower) === 4) {
    const n = ipv4ToInt(lower);
    if (n === null) return null;
    if (ipv4InCidr(n, ipv4ToInt('127.0.0.0'), 8)) return 'loopback (127.0.0.0/8)';
    if (ipv4InCidr(n, ipv4ToInt('0.0.0.0'), 8)) return '未指定地址 (0.0.0.0/8)';
    if (ipv4InCidr(n, ipv4ToInt('10.0.0.0'), 8)
      || ipv4InCidr(n, ipv4ToInt('172.16.0.0'), 12)
      || ipv4InCidr(n, ipv4ToInt('192.168.0.0'), 16)) return '内网地址 (RFC1918)';
    if (ipv4InCidr(n, ipv4ToInt('169.254.0.0'), 16)) return 'link-local (169.254.0.0/16，含云元数据地址)';
    return null;
  }
  if (net.isIP(lower) === 6) {
    const hextets = ipv6ToHextets(lower);
    if (!hextets) return null;
    // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1, normalized to ::ffff:7f00:1):
    // judge the embedded IPv4.
    if (hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff) {
      const v4 = `${hextets[6] >>> 8}.${hextets[6] & 0xff}.${hextets[7] >>> 8}.${hextets[7] & 0xff}`;
      return blockedUpstreamIpReason(v4);
    }
    if (hextets.every((h) => h === 0)) return '未指定地址 (::)';
    if (hextets.slice(0, 7).every((h) => h === 0) && hextets[7] === 1) return 'loopback (::1)';
    if ((hextets[0] & 0xffc0) === 0xfe80) return 'link-local (fe80::/10)';
    if ((hextets[0] & 0xfe00) === 0xfc00) return '内网地址 (fc00::/7)';
    return null;
  }
  return null;
}

// Explicit allowlist for internal upstreams, off by default. Comma-separated
// entries: exact hostnames, IPs, or IPv4 CIDRs, e.g. "proxy.internal,10.0.0.0/8".
// Stored in the panel settings (proxy_upstream_allowlist, edited in the node
// console UI); there is intentionally no environment variable for it.
function parseUpstreamAllowlist(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => normalizeUpstreamHostname(s.trim()))
    .filter(Boolean);
}

// Validate a user-supplied upstream allowlist (comma-separated hostnames, IPs
// or IPv4 CIDRs). Returns the normalized string; throws on the first bad entry.
function validateUpstreamAllowlist(raw) {
  const input = String(raw || '');
  if (!input.trim()) return '';
  const entries = input.split(',').map((s) => s.trim()).filter(Boolean);
  for (const entry of entries) {
    const normalized = normalizeUpstreamHostname(entry);
    if (!normalized || /[\s]/.test(entry)) {
      throw badRequest(`上游白名单条目无效：${entry}`);
    }
    if (normalized.includes('/')) {
      const parts = normalized.split('/');
      const [base, bitsRaw] = parts;
      const bits = Number((bitsRaw || '').trim());
      if (parts.length !== 2 || net.isIP(base.trim()) !== 4 || !Number.isInteger(bits) || bits < 0 || bits > 32) {
        throw badRequest(`上游白名单条目无效：${entry}（CIDR 仅支持 IPv4，如 10.0.0.0/8）`);
      }
      continue;
    }
    if (net.isIP(normalized)) continue;
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(normalized)) {
      throw badRequest(`上游白名单条目无效：${entry}（填写域名、IP 或 IPv4 CIDR）`);
    }
  }
  return entries.map((s) => normalizeUpstreamHostname(s)).join(',');
}

function upstreamAllowlisted(hostname, ipInt, allowlist) {
  for (const entry of allowlist) {
    if (entry.includes('/')) {
      const [base, bitsRaw] = entry.split('/');
      const baseInt = ipv4ToInt(base);
      const bits = Number(bitsRaw);
      if (baseInt !== null && ipInt !== null && Number.isInteger(bits) && bits >= 0 && bits <= 32
        && ipv4InCidr(ipInt, baseInt, bits)) {
        return true;
      }
      continue;
    }
    if (entry === hostname) return true;
  }
  return false;
}

// Default-deny SSRF guard for proxy upstreams. Public upstreams keep working;
// loopback / unspecified / private / link-local targets are rejected unless
// explicitly allowlisted. Call this wherever a user-supplied upstream URI is
// accepted (add/start/test). The allowlist comes from the panel setting
// (PortManager#getUpstreamAllowlist); the module-level default is empty.
function assertUpstreamHostAllowed(uri, allowlist = []) {
  const parsed = parseProxyUri(uri);
  const hostname = normalizeUpstreamHostname(parsed.hostname);
  const ipVersion = net.isIP(hostname);
  const ipInt = ipVersion === 4 ? ipv4ToInt(hostname) : null;
  if (upstreamAllowlisted(hostname, ipInt, allowlist)) return;
  if (hostname === 'localhost') {
    throw badRequest('上游代理指向 localhost，默认拒绝；内网上游请在节点控制台的「上游白名单」设置中显式放行');
  }
  const reason = blockedUpstreamIpReason(hostname);
  if (reason) {
    throw badRequest(`上游代理指向上游受限地址 ${reason}，默认拒绝；内网上游请在节点控制台的「上游白名单」设置中显式放行`);
  }
}

// Best-effort DNS check for the probe path: a hostname that currently
// resolves into a blocked range is rejected too. This cannot stop DNS
// rebinding at runtime (records can change after the check), it only stops
// the naive "evil name -> internal IP" configuration.
async function assertUpstreamDnsAllowed(uri, allowlist = []) {
  const parsed = parseProxyUri(uri);
  const hostname = normalizeUpstreamHostname(parsed.hostname);
  if (net.isIP(hostname)) return;
  if (upstreamAllowlisted(hostname, null, allowlist)) return;
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    return;
  }
  for (const { address } of addresses) {
    const reason = blockedUpstreamIpReason(address);
    if (reason) {
      throw badRequest(`上游代理域名 ${hostname} 解析到受限地址 ${address}（${reason}），默认拒绝`);
    }
  }
}

class PortManager {
  constructor({ database, host = '127.0.0.1', portStart = 8001, portEnd = 8999, getSetting = null } = {}) {
    this.database = database;
    this.host = host;
    this.portStart = portStart;
    this.portEnd = portEnd;
    // Panel settings reader, e.g. (key) => panelDb.getSetting(key). Optional so
    // the module stays usable standalone (tests); without it the SSRF allowlist
    // is empty, i.e. the secure default.
    this.getSetting = typeof getSetting === 'function' ? getSetting : null;
    this.servers = new Map();
    this.operations = new Map();
  }

  // SSRF allowlist from the panel setting (proxy_upstream_allowlist), read
  // fresh on every check so setting changes take effect without a restart.
  getUpstreamAllowlist() {
    return this.getSetting ? parseUpstreamAllowlist(this.getSetting('proxy_upstream_allowlist')) : [];
  }

  serialize(id, operation) {
    const previous = this.operations.get(id) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.operations.set(id, current);
    return current.finally(() => {
      if (this.operations.get(id) === current) {
        this.operations.delete(id);
      }
    });
  }

  // Claims a port with a real INSERT so the UNIQUE constraint, not a racy
  // pre-check, is what guarantees exclusivity. Concurrent callers that lose the
  // race simply move on to the next candidate port.
  async reservePort({ name, uri }) {
    for (let port = this.portStart; port <= this.portEnd; port += 1) {
      if (this.database.getUsedPorts().has(port)) continue;
      if (!await checkPortAvailable(this.host, port)) continue;
      try {
        return this.database.createProxy({ name, uri, localPort: port });
      } catch (error) {
        if (isPortConflict(error)) continue;
        throw error;
      }
    }
    return null;
  }

  async allocatePort() {
    for (let port = this.portStart; port <= this.portEnd; port += 1) {
      if (!this.database.getUsedPorts().has(port) && await checkPortAvailable(this.host, port)) {
        return port;
      }
    }
    throw new Error('没有可分配的本地端口');
  }

  async start(proxy) {
    return this.serialize(proxy.id, async () => {
      if (this.servers.has(proxy.id)) {
        return this.database.setRunning(proxy.id, true);
      }
      parseProxyUri(proxy.uri);
      assertNotSelfReferential(proxy.uri, this.database.getUsedPorts());
      assertUpstreamHostAllowed(proxy.uri, this.getUpstreamAllowlist());
      // start() is the path imported/stored configs go through; resolve the
      // hostname too so a stored domain pointing at an internal address is
      // rejected here, not only in the manual probe path.
      await assertUpstreamDnsAllowed(proxy.uri, this.getUpstreamAllowlist());
      if (!await checkPortAvailable(this.host, proxy.local_port)) {
        throw new Error(`本地端口 ${proxy.local_port} 已被占用`);
      }

      // VLESS cannot be expressed as an upstream URL for proxy-chain, so it gets
      // our own listener that tunnels both CONNECT and plain HTTP.
      const server = isVlessLink(proxy.uri)
        ? new VlessHttpProxy({
          host: this.host,
          port: proxy.local_port,
          uri: proxy.uri,
          logger: (message) => console.log(`[proxy ${proxy.id}] ${message}`)
        })
        : new ProxyChain.Server({
          host: this.host,
          port: proxy.local_port,
          prepareRequestFunction: () => ({ upstreamProxyUrl: proxy.uri })
        });

      try {
        await server.listen();
        this.servers.set(proxy.id, server);
        return this.database.setRunning(proxy.id, true);
      } catch (error) {
        await server.close(true).catch(() => undefined);
        throw error;
      }
    });
  }

  async stop(proxy, { persist = true } = {}) {
    return this.serialize(proxy.id, async () => {
      const server = this.servers.get(proxy.id);
      if (server) {
        await server.close(true);
        this.servers.delete(proxy.id);
      }
      return persist ? this.database.setRunning(proxy.id, false) : proxy;
    });
  }

  async restore() {
    const results = [];
    for (const proxy of this.database.listRunningProxies()) {
      try {
        await this.start(proxy);
        results.push({ id: proxy.id, restored: true });
      } catch (error) {
        this.database.setRunning(proxy.id, false);
        results.push({ id: proxy.id, restored: false, error: error.message });
      }
    }
    return results;
  }

  async closeAll() {
    const running = this.database.listProxies().filter((proxy) => this.servers.has(proxy.id));
    await Promise.allSettled(running.map((proxy) => this.stop(proxy, { persist: false })));
  }

  async testProxy(uri, targetUrl, timeoutMs = 15000) {
    parseProxyUri(uri);
    assertUpstreamHostAllowed(uri, this.getUpstreamAllowlist());
    await assertUpstreamDnsAllowed(uri, this.getUpstreamAllowlist());
    const port = await this.findTemporaryPort();
    const server = isVlessLink(uri)
      ? new VlessHttpProxy({
        host: this.host,
        port,
        uri,
        // The probe only needs one tunnel; a large pool would be wasted here.
        maxTunnels: 4,
        idleTimeoutMs: timeoutMs
      })
      : new ProxyChain.Server({
        host: this.host,
        port,
        prepareRequestFunction: () => ({ upstreamProxyUrl: uri })
      });
    const startedAt = Date.now();

    try {
      await server.listen();
      const body = await this.requestThroughLocalProxy(port, targetUrl, timeoutMs);
      let ip = body.trim();
      try {
        const parsed = JSON.parse(body);
        ip = parsed.ip || parsed.origin || ip;
      } catch (error) {
        // Plain-text IP services are supported as well as JSON responses.
      }
      ip = String(ip).trim();
      if (!net.isIP(ip)) {
        throw new Error('测速服务未返回有效 IP 地址');
      }
      return { ip, latency: Date.now() - startedAt };
    } finally {
      await server.close(true).catch(() => undefined);
    }
  }

  async findTemporaryPort() {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen({ host: this.host, port: 0 }, () => {
        const address = server.address();
        server.close((error) => error ? reject(error) : resolve(address.port));
      });
    });
  }

  requestThroughLocalProxy(port, targetUrl, timeoutMs) {
    const target = new URL(targetUrl);
    if (target.protocol !== 'https:') {
      throw new Error('当前测速地址必须使用 HTTPS 协议');
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      const connectRequest = request({
        host: this.host,
        port,
        method: 'CONNECT',
        path: `${target.hostname}:${target.port || 443}`,
        headers: { Host: `${target.hostname}:${target.port || 443}` }
      });

      connectRequest.setTimeout(timeoutMs, () => connectRequest.destroy(new Error('代理 CONNECT 超时')));
      connectRequest.once('error', fail);
      connectRequest.once('connect', (response, socket, head) => {
        if (response.statusCode !== 200) {
          socket.destroy();
          fail(new Error(`代理 CONNECT 失败，HTTP ${response.statusCode}`));
          return;
        }
        if (head.length) socket.unshift(head);

        const secureSocket = tls.connect({
          socket,
          servername: target.hostname
        });
        secureSocket.setTimeout(timeoutMs, () => secureSocket.destroy(new Error('代理 TLS 超时')));
        secureSocket.once('error', fail);
        secureSocket.once('secureConnect', () => {
          const tunnelAgent = createTunnelAgent(secureSocket);
          const targetRequest = https.request({
            protocol: 'https:',
            hostname: target.hostname,
            port: target.port || 443,
            path: `${target.pathname}${target.search}`,
            method: 'GET',
            headers: {
              Host: target.host,
              Accept: 'application/json, text/plain'
            },
            agent: tunnelAgent
          }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
              if (settled) return;
              if (res.statusCode < 200 || res.statusCode >= 300) {
                fail(new Error(`测速服务返回 HTTP ${res.statusCode}`));
                return;
              }
              settled = true;
              resolve(Buffer.concat(chunks).toString('utf8'));
            });
          });
          targetRequest.setTimeout(timeoutMs, () => targetRequest.destroy(new Error('代理测速超时')));
          targetRequest.once('error', fail);
          targetRequest.end();
        });
      });
      connectRequest.end();
    });
  }
}

module.exports = {
  PortManager,
  parseProxyUri,
  sanitizeProxy,
  normalizeNodeName,
  assertNotSelfReferential,
  assertUpstreamHostAllowed,
  assertUpstreamDnsAllowed,
  parseUpstreamAllowlist,
  validateUpstreamAllowlist,
  blockedUpstreamIpReason,
  checkPortAvailable,
  createTunnelAgent
};
