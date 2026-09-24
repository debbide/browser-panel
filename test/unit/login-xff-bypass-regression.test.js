const assert = require('node:assert/strict');
const test = require('node:test');

const config = require('../../config');
const { clientIp } = require('../../server/auth');

function reqWith({ xff, socketIp }) {
  return {
    headers: xff ? { 'x-forwarded-for': xff } : {},
    socket: { remoteAddress: socketIp },
  };
}

function withTrustProxy(value, fn) {
  const prev = config.server.trustProxy;
  config.server.trustProxy = value;
  try {
    fn();
  } finally {
    config.server.trustProxy = prev;
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
  withTrustProxy('*', () => {
    assert.equal(
      clientIp(reqWith({ xff: '1.2.3.4', socketIp: '5.6.7.8' })),
      '5.6.7.8'
    );
  });
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
