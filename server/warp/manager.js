const fs = require('fs/promises');
const net = require('net');
const path = require('path');
const db = require('../db');
const events = require('../events');
const paths = require('./paths');
const { installAll, componentsReady, readInstalledManifest, warpError } = require('./installer');
const { registerIdentity, renderWireproxyConfig, setSecretPermissions } = require('./registerer');
const { WireproxyRunner } = require('./runner');
const { probeDualStack, compareProbes } = require('./probe');
const { WarpPolicy } = require('./policy');

const DEFAULT_PORT = 40080;
const DEFAULT_POLICY = Object.freeze({
  autoRecover: true,
  autoRotate: false,
  healthIntervalMinutes: 10,
  failureThreshold: 3,
  rotateCooldownHours: 24,
  rotateDailyLimit: 2,
  maxCandidateAttempts: 2,
});

function cleanError(error) {
  return {
    code: String(error && error.code || 'warp_operation_failed').slice(0, 80),
    message: String(error && error.message || 'WARP operation failed').replace(/[\r\n]+/g, ' ').slice(0, 1000),
  };
}

function parsePort(value, fallback = DEFAULT_PORT) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : fallback;
}

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function publicJob(row) {
  if (!row) return null;
  let result = null;
  try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch { result = null; }
  return { ...row, result, result_json: undefined };
}

class WarpManager {
  constructor(options = {}) {
    this.db = options.db || db;
    this.events = options.events || events;
    this.install = options.installAll || installAll;
    this.ready = options.componentsReady || componentsReady;
    this.readManifest = options.readInstalledManifest || readInstalledManifest;
    this.register = options.registerIdentity || registerIdentity;
    this.probe = options.probeDualStack || probeDualStack;
    this.Runner = options.Runner || WireproxyRunner;
    this.runner = options.runner || new this.Runner();
    this.candidateRunner = null;
    this.port = parsePort(options.port || process.env.WARP_SOCKS_PORT);
    this.sessions = new Map();
    this.currentJobId = null;
    this.shuttingDown = false;
    this.lastProbe = null;
    this.policy = options.policy || new WarpPolicy(this, options.policyOptions);
    this.db.interruptWarpJobs();
  }

  notify(reason = 'changed') {
    this.events.emit('warp', { reason });
  }

  state() {
    return this.db.getWarpState();
  }

  getPolicy() {
    const state = this.state();
    return { ...DEFAULT_POLICY, ...(state && state.policy || {}) };
  }

  status() {
    const state = this.state();
    const latest = this.lastProbe || this.db.getLatestWarpProbeSnapshot(state && state.generation);
    return {
      desiredEnabled: Boolean(state && state.desired_enabled),
      phase: state && state.phase || 'disabled',
      generation: state && state.generation || 0,
      policy: this.getPolicy(),
      policyStatus: this.policy.status(),
      components: state && state.manifest || null,
      socksAddress: this.runner.status().running ? `socks5h://127.0.0.1:${this.port}` : '',
      process: this.runner.status(),
      probe: latest && latest.snapshot ? latest.snapshot : latest,
      activeSessions: this.sessions.size,
      currentJob: publicJob(this.currentJobId ? this.db.getWarpJob(this.currentJobId) : null),
      lastError: state && state.last_error_code ? {
        code: state.last_error_code,
        message: state.last_error_text || '',
        at: state.last_error_at || '',
      } : null,
    };
  }

  getJob(id) {
    return publicJob(this.db.getWarpJob(id));
  }

