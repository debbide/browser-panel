'use strict';

// Cloudflare edge selection.
//
// A CDN-fronted VLESS node resolves to a handful of anycast addresses. Pinning
// one of them makes the whole tunnel hostage to that single path, which is
// exactly what makes peak-hour traffic feel unstable. This module keeps a small
// pool of candidate edges, measures them, and hands out the fastest healthy one
// while remembering failures so a bad edge is not retried immediately.

const net = require('node:net');
const dns = require('node:dns');
const tls = require('node:tls');

const DEFAULT_PORT = 443;

// A curated slice of Cloudflare's published IPv4 ranges. The list is only a
// starting point: the node's own DNS answers are always merged in, and any
// operator-supplied addresses take priority.
const CLOUDFLARE_IPV4_RANGES = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22'
];

function ipv4ToInt(address) {
  const parts = String(address).split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value * 256) + octet;
  }
  return value >>> 0;
}

function intToIpv4(value) {
  const n = value >>> 0;
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

function parseCidr(cidr) {
  const [address, bitsText] = String(cidr).split('/');
  const base = ipv4ToInt(address);
  if (base === null) return null;
  const bits = bitsText === undefined ? 32 : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const size = 2 ** (32 - bits);
  return { base, size };
}

function sampleFromCidr(cidr, random = Math.random) {
  const parsed = parseCidr(cidr);
  if (!parsed) return null;
  // Skip the network and broadcast addresses of the block.
  const usable = Math.max(1, parsed.size - 2);
  const offset = 1 + Math.floor(random() * usable);
  return intToIpv4(parsed.base + offset);
}

function normalizeAddress(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (text.includes('/')) {
    // Only IPv4 CIDRs are supported: sampling an IPv6 /64 at random would
    // almost never land on a Cloudflare anycast address.
    return sampleFromCidr(text);
  }
  // Accept both families. Operator-supplied IPv6 edges are legitimate; the
  // dialer reports them as failures if the host has no IPv6 route, which the
  // pool then cools down like any other unreachable edge.
  return net.isIP(text) ? text : null;
}

// Keep both address families inside the dialer's small attempt budget. IPv6 is
// started first because an IPv4-only host reaches the IPv4 candidate after the
// short family delay, while an IPv6-only host no longer waits for IPv4 timeout.
function interleaveFamilies(addresses, preferredFamily = 6) {
  const v4 = addresses.filter((address) => net.isIP(address) === 4);
  const v6 = addresses.filter((address) => net.isIP(address) === 6);
  const first = preferredFamily === 4 ? v4 : v6;
  const second = preferredFamily === 4 ? v6 : v4;
  const result = [];
  const count = Math.max(first.length, second.length);
  for (let index = 0; index < count; index += 1) {
    if (first[index]) result.push(first[index]);
    if (second[index]) result.push(second[index]);
  }
  return result;
}

async function resolveHost(host, { timeoutMs = 5000 } = {}) {
  const value = String(host ?? '').trim();
  if (!value) return [];
  if (net.isIP(value)) return [value];

  const withTimeout = (promise) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve([]), timeoutMs);
    promise.then(
      (result) => { clearTimeout(timer); resolve(result); },
      () => { clearTimeout(timer); resolve([]); }
    );
  });

  // `resolve4/resolve6` go through c-ares and the resolver list in resolv.conf
  // equivalent, which a local proxy or a split-DNS setup often refuses
  // (ECONNREFUSED). `lookup` uses the OS resolver instead, so it is tried as a
  // fallback to keep edge discovery working behind such setups.
  const viaCares = await withTimeout((async () => {
    const [v4, v6] = await Promise.allSettled([
      dns.promises.resolve4(value),
      dns.promises.resolve6(value)
    ]);
    const merged = [];
    if (v4.status === 'fulfilled') merged.push(...v4.value);
    if (v6.status === 'fulfilled') merged.push(...v6.value);
    return merged;
  })());

  const results = viaCares.filter((address) => net.isIP(address) !== 0);
  if (results.length > 0) {
    return results;
  }

  const viaLookup = await withTimeout((async () => {
    const entries = await dns.promises.lookup(value, { all: true, verbatim: true });
    return entries.map((entry) => entry.address);
  })());

  return viaLookup.filter((address) => net.isIP(address) !== 0);
}

// Measures a TLS handshake against one edge. The measurement doubles as a
// liveness probe: an edge that cannot complete a handshake within the budget is
// not usable no matter how fast it looked before.
function measureEdge({ address, port = DEFAULT_PORT, servername, timeoutMs = 5000, rejectUnauthorized = false }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let timer = null;

    const done = (latency, error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.removeAllListeners();
      // A late socket error must not become an unhandled 'error' event.
      socket.on('error', () => undefined);
      socket.destroy();
      resolve({ address, port, latency, error: error || null, ok: !error });
    };

    const socket = tls.connect({
      host: address,
      port,
      servername,
      rejectUnauthorized,
      ALPNProtocols: ['http/1.1']
    });

    timer = setTimeout(() => done(null, new Error('TLS 握手超时')), timeoutMs);
    socket.once('secureConnect', () => done(Date.now() - startedAt, null));
    socket.once('error', (error) => done(null, error));
  });
}

