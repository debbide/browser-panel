const test = require('node:test');
const assert = require('node:assert/strict');

const { ManagedProxyManager, validatePayload } = require('../../server/managed-proxy-manager');

function makeDb(record) {
  let current = { ...record };
  return {
    getManagedProxy: () => current ? { ...current } : null,
    listManagedProxies: () => current ? [{ ...current }] : [],
    updateManagedProxyConfig: (id, config) => {
      current = { ...current, name: config.name, upstream_url: config.upstreamUrl };
    },
    updateManagedProxyRuntime: (id, runtime) => {
      current = {
        ...current,
        desired_running: runtime.desiredRunning,
        status: runtime.status,
        local_port: runtime.localPort,
        last_error: runtime.lastError,
      };
    },
    deleteManagedProxy: () => {
      current = null;
      return true;
    },
  };
}

test('validatePayload accepts supported proxy protocols and rejects invalid input', () => {
  for (const upstreamUrl of [
    'http://proxy.test:8080',
    'https://proxy.test:8443',
    'socks4://proxy.test:1080',
    'socks5://proxy.test:1080',
  ]) {
    assert.deepEqual(validatePayload({ name: ' test ', upstreamUrl }), {
      name: 'test',
      upstreamUrl,
    });
  }
  assert.throws(() => validatePayload({ name: '', upstreamUrl: 'http://proxy.test' }), /代理名称不能为空/);
  assert.throws(() => validatePayload({ name: 'test', upstreamUrl: 'ftp://proxy.test' }), /仅支持/);
});

test('running proxy edit rolls back config and restarts old instance on failure', async () => {
  const db = makeDb({
    id: 1,
    name: 'old',
    upstream_url: 'http://old.test:8080',
    desired_running: 1,
    status: 'running',
    local_port: 3128,
    last_error: null,
    created_at: 'now',
    updated_at: 'now',
  });
  const manager = new ManagedProxyManager(db);
  manager.servers.set(1, { close: async () => {} });

  const starts = [];
  manager.start = async (id, options) => {
    starts.push({ config: db.getManagedProxy(id).upstream_url, port: options.port });
    if (starts.length === 1) throw new Error('new config failed');
    manager.servers.set(id, { close: async () => {} });
    return manager.get(id);
  };

  await assert.rejects(
    manager.update(1, { name: 'new', upstreamUrl: 'http://new.test:8080' }),
    /new config failed/,
  );

  assert.equal(db.getManagedProxy(1).name, 'old');
  assert.equal(db.getManagedProxy(1).upstream_url, 'http://old.test:8080');
  assert.deepEqual(starts, [
    { config: 'http://new.test:8080', port: 3128 },
    { config: 'http://old.test:8080', port: 3128 },
  ]);
});

test('HTTPS proxy test requires CONNECT, TLS, and successful HTTPS response', async () => {
  const db = makeDb({
    id: 2,
    name: 'proxy',
    upstream_url: 'http://upstream.test:8080',
    desired_running: 1,
    status: 'running',
    local_port: 4567,
    last_error: null,
    created_at: 'now',
    updated_at: 'now',
  });

  class FakeSocket {
    constructor(onWrite) {
      this.handlers = new Map();
      this.onWrite = onWrite;
    }
    once(event, fn) { this.handlers.set(event, fn); }
    on(event, fn) { this.handlers.set(event, fn); }
    off(event, fn) { if (this.handlers.get(event) === fn) this.handlers.delete(event); }
    emit(event, value) { const fn = this.handlers.get(event); if (fn) fn(value); }
    write(data) { this.onWrite?.(String(data), this); }
    pause() {}
    resume() {}
    unshift() {}
    destroy() {}
  }

  const plain = new FakeSocket((data, socket) => {
    assert.match(data, /^CONNECT www\.cloudflare\.com:443 HTTP\/1\.1/);
    queueMicrotask(() => socket.emit('data', Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n')));
  });
  const secure = new FakeSocket((data, socket) => {
    assert.match(data, /^GET \/cdn-cgi\/trace HTTP\/1\.1/);
    queueMicrotask(() => socket.emit('data', Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n')));
  });

  const manager = new ManagedProxyManager(db, {
    net: {
      connect: ({ host, port }) => {
        assert.equal(host, '127.0.0.1');
        assert.equal(port, 4567);
        queueMicrotask(() => plain.emit('connect'));
        return plain;
      },
    },
    tls: {
      connect: ({ socket, servername }) => {
        assert.equal(socket, plain);
        assert.equal(servername, 'www.cloudflare.com');
        queueMicrotask(() => secure.emit('secureConnect'));
        return secure;
      },
    },
  });
  manager.servers.set(2, { close: async () => {} });

  const result = await manager.test(2);
  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.connect, true);
  assert.equal(result.tls, true);
});