  updateSettings(input = {}) {
    const state = this.state();
    const current = { ...DEFAULT_POLICY, ...(state && state.policy || {}) };
    const next = {
      autoRecover: input.autoRecover === undefined ? current.autoRecover : Boolean(input.autoRecover),
      autoRotate: input.autoRotate === undefined ? current.autoRotate : Boolean(input.autoRotate),
      healthIntervalMinutes: Math.max(2, Math.min(1440, Number(input.healthIntervalMinutes) || current.healthIntervalMinutes)),
      failureThreshold: Math.max(1, Math.min(20, Number(input.failureThreshold) || current.failureThreshold)),
      rotateCooldownHours: Math.max(1, Math.min(720, Number(input.rotateCooldownHours) || current.rotateCooldownHours)),
      rotateDailyLimit: Math.max(0, Math.min(20, Number(input.rotateDailyLimit) || current.rotateDailyLimit)),
      maxCandidateAttempts: Math.max(1, Math.min(5, Number(input.maxCandidateAttempts) || current.maxCandidateAttempts)),
    };
    this.db.updateWarpState({ policy_json: next });
    this.policy.start();
    this.notify('settings');
    return this.status();
  }

  startJob(type, operation) {
    if (this.shuttingDown) throw warpError('shutting_down', 'WARP manager is shutting down');
    if (this.currentJobId) throw warpError('operation_in_progress', 'Another WARP operation is in progress');
    const job = this.db.createWarpJob(type);
    this.currentJobId = job.id;
    this.db.updateWarpJob(job.id, { status: 'running', step: 'starting', progress: 1, started_at: new Date().toISOString() });
    this.notify('job_started');
    setImmediate(async () => {
      try {
        const result = await operation((step, progress) => {
          this.db.updateWarpJob(job.id, { step, progress });
          this.notify('job_progress');
        });
        this.db.updateWarpJob(job.id, {
          status: 'succeeded', step: 'completed', progress: 100,
          result_json: result || {}, ended_at: new Date().toISOString(),
        });
      } catch (error) {
        const safe = cleanError(error);
        this.db.updateWarpJob(job.id, {
          status: 'failed', step: 'failed', error_code: safe.code,
          error_text: safe.message, ended_at: new Date().toISOString(),
        });
        const state = this.state();
        this.db.updateWarpState({
          phase: error.recoveredPhase || (state.desired_enabled ? 'error' : 'disabled'),
          last_error_code: safe.code, last_error_text: safe.message, last_error_at: new Date().toISOString(),
        });
      } finally {
        if (this.currentJobId === job.id) this.currentJobId = null;
        this.notify('job_finished');
      }
    });
    return publicJob(this.db.getWarpJob(job.id));
  }

  setPhase(phase) {
    this.db.updateWarpState({ phase });
    this.notify('phase');
  }

  async probeProxy(proxyUrl) {
    return this.probe(proxyUrl);
  }

  async runProbe(source = 'manual') {
    const state = this.state();
    const proxyUrl = `socks5h://127.0.0.1:${this.port}`;
    const snapshot = await this.probeProxy(proxyUrl);
    this.lastProbe = snapshot;
    this.db.saveWarpProbeSnapshot(state.generation, source, snapshot);
    this.db.updateWarpState({
      phase: snapshot.healthy ? (snapshot.dualStack ? 'healthy' : 'degraded') : 'error',
      consecutive_failures: snapshot.healthy ? 0 : Number(state.consecutive_failures || 0) + 1,
      last_error_code: snapshot.healthy ? null : 'warp_not_ready',
      last_error_text: snapshot.healthy ? null : 'Neither IPv4 nor IPv6 probe confirmed WARP',
      last_error_at: snapshot.healthy ? null : new Date().toISOString(),
    });
    return snapshot;
  }

  recordPolicyError(error) {
    const safe = cleanError(error);
    const state = this.state();
    this.db.updateWarpState({
      consecutive_failures: Number(state.consecutive_failures || 0) + 1,
      last_error_code: safe.code,
      last_error_text: safe.message,
      last_error_at: new Date().toISOString(),
    });
    this.notify('policy_error');
  }

  async startCurrentIdentity(source = 'startup') {
    const state = this.state();
    if (!state.desired_enabled) return null;
    const configPath = path.join(paths.active, 'wireproxy.conf');
    await fs.access(configPath);
    if (!this.runner.status().running) {
      await this.runner.start({ configPath, port: this.port, generation: state.generation });
    }
    const snapshot = await this.runProbe(source);
    if (!snapshot.healthy) {
      await this.runner.stop();
      throw warpError('warp_not_ready', 'Neither address family passed the WARP exit probe');
    }
    return snapshot;
  }

