'use strict';

// A self-hosted HTTP forward proxy whose upstream is a VLESS tunnel.
//
// This replaces ProxyChain.Server for vless:// nodes. It matters because the
// SOCKS/HTTP path inside proxy-chain only tunnels CONNECT; a plain HTTP request
// would be forwarded directly to the origin and bypass the tunnel entirely,
// leaking the real IP. Here both request shapes are tunneled:
//
//   CONNECT host:443   -> raw byte pipe over a VLESS tunnel
//   GET http://host/.. -> parsed, re-issued origin-form over a VLESS tunnel
//
// Plain HTTP requests reuse tunnels through an http.Agent keyed by origin, which
// is the connection reuse the SOCKS path was missing.

const http = require('node:http');
const { createVlessDialer } = require('./dialer');

const DEFAULT_MAX_TUNNELS = 256;
const DEFAULT_IDLE_TIMEOUT_MS = 120000;

// Headers that describe the client<->proxy hop and must not be forwarded.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade'
]);

// Parses the authority form used by CONNECT (`host:port`, `[v6]:port`).
function splitAuthority(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end === -1) return null;
    const host = text.slice(1, end);
    const rest = text.slice(end + 1);
    if (!rest.startsWith(':')) return null;
    return { host, port: Number(rest.slice(1)) };
  }
  const index = text.lastIndexOf(':');
  if (index === -1) return null;
  return { host: text.slice(0, index), port: Number(text.slice(index + 1)) };
}

function isValidTarget(target) {
  return Boolean(target)
    && Boolean(target.host)
    && Number.isInteger(target.port)
    && target.port > 0
    && target.port <= 65535;
}

// Strips the headers that only apply to the client<->proxy hop.
function forwardableHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    result[name] = value;
  }
  return result;
}

class VlessHttpProxy {
  constructor({
    host,
    port,
    uri,
    logger = () => undefined,
    dialerOptions = {},
    maxTunnels = DEFAULT_MAX_TUNNELS,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS
  }) {
    this.host = host;
    this.port = port;
    this.uri = uri;
    this.logger = logger;
    this.maxTunnels = maxTunnels;
    this.idleTimeoutMs = idleTimeoutMs;
    this.sockets = new Set();
    this.server = null;
    this.stats = { connects: 0, requests: 0, failures: 0, activeTunnels: 0 };

    // Built eagerly so an unsupported link fails at start(), not on first use.
    this.dialer = createVlessDialer({ link: uri, logger, ...dialerOptions });
    this.agent = this.createAgent();
  }

  // Tunnels are pooled per origin so repeated plain HTTP requests to the same
  // host reuse one VLESS connection instead of dialing per request.
  createAgent() {
    const dialer = this.dialer;
    const stats = this.stats;
    class VlessAgent extends http.Agent {
      createConnection(options, callback) {
        dialer.dial({ host: options.host, port: options.port }).then(
          ({ stream }) => {
            // Counted here rather than on the agent's 'free' event: 'free' only
            // fires for connections returned to the pool, so a stream the agent
            // discards would decrement a counter that was never incremented.
            stats.activeTunnels += 1;
            stream.once('close', () => {
              stats.activeTunnels = Math.max(0, stats.activeTunnels - 1);
            });
            callback(null, stream);
          },
          (error) => callback(error)
        );
      }
    }
    return new VlessAgent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 16 });
  }

  handleConnect(req, clientSocket, head) {
    const target = splitAuthority(req.url);
    if (!isValidTarget(target)) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    if (this.stats.activeTunnels >= this.maxTunnels) {
      this.stats.failures += 1;
      clientSocket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }

    this.stats.connects += 1;
    let settled = false;

    this.dialer.dial({ host: target.host, port: target.port }).then(({ stream }) => {
      if (settled) {
        stream.destroy();
        return;
      }
      settled = true;
      this.stats.activeTunnels += 1;

      // `head` holds bytes the parser already consumed; dropping it would
      // truncate the client's first TLS record.
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) {
        stream.write(head);
      }

      let torn = false;
      const teardown = () => {
        if (torn) return;
        torn = true;
        this.stats.activeTunnels = Math.max(0, this.stats.activeTunnels - 1);
        clientSocket.destroy();
        stream.destroy();
      };

      clientSocket.on('error', teardown);
      stream.on('error', teardown);
      clientSocket.on('close', teardown);
      stream.on('close', teardown);
      clientSocket.setTimeout(this.idleTimeoutMs, teardown);

      clientSocket.pipe(stream);
      stream.pipe(clientSocket);
    }, (error) => {
      if (settled) return;
      settled = true;
      this.stats.failures += 1;
      this.logger(`CONNECT ${target.host}:${target.port} 失败：${error.message}`);
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
  }

  handleRequest(req, res) {
    let target;
    try {
      target = new URL(req.url);
    } catch (error) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('代理请求必须使用绝对地址形式');
      return;
    }
    if (target.protocol !== 'http:') {
      // https:// cannot be served from a plain request; the client must CONNECT.
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`不支持通过明文请求访问 ${target.protocol}//，请改用 CONNECT`);
      return;
    }

    const port = target.port ? Number(target.port) : 80;
    if (!isValidTarget({ host: target.hostname, port })) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('目标地址无效');
      return;
    }

    this.stats.requests += 1;
    const headers = forwardableHeaders(req.headers);
    headers.host = target.host;

    const upstream = http.request({
      host: target.hostname,
      port,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
      agent: this.agent
    });

    upstream.on('response', (upstreamRes) => {
      // Hop-by-hop headers describe the upstream hop, so they must not be
      // relayed to the client either.
      res.writeHead(upstreamRes.statusCode, forwardableHeaders(upstreamRes.headers));
      upstreamRes.pipe(res);
    });

    upstream.on('error', (error) => {
      this.stats.failures += 1;
      this.logger(`HTTP ${target.host} 失败：${error.message}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('上游连接失败');
    });

    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
  }

  listen() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server = server;

      server.on('connect', (req, socket, head) => this.handleConnect(req, socket, head));
      server.on('connection', (socket) => {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
      });
      server.on('clientError', (error, socket) => {
        if (socket.writable) {
          socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        }
      });

      server.once('error', (error) => {
        this.server = null;
        reject(error);
      });
      server.listen(this.port, this.host, () => {
        server.removeAllListeners('error');
        server.on('error', (error) => this.logger(`代理监听错误：${error.message}`));
        resolve();
      });
    });
  }

  close(force = false) {
    return new Promise((resolve) => {
      const server = this.server;
      this.agent.destroy();
      if (!server) {
        resolve();
        return;
      }
      this.server = null;
      server.close(() => resolve());
      if (force) {
        for (const socket of this.sockets) {
          socket.destroy();
        }
        this.sockets.clear();
        // A hung keep-alive connection would otherwise delay close() forever.
        setImmediate(() => resolve());
      }
    });
  }
}

module.exports = { VlessHttpProxy, splitAuthority, forwardableHeaders, HOP_BY_HOP };
