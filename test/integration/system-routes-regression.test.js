const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '../..');

test('remaining system routes preserve public boundaries, auth, methods, and missing-resource payloads', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-system-routes-'));
  try {
    const script = String.raw`
      (async () => {
        const { startServer, shutdown } = require('./server/index');
        const server = startServer();
        await new Promise((resolve, reject) => {
          if (server.listening) return resolve();
          server.once('listening', resolve);
          server.once('error', reject);
        });
        const base = 'http://127.0.0.1:' + server.address().port;
        const request = async (pathname, options = {}) => {
          const response = await fetch(base + pathname, options);
          const type = response.headers.get('content-type') || '';
          const body = type.includes('application/json') ? await response.json() : await response.text();
          return { status: response.status, body, headers: response.headers, cookie: response.headers.get('set-cookie') || '' };
        };

        const version = await request('/api/version');
        if (version.status !== 200 || !version.body.data || typeof version.body.data.label !== 'string') throw new Error('public version contract failed');

        for (const pathname of ['/api/events', '/api/settings/success-heuristics', '/api/settings/vision', '/api/settings/github-compat', '/api/browser-profiles/999999/env', '/api/runs/999999/log', '/api/runs/999999/screenshots']) {
          const response = await request(pathname);
          if (response.status !== 401 || response.body.code !== 'unauthenticated') throw new Error('auth contract failed: ' + pathname);
        }

        const setup = await request('/api/auth/setup', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'system-admin', password: 'system-password', confirmPassword: 'system-password' }),
        });
        const cookie = setup.cookie.split(';')[0];
        const headers = { 'content-type': 'application/json', cookie };

        const heuristics = await request('/api/settings/success-heuristics', { headers: { cookie } });
        if (heuristics.status !== 200 || !heuristics.body.data || typeof heuristics.body.data.enabled !== 'boolean') throw new Error('heuristics response contract failed');
        const vision = await request('/api/settings/vision', { headers: { cookie } });
        if (vision.status !== 200 || !vision.body.data) throw new Error('vision response contract failed');
        const missingVisionId = await request('/api/settings/vision/model', { method: 'POST', headers, body: JSON.stringify({ model: 'example' }) });
        if (missingVisionId.status !== 400 || missingVisionId.body.message !== '缺少通道 id') throw new Error('vision model validation failed');
        const missingVisionBase = await request('/api/settings/vision/test', { method: 'POST', headers, body: '{}' });
        if (missingVisionBase.status !== 400 || !missingVisionBase.body.message) throw new Error('vision test validation failed');

        const missingProfileEnv = await request('/api/browser-profiles/999999/env', { headers: { cookie } });
        if (missingProfileEnv.status !== 404 || missingProfileEnv.body.message !== 'Profile not found') throw new Error('profile env missing contract failed');
        const missingRunLog = await request('/api/runs/999999/log', { headers: { cookie } });
        if (missingRunLog.status !== 404 || missingRunLog.body.message !== 'Run not found') throw new Error('run log missing contract failed');
        const missingRunScreenshots = await request('/api/runs/999999/screenshots', { headers: { cookie } });
        if (missingRunScreenshots.status !== 404 || missingRunScreenshots.body.message !== 'Run not found') throw new Error('run screenshots missing contract failed');
        const wrongMethod = await request('/api/settings/vision/model', { method: 'PUT', headers, body: '{}' });
        if (wrongMethod.status !== 200 || !String(wrongMethod.body).includes('<!DOCTYPE html>')) throw new Error('method fallback contract failed');

        if (!path.resolve(require('./config').paths.logsDir).startsWith(path.resolve(process.env.PANEL_RUNTIME_ROOT))) throw new Error('production path isolation failed');
        await shutdown('system route regression test');
        process.stdout.write(JSON.stringify({ checked: 18 }));
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: projectRoot,
      env: { ...process.env, PANEL_RUNTIME_ROOT: runtimeRoot, HOST: '127.0.0.1', PORT: '0' },
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(result.signal, null, result.stderr || 'system route regression test timed out');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"checked":18/);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