  async restore() {
    const state = this.state();
    if (!state.desired_enabled || this.shuttingDown) return this.status();
    try {
      this.setPhase('starting');
      await this.startCurrentIdentity('startup');
      this.policy.start();
    } catch (error) {
      const safe = cleanError(error);
      this.db.updateWarpState({
        phase: 'error',
        last_error_code: safe.code,
        last_error_text: safe.message,
        last_error_at: new Date().toISOString(),
      });
      this.notify('startup_failed');
    }
    return this.status();
  }

  async runPolicyCheck() {
    const state = this.state();
    if (!state.desired_enabled || this.currentJobId || this.sessions.size) return null;
    if (!this.runner.status().running) {
      if (!this.getPolicy().autoRecover) return null;
      return this.startCurrentIdentity('auto_recover');
    }

    const snapshot = await this.runProbe('health');
    if (snapshot.healthy) return snapshot;
    const latest = this.state();
    if (!this.getPolicy().autoRecover || Number(latest.consecutive_failures || 0) < this.getPolicy().failureThreshold) {
      return snapshot;
    }

    this.setPhase('reconnecting');
    await this.runner.stop();
    return this.startCurrentIdentity('auto_recover');
  }

  enable() {
    return this.startJob('enable', async (progress) => {
      this.db.updateWarpState({ desired_enabled: 1, phase: 'needs_install', last_error_code: null, last_error_text: null, last_error_at: null });
      progress('installing', 10);
      this.setPhase('installing');
      const manifest = await this.install({ onProgress: ({ step, progress: value }) => progress(step, value) });
      this.db.updateWarpState({ component_manifest_json: manifest });

      let state = this.state();
      let configPath = path.join(paths.active, 'wireproxy.conf');
      try { await fs.access(configPath); } catch {
        progress('registering', 65);
        this.setPhase('registering');
        const generation = Math.max(1, Number(state.generation || 0) + 1);
        const identity = await this.register({ directory: paths.active, bindAddress: `127.0.0.1:${this.port}` });
        this.db.saveWarpCredentialsMeta({ generation, state_dir: paths.active, fingerprint: identity.fingerprint, activated_at: new Date().toISOString() });
        this.db.updateWarpState({ generation });
        configPath = identity.configPath;
      }

      progress('starting', 80);
      this.setPhase('starting');
      if (!this.runner.status().running) {
        state = this.state();
        await this.runner.start({ configPath, port: this.port, generation: state.generation });
      }
      progress('probing', 90);
      const snapshot = await this.runProbe('enable');
      if (!snapshot.healthy) {
        await this.runner.stop();
        throw warpError('warp_not_ready', 'WARP started but neither address family passed the exit probe');
      }
      this.policy.start();
      return { generation: this.state().generation, probe: snapshot };
    });
  }

  probeNow() {
    return this.startJob('probe', async (progress) => {
      if (!this.runner.status().running) throw warpError('warp_not_ready', 'WARP SOCKS5 is not running');
      progress('probing', 30);
      const snapshot = await this.runProbe('manual');
      if (!snapshot.healthy) throw warpError('warp_not_ready', 'Neither address family passed the WARP exit probe');
      return { probe: snapshot };
    });
  }

  reconnect() {
    if (this.sessions.size) throw warpError('active_warp_sessions', 'WARP is in use by an active task or browser');
    return this.startJob('reconnect', async (progress) => {
      const state = this.state();
      if (!state.desired_enabled) throw warpError('warp_not_ready', 'WARP is disabled');
      const beforeRow = this.db.getLatestWarpProbeSnapshot(state.generation);
      const before = beforeRow && beforeRow.snapshot || null;
      progress('reconnecting', 20);
      this.setPhase('reconnecting');
      await this.runner.stop();
      await this.runner.start({ configPath: path.join(paths.active, 'wireproxy.conf'), port: this.port, generation: state.generation });
      progress('probing', 75);
      const after = await this.runProbe('reconnect');
      if (!after.healthy) throw warpError('warp_not_ready', 'Reconnected WARP failed the exit probe');
      return { comparison: compareProbes(before, after), probe: after };
    });
  }

