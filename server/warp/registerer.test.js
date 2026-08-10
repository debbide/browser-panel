const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const {
  endpointPort,
  routeAvailable,
  resolveEndpoint,
  renderWireproxyConfig,
} = require('./registerer');

const PROFILE = `[Interface]
PrivateKey = secret
Address = 172.16.0.2/32, 2606:4700:110:8::2/128
DNS = 1.1.1.1

[Peer]
PublicKey = public
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = engage.cloudflareclient.com:2408
`;

function resolver(ipv4 = [], ipv6 = []) {
  return {
    resolve4: async () => ipv4,
    resolve6: async () => ipv6,
  };
}

test('selects an endpoint supported by the host route', async () => {
  const ipv4 = await resolveEndpoint(2408, {
    resolver: resolver(['162.159.192.1']),
    canRoute: async (address, family) => family === 4,
  });
  assert.equal(ipv4, '162.159.192.1:2408');

  const ipv6 = await resolveEndpoint(2408, {
    resolver: resolver(),
    canRoute: async (address, family) => family === 6,
  });
  assert.equal(ipv6, '[2606:4700:d0::a29f:c001]:2408');
});

test('prefers the controlled IPv6 ingress on a dual-stack host', async () => {
  const attempts = [];
  const endpoint = await resolveEndpoint(2408, {
    resolver: resolver(['162.159.192.1']),
    canRoute: async (address, family) => {
      attempts.push([address, family]);
      return true;
    },
  });
  assert.deepEqual(attempts, [['2606:4700:d0::a29f:c001', 6]]);
  assert.equal(endpoint, '[2606:4700:d0::a29f:c001]:2408');
});

test('rejects invalid endpoints and unavailable candidates without leaking errors', async () => {
  assert.throws(() => endpointPort('host:70000'), { code: 'invalid_profile' });
  assert.throws(() => endpointPort('not-an-endpoint'), { code: 'invalid_profile' });

  await assert.rejects(resolveEndpoint(2408, {
    resolver: resolver(['invalid'], ['also-invalid']),
    canRoute: async () => { throw new Error('private route detail'); },
  }), (error) => {
    assert.equal(error.code, 'warp_endpoint_unreachable');
    assert.equal(error.message.includes('private route detail'), false);
    return true;
  });
});

test('renders a bracketed numeric IPv6 endpoint', async () => {
  const config = await renderWireproxyConfig(PROFILE, '127.0.0.1:40080', {
    resolveEndpoint: async (port) => `[2606:4700:d0::a29f:c001]:${port}`,
  });
  assert.match(config, /Endpoint = \[2606:4700:d0::a29f:c001\]:2408/);
  assert.match(config, /BindAddress = 127\.0\.0\.1:40080/);
});

function mockSocket(connectBehavior) {
  const socket = new EventEmitter();
  socket.closed = false;
  socket.unref = () => {};
  socket.close = () => { socket.closed = true; };
  socket.connect = connectBehavior.bind(socket);
  return socket;
}

test('route check closes its socket after success, failure, and timeout', async () => {
  const success = mockSocket(function connect(port, address, callback) { callback(); });
  assert.equal(await routeAvailable('162.159.192.1', 4, 2408, {
    createSocket: () => success,
    timeoutMs: 20,
  }), true);
  assert.equal(success.closed, true);

  const failure = mockSocket(function connect() { this.emit('error', new Error('no route')); });
  assert.equal(await routeAvailable('2606:4700:d0::a29f:c001', 6, 2408, {
    createSocket: () => failure,
    timeoutMs: 20,
  }), false);
  assert.equal(failure.closed, true);

  const timeout = mockSocket(function connect() {});
  assert.equal(await routeAvailable('162.159.192.1', 4, 2408, {
    createSocket: () => timeout,
    timeoutMs: 5,
  }), false);
  assert.equal(timeout.closed, true);
});
