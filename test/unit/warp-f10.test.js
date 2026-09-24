const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { EventEmitter } = require('node:events');

const { WireproxyRunner, checkPortFree } = require('../../server/warp/runner');
const { HttpSocksBridge } = require('../../server/warp/http-bridge');

class FakeChild extends EventEmitter {
  constructor(pid, { exitOnTerm = true } = {}) {
    super();
    this.pid = pid;
    this.exitOnTerm = exitOnTerm;
    this.killed = [];
    this.stdout = new EventEmitter();
    this.stdout.resume = () => {};
    this.stderr = new EventEmitter();
  }
  kill(signal) {
    this.killed.push(signal);
    if (this.exitOnTerm && signal === 'SIGTERM') setImmediate(() => this.emit('exit', 0, signal));
    return true;
  }
}

async function withPatchedKill(fn) {
  const origKill = process.kill;
  const calls = [];
  process.kill = (pid, signal) => { calls.push([pid, signal]); throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); };
  try {
    return await fn(calls);
  } finally {
    process.kill = origKill;
  }
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

test('F10: stop() clears the kill timer when the child exits early (no PID-reuse SIGKILL)', async () => {
  await withPatchedKill(async (calls) => {
    const runner = new WireproxyRunner();
    runner.child = new FakeChild(424242);
    await runner.stop({ timeoutMs: 100 });
    await new Promise((r) => setTimeout(r, 400));
    const sigkills = calls.filter(([pid, signal]) => pid === -424242 && signal === 'SIGKILL');
    assert.equal(sigkills.length, 0, 'late SIGKILL must not fire after early exit');
    assert.equal(runner.child, null);
  });
});

test('F10: stop() still SIGKILLs a stubborn child, then settles on exit', async () => {
  await withPatchedKill(async (calls) => {
    const runner = new WireproxyRunner();
    const child = new FakeChild(424243, { exitOnTerm: false });
    runner.child = child;
    const stopped = runner.stop({ timeoutMs: 100 });
    await new Promise((r) => setTimeout(r, 300));
    const sigkills = calls.filter(([pid, signal]) => pid === -424243 && signal === 'SIGKILL');
    assert.ok(sigkills.length >= 1, 'stubborn child must get SIGKILL');
    child.emit('exit', null, 'SIGKILL');
    await stopped;
    assert.equal(runner.child, null);
  });
});

test('F10: checkPortFree rejects when the port is occupied, resolves when free', async () => {
  const port = await freePort();
  const occupant = net.createServer();
  await new Promise((resolve) => occupant.listen(port, '127.0.0.1', resolve));
  try {
    await assert.rejects(checkPortFree('127.0.0.1', port), (e) => e.code === 'port_in_use');
  } finally {
    await new Promise((resolve) => occupant.close(resolve));
  }
  await checkPortFree('127.0.0.1', port);
});

test('F10: runner.start refuses to spawn when the port is already taken', async () => {
  const port = await freePort();
  const occupant = net.createServer();
  await new Promise((resolve) => occupant.listen(port, '127.0.0.1', resolve));
  let spawned = false;
  const runner = new WireproxyRunner({ spawn: (...args) => { spawned = true; throw new Error('must not spawn'); } });
  try {
    await assert.rejects(
      runner.start({ configPath: '/nonexistent/wireproxy.conf', port, generation: 1, timeoutMs: 500 }),
      (e) => e.code === 'port_in_use'
    );
    assert.equal(spawned, false, 'must not spawn a child when the port is taken');
  } finally {
    await new Promise((resolve) => occupant.close(resolve));
  }
});

test('F10: bridge start() cleans state on listen error (no stale server/null port)', async () => {
  const port = await freePort();
  const first = new HttpSocksBridge(1080, port);
  await first.start();
  assert.ok(first.isRunning());
  const second = new HttpSocksBridge(1080, port);
  await assert.rejects(second.start(), (e) => e.code === 'EADDRINUSE');
  assert.equal(second.isRunning(), false, 'failed start must not report running');
  assert.equal(second.server, null, 'failed start must not leave a stale server');
  assert.equal(second.httpPort, null, 'failed start must not report a port');
  await second.stop(); // no-op, must resolve
  await first.stop();
  // After the occupant is gone the same instance can start cleanly.
  const retryPort = await first.start();
  assert.ok(first.isRunning());
  assert.equal(retryPort, port);
  await first.stop();
});

test('F10: bridge stop() destroys long-lived CONNECT tunnels instead of hanging', async () => {
  const echo = net.createServer((socket) => socket.pipe(socket));
  await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve));
  const echoPort = echo.address().port;

  const bridge = new HttpSocksBridge(1080, await freePort());
  const httpPort = await bridge.start();

  // Open a long-lived CONNECT tunnel through the bridge (direct 127.0.0.1 path).
  const tunnel = net.connect(httpPort, '127.0.0.1', () => {
    tunnel.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`);
  });
  await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      if (chunk.toString().includes('200 Connection Established')) {
        tunnel.removeListener('data', onData);
        resolve();
      }
    };
    tunnel.on('data', onData);
    tunnel.on('error', reject);
    setTimeout(() => reject(new Error('tunnel never established')), 3000);
  });

  const stopped = await Promise.race([
    bridge.stop().then(() => 'stopped'),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 5000)),
  ]);
  assert.equal(stopped, 'stopped', 'stop() must not hang on open CONNECT tunnels');
  assert.equal(bridge.isRunning(), false);
  assert.equal(bridge.httpPort, null);
  assert.equal(bridge.server, null);

  tunnel.destroy();
  await new Promise((resolve) => echo.close(resolve));
});

test('F10: bridge clears its own state when the server closes unexpectedly', async () => {
  const bridge = new HttpSocksBridge(1080, await freePort());
  await bridge.start();
  assert.ok(bridge.isRunning());
  await new Promise((resolve) => bridge.server.close(resolve));
  await new Promise((r) => setImmediate(r));
  assert.equal(bridge.isRunning(), false, 'unexpected close must clear running state');
  assert.equal(bridge.httpPort, null);
});
