const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '../..');

test('telegram settings and webhook routes preserve auth, responses, and lifecycle boundaries', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-telegram-routes-'));
  try {
    const script = String.raw`
      (async () => {
        const db = require('./server/db');
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
          const text = await response.text();
          let body = text;
          try { body = JSON.parse(text); } catch {}
          return { status: response.status, body, cookie: response.headers.get('set-cookie') || '' };
        };
        const unauthenticated = await request('/api/settings/telegram');
        if (unauthenticated.status !== 401 || unauthenticated.body.code !== 'unauthenticated') throw new Error('telegram auth contract failed');
        const setup = await request('/api/auth/setup', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'telegram-admin', password: 'telegram-password', confirmPassword: 'telegram-password' }),
        });
        const cookie = setup.cookie.split(';')[0];
        const headers = { 'content-type': 'application/json', cookie };
        const initial = await request('/api/settings/telegram', { headers: { cookie } });
        if (initial.status !== 200 || initial.body.data.configured !== false || initial.body.data.webhookStatus !== 'unconfigured') throw new Error('initial settings contract failed');
        const wrongMethod = await request('/api/settings/telegram', { method: 'DELETE', headers });
        if (wrongMethod.status !== 200 || typeof wrongMethod.body !== 'string' || !wrongMethod.body.includes('<!DOCTYPE html>')) throw new Error('method boundary failed');
        const missing = await request('/api/settings/telegram', { method: 'POST', headers, body: '{}' });
        if (missing.status !== 400 || missing.body.message !== 'Bot Token and Chat ID are required') throw new Error('required settings contract failed');
        const invalidUrl = await request('/api/settings/telegram', {
          method: 'POST', headers,
          body: JSON.stringify({ botToken: '123456:test-token', chatId: '42', webhookUrl: 'http://insecure.example.test' }),
        });
        if (invalidUrl.status !== 400 || !invalidUrl.body.message) throw new Error('webhook URL boundary failed');
        const saved = await request('/api/settings/telegram', {
          method: 'POST', headers,
          body: JSON.stringify({ botToken: '123456:test-token', chatId: '42', proxy: ' socks5://127.0.0.1:1080 ', webhookUrl: '' }),
        });
        if (saved.status !== 200 || saved.body.data.configured !== true || saved.body.data.botTokenMasked.includes('test-token') || saved.body.data.proxy !== 'socks5://127.0.0.1:1080' || saved.body.data.webhookStatus !== 'needs_url') throw new Error('settings persistence contract failed: ' + JSON.stringify(saved));
        const testMessage = await request('/api/settings/telegram/test', { method: 'POST', headers, body: '{}' });
        if (testMessage.status !== 400 || !testMessage.body.message) throw new Error('test message failure contract failed');
        const forbidden = await request('/api/telegram/webhook/wrong-token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        if (forbidden.status !== 403 || forbidden.body.message !== 'Forbidden') throw new Error('webhook token boundary failed');
        const accepted = await request('/api/telegram/webhook/123456:test-token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        if (accepted.status !== 200 || accepted.body.ok !== true) throw new Error('webhook lifecycle acknowledgement failed');
        await shutdown('telegram route regression test');
        process.stdout.write(JSON.stringify({ checked: 9 }));
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: projectRoot,
      env: { ...process.env, PANEL_RUNTIME_ROOT: runtimeRoot, HOST: '127.0.0.1', PORT: '0' },
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(result.signal, null, result.stderr || 'telegram route regression test timed out');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"checked":9/);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
