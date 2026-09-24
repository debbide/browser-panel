const assert = require('node:assert/strict');
const test = require('node:test');

const db = require('../../server/db');
const auth = require('../../server/auth');

const { clientIp } = auth;

function reqWith({ xff, socketIp }) {
  return {
    headers: xff ? { 'x-forwarded-for': xff } : {},
    socket: { remoteAddress: socketIp },
  };
}

// The trusted proxy list now lives in the panel setting security_trust_proxy
// (Settings → Security), default empty. The settings route refreshes auth's
// cache after saving; this helper mirrors exactly that.
function withTrustProxy(value, fn) {
  const prev = db.getSetting('security_trust_proxy');
  db.setSetting('security_trust_proxy', value || null);
  auth.refreshTrustProxyCache();
  try {
    fn();
  } finally {
    db.setSetting('security_trust_proxy', prev);
    auth.refreshTrustProxyCache();
  }
}

test('S6: X-Forwarded-For is ignored without trusted proxy config', () => {
  withTrustProxy('', () => {
    assert.equal(
      clientIp(reqWith({ xff: '1.2.3.4', socketIp: '5.6.7.8' })),
      '5.6.7.8'
    );
    // rotating the header must not change the identity used for rate limiting
    assert.equal(
      clientIp(reqWith({ xff: '9.9.9.9', socketIp: '5.6.7.8' })),
      '5.6.7.8'
    );
  });
  // no wildcard: '*' must not trust arbitrary peers
  assert.throws(() => auth.validateTrustProxyValue('*'), /无效/);
});

test('S6: XFF honored only when the socket peer is a trusted proxy', () => {
  withTrustProxy('5.6.7.8', () => {
    assert.equal(
      clientIp(reqWith({ xff: '1.2.3.4', socketIp: '5.6.7.8' })),
      '1.2.3.4'
    );
  });
  withTrustProxy('9.9.9.9', () => {
    assert.equal(
      clientIp(reqWith({ xff: '1.2.3.4', socketIp: '5.6.7.8' })),
      '5.6.7.8'
    );
  });
});

test('S6: trusted proxy supports CIDR and ::ffff: mapped IPv4', () => {
  withTrustProxy('5.6.0.0/16', () => {
    assert.equal(
      clientIp(reqWith({ xff: '1.2.3.4', socketIp: '5.6.7.8' })),
      '1.2.3.4'
    );
    assert.equal(
      clientIp(reqWith({ xff: '1.2.3.4', socketIp: '5.7.7.8' })),
      '5.7.7.8'
    );
  });
  withTrustProxy('5.6.7.8', () => {
    assert.equal(
      clientIp(reqWith({ xff: '1.2.3.4', socketIp: '::ffff:5.6.7.8' })),
      '1.2.3.4'
    );
  });
});

test('S6: falls back to socket address when no XFF is present', () => {
  withTrustProxy('5.6.7.8', () => {
    assert.equal(clientIp(reqWith({ socketIp: '5.6.7.8' })), '5.6.7.8');
  });
  withTrustProxy('', () => {
    assert.equal(clientIp(reqWith({ socketIp: '::ffff:5.6.7.8' })), '5.6.7.8');
  });
});

test('S6: changing the setting takes effect immediately (cache refresh)', () => {
  const prev = db.getSetting('security_trust_proxy');
  try {
    db.setSetting('security_trust_proxy', null);
    auth.refreshTrustProxyCache();
    assert.equal(clientIp(reqWith({ xff: '1.2.3.4', socketIp: '5.6.7.8' })), '5.6.7.8');

    // Same sequence the settings route performs on save.
    const normalized = auth.validateTrustProxyValue('5.6.7.8');
    db.setSetting('security_trust_proxy', normalized || null);
    auth.refreshTrustProxyCache();
    assert.equal(clientIp(reqWith({ xff: '1.2.3.4', socketIp: '5.6.7.8' })), '1.2.3.4');
  } finally {
    db.setSetting('security_trust_proxy', prev);
    auth.refreshTrustProxyCache();
  }
});

test('S6: validateTrustProxyValue accepts IPs/CIDRs and rejects junk', () => {
  assert.equal(auth.validateTrustProxyValue(''), '');
  assert.equal(auth.validateTrustProxyValue(' 127.0.0.1 , 10.0.0.0/8 '), '127.0.0.1,10.0.0.0/8');
  assert.equal(auth.validateTrustProxyValue('::1'), '::1');
  for (const bad of ['*', '999.1.1.1', '10.0.0.0/33', 'example.com', '1.2.3.4/8/9']) {
    assert.throws(() => auth.validateTrustProxyValue(bad), /无效/, bad);
  }
});
