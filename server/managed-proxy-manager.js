const net = require('net');
const tls = require('tls');
const ProxyChain = require('proxy-chain');

function cleanError(error) {
  return String(error && (error.message || error) || 'Unknown proxy error');
}

function validatePayload(payload = {}) {
  const name = String(payload.name || '').trim();
  const upstreamUrl = String(payload.upstreamUrl || payload.upstream_url || '').trim();
  if (!name) throw new Error('代理名称不能为空');
  if (!upstreamUrl) throw new Error('上游代理地址不能为空');

  let parsed;
  try {
    parsed = new URL(upstreamUrl);
  } catch {
    throw new Error('上游代理地址格式不正确');
  }
  if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(parsed.protocol)) {
    throw new Error('仅支持 HTTP、HTTPS、SOCKS4 和 SOCKS5 上游代理');
  }
  return { name, upstreamUrl };
}

function waitForConnect(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接本地代理超时')), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
    };
    const onConnect = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

function readHttpHeaders(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('等待代理响应超时')), timeoutMs);
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
      if (error) reject(error); else resolve(value);
    };
    const onError = (error) => finish(error);
    const onEnd = () => finish(new Error('代理连接提前关闭'));
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const boundary = buffer.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      const head = buffer.subarray(0, boundary + 4).toString('latin1');
      const extra = buffer.subarray(boundary + 4);
      socket.pause();
      if (extra.length) socket.unshift(extra);
      finish(null, head);
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('end', onEnd);
  });
}

function waitForTls(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('TLS 握手超时')), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('secureConnect', onSecure);
      socket.off('error', onError);
    };
    const onSecure = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    socket.once('secureConnect', onSecure);
    socket.once('error', onError);
  });
}

class ManagedProxyManager {
  constructor(db, dependencies = {}) {
    this.db = db;
    this.ProxyChain = dependencies.ProxyChain || ProxyChain;
    this.net = dependencies.net || net;
    this.tls = dependencies.tls || tls;
    this.testUrl = dependencies.testUrl || 'https://www.cloudflare.com/cdn-cgi/trace';
    this.testTimeoutMs = Number(dependencies.testTimeoutMs) || 10000;
    this.servers = new Map();
  }

  publicRecord(record) {
    if (!record) return null;
    return {
      id: record.id,
      name: record.name,
      upstreamUrl: record.upstream_url,
      desiredRunning: Boolean(record.desired_running),
      status: record.status,
      localPort: record.local_port,
      localUrl: record.local_port ? `http://127.0.0.1:${record.local_port}` : null,
      lastError: record.last_error,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
    };
  }

  list() {
    return this.db.listManagedProxies().map((record) => this.publicRecord(record));
  }

  get(id) {
    return this.publicRecord(this.db.getManagedProxy(id));
  }

  create(payload = {}) {
    const config = validatePayload(payload);
    return this.publicRecord(this.db.createManagedProxy(config));
  }

  createServer(record, port = 0) {
    return new this.ProxyChain.Server({
      port,
      prepareRequestFunction: () => ({
        upstreamProxyUrl: record.upstream_url,
        requestAuthentication: false,
      }),
    });
  }

  async start(id, options = {}) {
    const numericId = Number(id);
    const record = this.db.getManagedProxy(numericId);
    if (!record) throw new Error('代理不存在');
    if (this.servers.has(numericId)) return this.get(numericId);

    this.db.updateManagedProxyRuntime(numericId, {
      desiredRunning: true,
      status: 'starting',
      localPort: null,
      lastError: null,
    });

    const requestedPort = options.port == null ? 0 : Number(options.port);
    const server = this.createServer(record, requestedPort);
    try {
      await server.listen();
      this.servers.set(numericId, server);
      this.db.updateManagedProxyRuntime(numericId, {
        desiredRunning: true,
        status: 'running',
        localPort: server.port,
        lastError: null,
      });
      return this.get(numericId);
    } catch (error) {
      try { await server.close(true); } catch {}
      this.db.updateManagedProxyRuntime(numericId, {
        desiredRunning: false,
        status: 'error',
        localPort: null,
        lastError: cleanError(error),
      });
      throw error;
    }
  }

  async closeServer(id, force = true) {
    const numericId = Number(id);
    const server = this.servers.get(numericId);
    this.servers.delete(numericId);
    if (server) await server.close(Boolean(force));
  }

  async stop(id, options = {}) {
    const numericId = Number(id);
    if (!this.db.getManagedProxy(numericId)) throw new Error('代理不存在');
    await this.closeServer(numericId, options.force);
    this.db.updateManagedProxyRuntime(numericId, {
      desiredRunning: false,
      status: 'stopped',
      localPort: null,
      lastError: null,
    });
    return this.get(numericId);
  }