  rotate() {
    if (this.sessions.size) throw warpError('active_warp_sessions', 'WARP is in use by an active task or browser');
    return this.startJob('rotate', async (progress) => {
      const originalState = this.state();
      if (!originalState.desired_enabled || !this.runner.status().running) {
        throw warpError('warp_not_ready', 'WARP SOCKS5 is not ready');
      }
      const beforeRow = this.db.getLatestWarpProbeSnapshot(originalState.generation);
      const before = beforeRow && beforeRow.snapshot || null;
      const candidatePort = await freeLoopbackPort();
      const candidateGeneration = Math.max(1, Number(originalState.generation || 0) + 1);
      let candidate = null;
      let promoted = false;

      try {
        progress('registering_candidate', 15);
        this.setPhase('rotating');
        candidate = await this.register({
          directory: paths.candidate,
          bindAddress: `127.0.0.1:${candidatePort}`,
        });
        this.candidateRunner = new this.Runner();
        progress('starting_candidate', 35);
        await this.candidateRunner.start({
          configPath: candidate.configPath,
          port: candidatePort,
          generation: candidateGeneration,
        });
        progress('probing_candidate', 50);
        const candidateProbe = await this.probeProxy(`socks5h://127.0.0.1:${candidatePort}`);
        if (!candidateProbe.healthy) {
          throw warpError('candidate_probe_failed', 'Candidate WARP identity failed the exit probe');
        }
        const comparison = compareProbes(before, candidateProbe);
        if (!comparison.changed) {
          throw warpError('unchanged', 'Candidate WARP connection is healthy but the exit IP did not change');
        }

        progress('promoting_candidate', 65);
        await this.candidateRunner.stop();
        this.candidateRunner = null;
        await this.runner.stop();
        await fs.rm(paths.previous, { recursive: true, force: true });
        await fs.rename(paths.active, paths.previous);
        await fs.rename(paths.candidate, paths.active);
        promoted = true;

        try {
          await this.runner.start({
            configPath: path.join(paths.active, 'wireproxy.conf'),
            port: this.port,
            generation: candidateGeneration,
          });
          progress('probing_promoted', 85);
          const promotedProbe = await this.probeProxy(`socks5h://127.0.0.1:${this.port}`);
          if (!promotedProbe.healthy) {
            throw warpError('candidate_probe_failed', 'Promoted WARP identity failed the stable-port exit probe');
          }
          const promotedComparison = compareProbes(before, promotedProbe);
          if (!promotedComparison.changed) {
            throw warpError('unchanged', 'Promoted WARP identity did not retain a changed exit IP');
          }
          this.lastProbe = promotedProbe;
          this.db.saveWarpCredentialsMeta({
            generation: candidateGeneration,
            state_dir: paths.active,
            fingerprint: candidate.fingerprint,
            activated_at: new Date().toISOString(),
          });
          this.db.saveWarpProbeSnapshot(candidateGeneration, 'rotate', promotedProbe);
          this.db.updateWarpState({
            generation: candidateGeneration,
            phase: promotedProbe.dualStack ? 'healthy' : 'degraded',
            consecutive_failures: 0,
            last_error_code: null,
            last_error_text: null,
            last_error_at: null,
          });
          await fs.rm(paths.previous, { recursive: true, force: true });
          return { comparison: promotedComparison, probe: promotedProbe };
        } catch (error) {
          progress('rolling_back', 92);
          this.setPhase('rolling_back');
          await this.runner.stop();
          await fs.rm(paths.candidate, { recursive: true, force: true });
          await fs.rename(paths.active, paths.candidate);
          await fs.rename(paths.previous, paths.active);
          promoted = false;
          try {
            await this.runner.start({
              configPath: path.join(paths.active, 'wireproxy.conf'),
              port: this.port,
              generation: originalState.generation,
            });
            const restoredProbe = await this.probeProxy(`socks5h://127.0.0.1:${this.port}`);
            this.lastProbe = restoredProbe;
            this.db.saveWarpProbeSnapshot(originalState.generation, 'rollback', restoredProbe);
          const recoveredPhase = restoredProbe.healthy ? (restoredProbe.dualStack ? 'healthy' : 'degraded') : 'error';
          this.db.updateWarpState({
              generation: originalState.generation,
              phase: recoveredPhase,
            });
            error.recoveredPhase = recoveredPhase;
          } catch (rollbackError) {
            throw warpError('rollback_failed', `WARP rotation failed and the previous identity could not be restored: ${cleanError(rollbackError).message}`, error);
          }
          throw error;
        }
      } catch (error) {
        if (!promoted && !error.recoveredPhase && this.runner.status().running) {
          const recoveredPhase = ['healthy', 'degraded'].includes(originalState.phase)
            ? originalState.phase
            : (before && before.healthy ? (before.dualStack ? 'healthy' : 'degraded') : 'error');
          this.db.updateWarpState({
            generation: originalState.generation,
            phase: recoveredPhase,
          });
          error.recoveredPhase = recoveredPhase;
        }
        throw error;
      } finally {
        if (this.candidateRunner) await this.candidateRunner.stop();
        this.candidateRunner = null;
        if (!promoted) await fs.rm(paths.candidate, { recursive: true, force: true });
      }
    });
  }

