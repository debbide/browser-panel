const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '../..');

test('browser runtime and profile routes preserve auth, methods, payloads, and command boundaries', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-browser-routes-'));
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
          return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') || '' };
        };
        for (const pathname of ['/api/browser', '/api/browser-profiles', '/api/settings/browser-runtime']) {
          const response = await request(pathname);
          if (response.status !== 401 || response.body.code !== 'unauthenticated') throw new Error('auth contract failed: ' + pathname);
        }
        const setup = await request('/api/auth/setup', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'browser-admin', password: 'browser-password', confirmPassword: 'browser-password' }),
        });
        const cookie = setup.cookie.split(';')[0];
        const headers = { 'content-type': 'application/json', cookie };
        const status = await request('/api/browser', { headers: { cookie } });
        if (status.status !== 200 || !('data' in status.body)) throw new Error('browser status contract failed');
        const runtime = await request('/api/settings/browser-runtime', { headers: { cookie } });
        if (runtime.status !== 200 || !runtime.body.data.runtimeStack) throw new Error('runtime response contract failed');
        const invalidInstall = await request('/api/settings/browser-runtime/install', {
          method: 'POST', headers,
          body: JSON.stringify({ runtimeStack: 'playwright', pluginPackages: 'bad package name' }),
        });
        if (invalidInstall.status !== 400 || invalidInstall.body.message !== '插件包名不合法: bad package name') throw new Error('install command boundary failed');
        const missingName = await request('/api/browser-profiles', { method: 'POST', headers, body: '{}' });
        if (missingName.status !== 400 || missingName.body.message !== 'Profile name is required') throw new Error('profile validation failed');
        const created = await request('/api/browser-profiles', {
          method: 'POST', headers,
          body: JSON.stringify({ name: 'Primary', proxy_mode: 'warp', proxy_value: 'http://ignored.test', runtime_stack: 'playwright', locale: ' zh-CN ', timezone_id: 'Asia/Shanghai' }),
        });
        if (created.status !== 200 || created.body.data.name !== 'Primary' || created.body.data.proxy_value !== '') throw new Error('profile create contract failed: ' + JSON.stringify(created));
        const id = created.body.data.id;
        const listed = await request('/api/browser-profiles', { headers: { cookie } });
        if (listed.status !== 200 || !listed.body.data.some((profile) => profile.id === id)) throw new Error('profile list contract failed');
        const updated = await request('/api/browser-profiles/' + id, {
          method: 'PUT', headers,
          body: JSON.stringify({ name: 'Updated', proxy: ' http://proxy.test ', runtime_stack: 'seleniumbase', timezone_id: 'UTC' }),
        });
        if (updated.status !== 200 || updated.body.data.name !== 'Updated' || updated.body.data.proxy_mode !== 'launch') throw new Error('profile update contract failed');
        const removed = await request('/api/browser-profiles/' + id, { method: 'DELETE', headers });
        if (removed.status !== 200 || removed.body.ok !== true) throw new Error('profile delete contract failed');
        await shutdown('browser route regression test');
        process.stdout.write(JSON.stringify({ checked: 11 }));
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: projectRoot,
      env: { ...process.env, PANEL_RUNTIME_ROOT: runtimeRoot, HOST: '127.0.0.1', PORT: '0' },
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(result.signal, null, result.stderr || 'browser route regression test timed out');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"checked":11/);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