  async update(id, payload = {}) {
    const numericId = Number(id);
    const oldRecord = this.db.getManagedProxy(numericId);
    if (!oldRecord) throw new Error('代理不存在');
    const config = validatePayload(payload);
    const wasRunning = this.servers.has(numericId) || Boolean(oldRecord.desired_running);
    const oldPort = oldRecord.local_port;

    if (!wasRunning) {
      this.db.updateManagedProxyConfig(numericId, config);
      return this.get(numericId);
    }

    await this.closeServer(numericId, true);
    this.db.updateManagedProxyConfig(numericId, config);
    try {
      return await this.start(numericId, { port: oldPort || 0 });
    } catch (editError) {
      this.db.updateManagedProxyConfig(numericId, {
        name: oldRecord.name,
        upstreamUrl: oldRecord.upstream_url,
      });
      try {
        await this.closeServer(numericId, true);
        await this.start(numericId, { port: oldPort || 0 });
      } catch (rollbackError) {
        const message = `编辑失败，旧配置恢复但旧实例重启失败：${cleanError(rollbackError)}`;
        this.db.updateManagedProxyRuntime(numericId, {
          desiredRunning: true,
          status: 'error',
          localPort: null,
          lastError: message,
        });
        const combined = new Error(`${cleanError(editError)}；${message}`);
        combined.cause = editError;
        throw combined;
      }
      throw editError;
    }
  }

  async test(id, options = {}) {
    const numericId = Number(id);
    const record = this.db.getManagedProxy(numericId);
    if (!record) throw new Error('代理不存在');
    const running = this.servers.has(numericId);
    let temporary = false;
    if (!running) {
      await this.start(numericId);
      temporary = true;
    }

    const current = this.db.getManagedProxy(numericId);
    const target = new URL(options.url || this.testUrl);
    if (target.protocol !== 'https:') throw new Error('测试目标必须是 HTTPS 地址');
    const timeoutMs = Number(options.timeoutMs) || this.testTimeoutMs;
    const host = target.hostname;
    const port = Number(target.port || 443);
    const startedAt = Date.now();
    let socket;
    let secureSocket;
    try {
      socket = this.net.connect({ host: '127.0.0.1', port: current.local_port });
      await waitForConnect(socket, timeoutMs);
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Connection: keep-alive\r\n\r\n`);
      const connectHead = await readHttpHeaders(socket, timeoutMs);
      const statusMatch = connectHead.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i);
      if (!statusMatch || Number(statusMatch[1]) !== 200) {
        throw new Error(`HTTPS CONNECT 失败：${connectHead.split('\r\n')[0] || '无响应'}`);
      }

      secureSocket = this.tls.connect({ socket, servername: host });
      await waitForTls(secureSocket, timeoutMs);
      secureSocket.resume();
      const path = `${target.pathname || '/'}${target.search || ''}`;
      secureSocket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nAccept: */*\r\n\r\n`);
      const responseHead = await readHttpHeaders(secureSocket, timeoutMs);
      const responseMatch = responseHead.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i);
      const statusCode = responseMatch ? Number(responseMatch[1]) : 0;
      if (statusCode < 200 || statusCode >= 400) {
        throw new Error(`HTTPS GET 失败：${responseHead.split('\r\n')[0] || '无响应'}`);
      }
      return {
        ok: true,
        target: target.toString(),
        statusCode,
        latencyMs: Date.now() - startedAt,
        connect: true,
        tls: true,
      };
    } finally {
      if (secureSocket) secureSocket.destroy();
      else if (socket) socket.destroy();
      if (temporary) await this.stop(numericId, { force: true });
    }
  }

  async remove(id) {
    const numericId = Number(id);
    if (!this.db.getManagedProxy(numericId)) return false;
    await this.stop(numericId, { force: true });
    return this.db.deleteManagedProxy(numericId);
  }

  async restore() {
    const desired = this.db.listManagedProxies().filter((record) => record.desired_running);
    for (const record of desired) {
      try {
        await this.start(record.id, { port: record.local_port || 0 });
      } catch (error) {
        console.error(`[managed-proxy] restore ${record.id} failed:`, cleanError(error));
      }
    }
  }

  async shutdown() {
    const entries = [...this.servers.entries()];
    this.servers.clear();
    await Promise.all(entries.map(async ([id, server]) => {
      try {
        await server.close(true);
        this.db.updateManagedProxyRuntime(id, {
          desiredRunning: true,
          status: 'stopped',
          localPort: null,
          lastError: null,
        });
      } catch (error) {
        console.error(`[managed-proxy] shutdown ${id} failed:`, cleanError(error));
      }
    }));
  }
}

module.exports = { ManagedProxyManager, cleanError, validatePayload };