  disable() {
    if (this.sessions.size) throw warpError('active_warp_sessions', 'WARP is in use by an active task or browser');
    return this.startJob('disable', async (progress) => {
      this.db.updateWarpState({ desired_enabled: 0, phase: 'stopping' });
      this.policy.stop();
      progress('stopping', 40);
      if (this.candidateRunner) await this.candidateRunner.stop();
      this.candidateRunner = null;
      await this.runner.stop();
      await fs.rm(paths.candidate, { recursive: true, force: true });
      this.lastProbe = null;
      this.db.updateWarpState({ phase: 'disabled', consecutive_failures: 0, last_error_code: null, last_error_text: null, last_error_at: null });
      return { disabled: true };
    });
  }

  acquireProxy(sessionId) {
    const key = String(sessionId || '').trim();
    if (!key) throw warpError('warp_not_ready', 'A WARP session id is required');
    const status = this.status();
    if (!status.desiredEnabled || !status.process.running || !['healthy', 'degraded'].includes(status.phase)) {
      throw warpError('warp_not_ready', 'WARP SOCKS5 is not ready');
    }
    if (this.sessions.has(key)) return this.sessions.get(key);
    const probe = status.probe || null;
    const lease = {
      sessionId: key,
      proxyUrl: `socks5h://127.0.0.1:${this.port}`,
      generation: status.generation,
      snapshot: {
        mode: 'warp', generation: status.generation,
        components: status.components && status.components.components || null,
        checkedAt: probe && probe.checkedAt || null,
        ipv4: probe && probe.ipv4 || null,
        ipv6: probe && probe.ipv6 || null,
      },
    };
    this.sessions.set(key, lease);
    this.notify('session_acquired');
    return lease;
  }

  releaseProxy(sessionId) {
    const removed = this.sessions.delete(String(sessionId || ''));
    if (removed) this.notify('session_released');
    return removed;
  }

  async shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.policy.stop();
    if (this.candidateRunner) await this.candidateRunner.stop();
    this.candidateRunner = null;
    await this.runner.stop();
    this.sessions.clear();
    if (this.currentJobId) {
      this.db.updateWarpJob(this.currentJobId, {
        status: 'interrupted', step: 'interrupted', error_code: 'interrupted',
        error_text: 'Panel shutdown interrupted the WARP operation', ended_at: new Date().toISOString(),
      });
      this.currentJobId = null;
    }
  }
}

const manager = new WarpManager();

module.exports = { WarpManager, manager, DEFAULT_POLICY, DEFAULT_PORT, freeLoopbackPort, cleanError };
