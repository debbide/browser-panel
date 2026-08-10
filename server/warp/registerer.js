const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const paths = require('./paths');
const { ensureDirectories, warpError } = require('./installer');

const REQUIRED_INTERFACE_KEYS = new Set(['privatekey', 'address']);
const ALLOWED_INTERFACE_KEYS = new Set(['privatekey', 'address', 'dns', 'mtu']);
const REQUIRED_PEER_KEYS = new Set(['publickey', 'endpoint', 'allowedips']);
const ALLOWED_PEER_KEYS = new Set(['publickey', 'endpoint', 'allowedips', 'persistentkeepalive']);

function redactOutput(value) {
  return String(value || '')
    .replace(/(private[_ -]?key|token|license[_ -]?key)\s*[=:]\s*\S+/gi, '$1=[redacted]')
    .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '[redacted]');
}

function runCommand(command, args, cwd, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const append = (current, chunk) => `${current}${chunk.toString()}`.slice(-32768);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs || 60000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(warpError('registration_failed', error.message, error));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: redactOutput(stdout), stderr: redactOutput(stderr) });
      else reject(warpError('registration_failed', redactOutput(stderr || stdout || `wgcf exited with ${code}`)));
    });
  });
}

function parseProfile(text) {
  const sections = [];
  let current = null;
  for (const sourceLine of String(text || '').split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const name = sectionMatch[1].trim();
      if (!['Interface', 'Peer'].includes(name)) {
        throw warpError('invalid_profile', `Unsupported WireGuard section: ${name}`);
      }
      current = { name, entries: [] };
      sections.push(current);
      continue;
    }
    if (!current) throw warpError('invalid_profile', 'WireGuard entry appears before a section');
    const separator = line.indexOf('=');
    if (separator < 1) throw warpError('invalid_profile', 'Malformed WireGuard profile entry');
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!value || /[\r\n\0]/.test(value)) throw warpError('invalid_profile', `Invalid WireGuard value: ${key}`);
    const allowed = current.name === 'Interface' ? ALLOWED_INTERFACE_KEYS : ALLOWED_PEER_KEYS;
    if (!allowed.has(key.toLowerCase())) throw warpError('invalid_profile', `Unsupported WireGuard key: ${key}`);
    current.entries.push([key, value]);
  }
  const interfaces = sections.filter((section) => section.name === 'Interface');
  const peers = sections.filter((section) => section.name === 'Peer');
  if (interfaces.length !== 1 || peers.length !== 1) {
    throw warpError('invalid_profile', 'WARP profile must contain one Interface and one Peer');
  }
  for (const required of REQUIRED_INTERFACE_KEYS) {
    if (!interfaces[0].entries.some(([key]) => key.toLowerCase() === required)) {
      throw warpError('invalid_profile', `WARP profile is missing ${required}`);
    }
  }
  for (const required of REQUIRED_PEER_KEYS) {
    if (!peers[0].entries.some(([key]) => key.toLowerCase() === required)) {
      throw warpError('invalid_profile', `WARP profile is missing ${required}`);
    }
  }
  return sections;
}

function normalizeEndpoint(value) {
  const raw = String(value || '').trim();
  const portMatch = raw.match(/:(\d{1,5})$/);
  const port = portMatch ? Number(portMatch[1]) : 2408;
  if (port < 1 || port > 65535) throw warpError('invalid_profile', 'Invalid WARP endpoint port');
  return `engage.cloudflareclient.com:${port}`;
}

function renderWireproxyConfig(profileText, bindAddress) {
  if (!/^127\.0\.0\.1:\d{1,5}$/.test(String(bindAddress || ''))) {
    throw warpError('invalid_bind_address', 'WARP SOCKS5 listener must use IPv4 loopback');
  }
  const port = Number(bindAddress.split(':').pop());
  if (port < 1 || port > 65535) throw warpError('invalid_bind_address', 'Invalid WARP SOCKS5 port');
  const sections = parseProfile(profileText);
  const output = [];
  for (const section of sections) {
    output.push(`[${section.name}]`);
    for (const [key, sourceValue] of section.entries) {
      const value = section.name === 'Peer' && key.toLowerCase() === 'endpoint'
        ? normalizeEndpoint(sourceValue)
        : sourceValue;
      output.push(`${key} = ${value}`);
    }
    output.push('');
  }
  output.push('[Socks5]', `BindAddress = ${bindAddress}`, '');
  return output.join('\n');
}

async function setSecretPermissions(dir) {
  await fsp.chmod(dir, 0o700);
  for (const name of ['wgcf-account.toml', 'wgcf-profile.conf', 'wireproxy.conf']) {
    const filePath = path.join(dir, name);
    try { await fsp.chmod(filePath, 0o600); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function registerIdentity({ directory = paths.candidate, bindAddress, execute = runCommand } = {}) {
  await ensureDirectories();
  const resolvedDir = path.resolve(directory);
  if (![path.resolve(paths.active), path.resolve(paths.candidate)].includes(resolvedDir)) {
    throw warpError('registration_failed', 'Registration directory is outside the managed WARP state');
  }
  await fsp.rm(resolvedDir, { recursive: true, force: true });
  await fsp.mkdir(resolvedDir, { recursive: true, mode: 0o700 });
  try {
    await execute(paths.wgcf, ['register', '--accept-tos'], resolvedDir, { timeoutMs: 90000 });
    await execute(paths.wgcf, ['generate'], resolvedDir, { timeoutMs: 30000 });
    const profilePath = path.join(resolvedDir, 'wgcf-profile.conf');
    const profile = await fsp.readFile(profilePath, 'utf8');
    const configText = renderWireproxyConfig(profile, bindAddress);
    const configPath = path.join(resolvedDir, 'wireproxy.conf');
    await fsp.writeFile(configPath, configText, { mode: 0o600, flag: 'wx' });
    await setSecretPermissions(resolvedDir);
    const fingerprint = crypto.createHash('sha256').update(profile).digest('hex').slice(0, 16);
    return { directory: resolvedDir, configPath, fingerprint };
  } catch (error) {
    await fsp.rm(resolvedDir, { recursive: true, force: true });
    throw error.code ? error : warpError('registration_failed', error.message, error);
  }
}

module.exports = {
  redactOutput,
  runCommand,
  parseProfile,
  renderWireproxyConfig,
  registerIdentity,
  setSecretPermissions,
};
