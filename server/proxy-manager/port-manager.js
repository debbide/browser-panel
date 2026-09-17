const net = require('node:net');
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
// and unrelated local ports (say a separate local proxy on 1080) stay allowed.
function assertNotSelfReferential(uri, managedPorts) {
  const parsed = parseProxyUri(uri);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isLocal = hostname === 'localhost' || hostname === '::1'
    || (net.isIP(hostname) === 4 && hostname.split('.')[0] === '127')
    || (net.isIP(hostname) === 6 && hostname === '0:0:0:0:0:0:0:1');
  if (!isLocal) {
    return;
  }

  const upstreamPort = Number(parsed.port);
  if (managedPorts.has(upstreamPort)) {
    throw badRequest(`上游代理指向本机托管端口 ${upstreamPort}，会形成代理回环`);
  }
}

class PortManager {
  constructor({ database, host = '127.0.0.1', portStart = 8001, portEnd = 8999 }) {
    this.database = database;
    this.host = host;
    this.portStart = portStart;
    this.portEnd = portEnd;
    this.servers = new Map();
    this.operations = new Map();
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
  checkPortAvailable,
  createTunnelAgent
};
