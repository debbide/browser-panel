const ProxyChain = require('proxy-chain');

function cleanError(error) {
  return String(error && (error.message || error) || 'Unknown proxy error');
}

class ManagedProxyManager {
  constructor(db) {
    this.db = db;
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

    return this.publicRecord(this.db.createManagedProxy({ name, upstreamUrl }));
  }

  async start(id) {
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

    const server = new ProxyChain.Server({
      port: 0,
      prepareRequestFunction: () => ({
        upstreamProxyUrl: record.upstream_url,
        requestAuthentication: false,
      }),
    });

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

  async stop(id, options = {}) {
    const numericId = Number(id);
    const record = this.db.getManagedProxy(numericId);
    if (!record) throw new Error('代理不存在');

    const server = this.servers.get(numericId);
    this.servers.delete(numericId);
    if (server) await server.close(Boolean(options.force));

    this.db.updateManagedProxyRuntime(numericId, {
      desiredRunning: false,
      status: 'stopped',
      localPort: null,
      lastError: null,
    });
    return this.get(numericId);
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
        await this.start(record.id);
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

module.exports = { ManagedProxyManager, cleanError };
