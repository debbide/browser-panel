const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '../..');

test('core API routes preserve authentication and response contracts', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-contracts-'));
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
          const contentType = response.headers.get('content-type') || '';
          const body = contentType.includes('application/json') ? await response.json() : await response.text();
          return { status: response.status, contentType, body, cookie: response.headers.get('set-cookie') || '' };
        };
        for (const pathname of ['/api/tasks', '/api/settings/scheduler', '/api/env?scope=global', '/api/task-groups', '/api/runs']) {
          const response = await request(pathname);
          if (response.status !== 401 || !response.contentType.includes('application/json')) throw new Error('auth contract failed: ' + pathname);
          if (response.body.code !== 'unauthenticated') throw new Error('auth payload failed: ' + pathname);
        }
        const setup = await request('/api/auth/setup', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'contract-admin', password: 'contract-password', confirmPassword: 'contract-password' }),
        });
        if (setup.status !== 200 || !setup.cookie.includes('panel_sess=')) throw new Error('setup contract failed');
        const cookie = setup.cookie.split(';')[0];
        const jsonHeaders = { 'content-type': 'application/json', cookie };
        const checks = [
          ['/api/settings/scheduler', { headers: { cookie } }, 200, 'data'],
          ['/api/env?scope=global', { headers: { cookie } }, 200, 'data'],
          ['/api/task-groups', { headers: { cookie } }, 200, 'data'],
          ['/api/tasks-fs', { headers: { cookie } }, 200, 'data'],
          ['/api/runs', { headers: { cookie } }, 200, 'data'],
          ['/api/tasks/999999/stop', { method: 'POST', headers: jsonHeaders, body: '{}' }, 404, 'message'],
          ['/api/backup/preview', { method: 'POST', headers: jsonHeaders, body: '{}' }, 400, 'message'],
        ];
        for (const [pathname, options, status, field] of checks) {
          const response = await request(pathname, options);
          if (response.status !== status || !(field in response.body)) throw new Error('route contract failed: ' + pathname + ' ' + JSON.stringify(response));
        }
        await shutdown('API contract integration test');
        process.stdout.write(JSON.stringify({ checked: checks.length + 5 }));
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: projectRoot,
      env: { ...process.env, PANEL_RUNTIME_ROOT: runtimeRoot, HOST: '127.0.0.1', PORT: '0' },
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(result.signal, null, result.stderr || 'contract test timed out');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"checked":12/);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
