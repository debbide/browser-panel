const { spawn } = require('child_process');
const { performance } = require('perf_hooks');
const { warpError } = require('./installer');

const TARGETS = Object.freeze({
  ipv4: 'https://1.1.1.1/cdn-cgi/trace',
  ipv6: 'https://[2606:4700:4700::1111]/cdn-cgi/trace',
});

function parseTrace(text) {
  const data = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    data[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return data;
}

function runCurl(family, proxyUrl, options = {}) {
  const target = TARGETS[family];
  if (!target) return Promise.reject(warpError('probe_failed', `Unknown address family: ${family}`));
  return new Promise((resolve) => {
    const args = [
      '--silent', '--show-error', '--fail', '--max-time', String(Math.ceil((options.timeoutMs || 12000) / 1000)),
      '--proxy', proxyUrl, target,
    ];
    const started = performance.now();
    const child = (options.spawn || spawn)('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 16384) child.kill('SIGKILL');
    });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString()}`.slice(-4096); });
    child.on('error', (error) => resolve({
      family, available: false, checkedAt: new Date().toISOString(), error: error.message, errorCode: 'probe_unavailable',
    }));
    child.on('close', (code) => {
      const checkedAt = new Date().toISOString();
      const latencyMs = Math.round(performance.now() - started);
      if (code !== 0) {
        resolve({ family, available: false, checkedAt, latencyMs, error: stderr.trim() || `curl exited with ${code}`, errorCode: `${family}_unavailable` });
        return;
      }
      const trace = parseTrace(stdout);
      const warp = String(trace.warp || '').toLowerCase();
      const address = String(trace.ip || '').trim();
      if (!address || !['on', 'plus'].includes(warp)) {
        resolve({ family, available: false, checkedAt, latencyMs, address, warp: warp || 'unknown', colo: trace.colo || '', error: 'Cloudflare trace did not confirm WARP', errorCode: 'warp_not_confirmed' });
        return;
      }
      resolve({ family, available: true, checkedAt, latencyMs, address, warp, colo: trace.colo || '', error: '', errorCode: '' });
    });
  });
}

async function probeDualStack(proxyUrl, options = {}) {
  const run = options.run || runCurl;
  const [ipv4, ipv6] = await Promise.all([
    run('ipv4', proxyUrl, options),
    run('ipv6', proxyUrl, options),
  ]);
  return {
    checkedAt: new Date().toISOString(),
    ipv4,
    ipv6,
    healthy: Boolean(ipv4.available || ipv6.available),
    dualStack: Boolean(ipv4.available && ipv6.available),
  };
}

function compareProbes(before, after) {
  const compare = (family) => {
    const oldAddress = before && before[family] && before[family].address || '';
    const newAddress = after && after[family] && after[family].address || '';
    return { before: oldAddress, after: newAddress, changed: Boolean(oldAddress && newAddress && oldAddress !== newAddress) };
  };
  const ipv4 = compare('ipv4');
  const ipv6 = compare('ipv6');
  return { ipv4, ipv6, changed: ipv4.changed || ipv6.changed };
}

module.exports = { TARGETS, parseTrace, runCurl, probeDualStack, compareProbes };
