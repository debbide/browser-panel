const net = require('net');
const { spawn } = require('child_process');
const paths = require('./paths');
const { warpError } = require('./installer');

function waitForPort(host, port, child, timeoutMs = 10000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let timer = null;
    const finish = (error) => {
      if (timer) clearTimeout(timer);
      child.removeListener('exit', onExit);
      if (error) reject(error); else resolve();
    };
    const onExit = (code) => finish(warpError('wireproxy_start_failed', `wireproxy exited before listening (${code})`));
    child.once('exit', onExit);
    const attempt = () => {
      const socket = net.connect({ host, port });
      socket.setTimeout(500);
      socket.once('connect', () => { socket.destroy(); finish(); });
      const retry = () => {
        socket.destroy();
        if (Date.now() - started >= timeoutMs) {
          finish(warpError('wireproxy_start_failed', 'wireproxy SOCKS5 listener timed out'));
        } else {
          timer = setTimeout(attempt, 150);
        }
      };
      socket.once('error', retry);
      socket.once('timeout', retry);
    };
    attempt();
  });
}

class WireproxyRunner {
  constructor(options = {}) {
    this.spawn = options.spawn || spawn;
    this.binary = options.binary || paths.wireproxy;
    this.child = null;
    this.meta = null;
  }

  async start({ configPath, host = '127.0.0.1', port, generation, timeoutMs = 10000 }) {
    if (this.child) throw warpError('operation_in_progress', 'wireproxy is already running');
    const child = this.spawn(this.binary, ['-c', configPath], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
    });
    child.stdout.resume();
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString()}`.slice(-8192); });
    this.child = child;
    this.meta = { generation, host, port, startedAt: new Date().toISOString(), pid: child.pid };
    child.once('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null;
        this.meta = { ...this.meta, exitedAt: new Date().toISOString(), exitCode: code, signal, error: stderr.trim() };
      }
    });
    try {
      await waitForPort(host, port, child, timeoutMs);
      return { ...this.meta };
    } catch (error) {
      await this.stop();
      if (stderr.trim()) error.message = `${error.message}: ${stderr.trim().slice(0, 500)}`;
      throw error;
    }
  }

  async stop({ timeoutMs = 5000 } = {}) {
    const child = this.child;
    if (!child) return;
    this.child = null;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      child.once('exit', finish);
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { finish(); } }
      const killTimer = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
      }, timeoutMs);
      killTimer.unref?.();
      const finishTimer = setTimeout(finish, timeoutMs + 1000);
      finishTimer.unref?.();
    });
  }

  status() {
    return { running: Boolean(this.child), ...(this.meta || {}) };
  }
}

module.exports = { WireproxyRunner, waitForPort };
