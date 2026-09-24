const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PortManager,
  assertNotSelfReferential,
  assertUpstreamHostAllowed,
  assertUpstreamDnsAllowed,
  blockedUpstreamIpReason,
  parseUpstreamAllowlist,
  validateUpstreamAllowlist,
} = require('../../server/proxy-manager/port-manager');

// The SSRF allowlist now comes from the panel setting (proxy_upstream_allowlist),
// passed in as a parsed array; the module-level default is empty (secure default).
// No environment variables are involved.

test('S9: self-reference check covers 0.0.0.0 / :: / [::] spellings', () => {
  const managed = new Set([8001]);
  for (const host of ['0.0.0.0', '[::]']) {
    assert.throws(
      () => assertNotSelfReferential(`http://${host}:8001`, managed),
      /代理回环/,
      host
    );
  }
  // Non-managed local ports still pass the self-reference check itself.
  assert.doesNotThrow(() => assertNotSelfReferential('http://127.0.0.1:1080', managed));
});

test('S9: literal loopback / unspecified / private / link-local upstreams are rejected', () => {
  const blocked = [
    'http://127.0.0.1:8080',
    'http://127.1.2.3:8080',
    'http://localhost:8080',
    'http://0.0.0.0:8080',
    'http://10.1.2.3:8080',
    'http://172.16.5.4:8080',
    'http://172.31.255.255:8080',
    'http://192.168.1.1:8080',
    'http://169.254.169.254:8080', // cloud metadata
    'http://169.254.10.20:8080',
    'http://[::1]:8080',
    'http://[::]:8080',
    'http://[fe80::1]:8080',
    'http://[fc00::1]:8080',
    'http://[::ffff:127.0.0.1]:8080', // IPv4-mapped loopback
  ];
  for (const uri of blocked) {
    assert.throws(() => assertUpstreamHostAllowed(uri), /默认拒绝/, uri);
  }
});

test('S9: public upstreams keep working', () => {
  assert.doesNotThrow(() => assertUpstreamHostAllowed('http://1.1.1.1:8080'));
  assert.doesNotThrow(() => assertUpstreamHostAllowed('https://proxy.example.com:8443'));
  assert.doesNotThrow(() => assertUpstreamHostAllowed('socks5://203.0.113.9:1080'));
});

test('S9: allowlist re-enables internal upstreams explicitly', () => {
  const allowlist = parseUpstreamAllowlist('10.0.0.0/8, 127.0.0.1');
  assert.doesNotThrow(() => assertUpstreamHostAllowed('http://10.9.9.9:8080', allowlist));
  assert.doesNotThrow(() => assertUpstreamHostAllowed('http://127.0.0.1:1080', allowlist));
  // Not allowlisted: still blocked.
  assert.throws(() => assertUpstreamHostAllowed('http://192.168.1.1:8080', allowlist), /默认拒绝/);
  assert.throws(() => assertUpstreamHostAllowed('http://169.254.169.254:8080', allowlist), /默认拒绝/);

  const hostAllowlist = parseUpstreamAllowlist('proxy.internal');
  assert.doesNotThrow(() => assertUpstreamHostAllowed('http://proxy.internal:8080', hostAllowlist));
  assert.throws(() => assertUpstreamHostAllowed('http://10.0.0.1:8080', hostAllowlist), /默认拒绝/);
});

test('S9: PortManager reads the allowlist from panel settings, effective immediately', () => {
  const store = { value: '' };
  const pm = new PortManager({
    database: { getUsedPorts: () => new Set(), setRunning: () => {} },
    getSetting: (key) => (key === 'proxy_upstream_allowlist' ? store.value : null),
  });
  assert.deepEqual(pm.getUpstreamAllowlist(), []);
  assert.throws(
    () => assertUpstreamHostAllowed('http://10.9.9.9:8080', pm.getUpstreamAllowlist()),
    /默认拒绝/
  );
  // Change the setting: no restart, no cache — the next check sees it.
  store.value = '10.0.0.0/8';
  assert.doesNotThrow(() => assertUpstreamHostAllowed('http://10.9.9.9:8080', pm.getUpstreamAllowlist()));
  store.value = '';
  assert.throws(
    () => assertUpstreamHostAllowed('http://10.9.9.9:8080', pm.getUpstreamAllowlist()),
    /默认拒绝/
  );
});

test('S9: validateUpstreamAllowlist accepts hostnames/IPs/CIDRs and rejects junk', () => {
  assert.equal(validateUpstreamAllowlist(''), '');
  assert.equal(validateUpstreamAllowlist('  '), '');
  assert.equal(
    validateUpstreamAllowlist('proxy.internal, 10.0.0.0/8,::1'),
    'proxy.internal,10.0.0.0/8,::1'
  );
  for (const bad of ['not a host!', '10.0.0.0/33', '10.0.0.0/abc', 'http://x:1', 'a b']) {
    assert.throws(() => validateUpstreamAllowlist(bad), /无效/, bad);
  }
});

test('S9: blockedUpstreamIpReason classifies ranges', () => {
  assert.match(blockedUpstreamIpReason('127.0.0.1'), /loopback/);
  assert.match(blockedUpstreamIpReason('0.0.0.0'), /未指定/);
  assert.match(blockedUpstreamIpReason('10.0.0.1'), /RFC1918/);
  assert.match(blockedUpstreamIpReason('172.16.0.1'), /RFC1918/);
  assert.match(blockedUpstreamIpReason('192.168.0.1'), /RFC1918/);
  assert.match(blockedUpstreamIpReason('169.254.169.254'), /link-local/);
  assert.match(blockedUpstreamIpReason('::1'), /loopback/);
  assert.match(blockedUpstreamIpReason('::'), /未指定/);
  assert.equal(blockedUpstreamIpReason('8.8.8.8'), null);
  assert.equal(blockedUpstreamIpReason('1.1.1.1'), null);
});

test('S9: DNS-resolved internal addresses are rejected in the probe path', async () => {
  // localhost resolves to ::1 / 127.0.0.1 here; the DNS guard must catch it.
  await assert.rejects(
    () => assertUpstreamDnsAllowed('http://localhost:8080'),
    /解析到受限地址/
  );
  // Literal IPs skip DNS entirely.
  await assert.doesNotReject(() => assertUpstreamDnsAllowed('http://1.1.1.1:8080'));
});

test('S9: start() also resolves the hostname (stored/imported configs)', async () => {
  // A hostname that passes the literal check must still be rejected when it
  // currently resolves into a blocked range. Monkeypatch DNS because the
  // port-manager uses require('node:dns').promises.lookup at call time.
  const dnsPromises = require('node:dns').promises;
  const originalLookup = dnsPromises.lookup;
  dnsPromises.lookup = async () => [{ address: '10.9.9.9', family: 4 }];
  try {
    const pm = new PortManager({
      database: { getUsedPorts: () => new Set(), setRunning: () => {} },
    });
    await assert.rejects(
      () => pm.start({ id: 1, uri: 'http://evil.example.test:8080', local_port: 8123 }),
      /解析到受限地址/
    );
  } finally {
    dnsPromises.lookup = originalLookup;
  }
});