class CloudflareEdgePool {
  constructor({
    host,
    port = DEFAULT_PORT,
    servername,
    extraAddresses = [],
    candidatesPerRange = 2,
    maxAddresses = 24,
    timeoutMs = 5000,
    cooldownMs = 5 * 60 * 1000,
    successCacheMs = 5 * 60 * 1000,
    random = Math.random,
    now = () => Date.now()
  } = {}) {
    this.host = host;
    this.port = port;
    this.servername = servername || host;
    this.extraAddresses = extraAddresses.map(normalizeAddress).filter(Boolean);
    this.candidatesPerRange = candidatesPerRange;
    this.maxAddresses = maxAddresses;
    this.timeoutMs = timeoutMs;
    this.cooldownMs = cooldownMs;
    this.successCacheMs = successCacheMs;
    this.random = random;
    this.now = now;
    this.failures = new Map();
    this.latency = new Map();
    this.lastSuccess = null;
    this.measuredAt = 0;
    this.cachedCandidates = null;
  }

  // Operator-provided addresses win; the node's own DNS answers come next and
  // the Cloudflare ranges fill the remaining slots.
  async candidates({ refresh = false } = {}) {
    if (this.cachedCandidates && !refresh) {
      return this.cachedCandidates;
    }
    const resolved = await resolveHost(this.host, { timeoutMs: this.timeoutMs });
    const seen = new Set();
    const list = [];
    const push = (address) => {
      if (!address || seen.has(address) || list.length >= this.maxAddresses) return;
      seen.add(address);
      list.push(address);
    };

    this.extraAddresses.forEach(push);
    resolved.filter((address) => net.isIP(address) === 4).forEach(push);
    resolved.filter((address) => net.isIP(address) === 6).forEach(push);

    for (const range of CLOUDFLARE_IPV4_RANGES) {
      if (list.length >= this.maxAddresses) break;
      for (let index = 0; index < this.candidatesPerRange; index += 1) {
        push(sampleFromCidr(range, this.random));
      }
    }

    this.cachedCandidates = list;
    return list;
  }

  isCoolingDown(address) {
    const failedAt = this.failures.get(address);
    return failedAt !== undefined && (this.now() - failedAt) < this.cooldownMs;
  }

  reportFailure(address) {
    this.failures.set(address, this.now());
  }

  reportSuccess(address, latency) {
    this.failures.delete(address);
    this.lastSuccess = { address, at: this.now() };
    if (Number.isFinite(latency)) {
      this.latency.set(address, latency);
    }
  }

  // Probes candidates in parallel and returns them sorted by measured latency.
  async probe({ refresh = false } = {}) {
    const candidates = await this.candidates({ refresh });
    const results = await Promise.all(candidates.map((address) => measureEdge({
      address,
      port: this.port,
      servername: this.servername,
      timeoutMs: this.timeoutMs
    })));

    const healthy = [];
    for (const result of results) {
      if (result.ok) {
        this.reportSuccess(result.address, result.latency);
        healthy.push(result);
      } else {
        this.reportFailure(result.address);
      }
    }

    healthy.sort((left, right) => left.latency - right.latency);
    this.measuredAt = this.now();
    return healthy;
  }

  // Returns edges ordered best-first, skipping any that are still in cooldown.
  // When every candidate is cooling down the list is returned unfiltered so the
  // caller can still attempt a connection rather than failing outright.
  async ordered({ refresh = false } = {}) {
    const candidates = await this.candidates({ refresh });
    const fresh = [];
    const cooling = [];
    for (const address of candidates) {
      (this.isCoolingDown(address) ? cooling : fresh).push(address);
    }

    const byLatency = (list) => list.slice().sort((left, right) => {
      const a = this.latency.has(left) ? this.latency.get(left) : Number.POSITIVE_INFINITY;
      const b = this.latency.has(right) ? this.latency.get(right) : Number.POSITIVE_INFINITY;
      return a - b;
    });

    const ordered = [...byLatency(fresh), ...byLatency(cooling)];
    const preferredFamily = this.lastSuccess && !this.isCoolingDown(this.lastSuccess.address)
      ? net.isIP(this.lastSuccess.address)
      : 6;
    const interleaved = interleaveFamilies(ordered, preferredFamily);
    if (this.lastSuccess && (this.now() - this.lastSuccess.at) < this.successCacheMs) {
      const cached = this.lastSuccess.address;
      return [cached, ...interleaved.filter((address) => address !== cached)];
    }
    return interleaved.length > 0 ? interleaved : candidates;
  }

  snapshot() {
    return {
      host: this.host,
      port: this.port,
      servername: this.servername,
      candidates: this.cachedCandidates ? this.cachedCandidates.length : 0,
      measuredAt: this.measuredAt,
      latency: Object.fromEntries(this.latency),
      coolingDown: [...this.failures.entries()]
        .filter(([address]) => this.isCoolingDown(address))
        .map(([address]) => address)
    };
  }
}

module.exports = {
  CloudflareEdgePool,
  CLOUDFLARE_IPV4_RANGES,
  measureEdge,
  resolveHost,
  sampleFromCidr,
  parseCidr,
  ipv4ToInt,
  intToIpv4,
  normalizeAddress,
  DEFAULT_PORT
};
