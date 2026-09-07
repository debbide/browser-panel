const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '../..');

test('auth boundary and task CRUD preserve all four script types', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-core-api-'));
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
          const body = await response.json();
          return { status: response.status, body, cookie: response.headers.get('set-cookie') || '' };
        };

        const unauthenticated = await request('/api/tasks');
        if (unauthenticated.status !== 401 || unauthenticated.body.code !== 'unauthenticated') {
          throw new Error('protected API did not return 401 JSON');
        }

        const setup = await request('/api/auth/setup', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'test-admin', password: 'test-password', confirmPassword: 'test-password' }),
        });
        if (setup.status !== 200 || !setup.cookie.includes('panel_sess=')) {
          throw new Error('setup did not establish a session');
        }
        const cookie = setup.cookie.split(';')[0];
        const authHeaders = { 'content-type': 'application/json', cookie };
        const types = [
          ['javascript', '.js'],
          ['python', '.py'],
          ['php', '.php'],
          ['shell', '.sh'],
        ];
        const ids = [];
        for (const [type, extension] of types) {
          const scriptPath = 'tasks/core-' + type + extension;
          const created = await request('/api/tasks', {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({
              name: 'Core ' + type,
              type,
              script_path: scriptPath,
              use_browser: false,
            }),
          });
          if (created.status !== 200) throw new Error('create failed for ' + type);
          if (created.body.data.type !== type || created.body.data.script_path !== scriptPath) {
            throw new Error('wrong type or path for ' + type + ': ' + JSON.stringify(created.body.data));
          }
          ids.push(created.body.data.id);
        }

        const before = await request('/api/tasks', { headers: { cookie } });
        if (before.status !== 200 || before.body.data.length !== 4) {
          throw new Error('task list contract failed');
        }
        const original = before.body.data.find((item) => item.type === 'php');
        const updated = await request('/api/tasks/' + original.id, {
          method: 'PUT',
          headers: authHeaders,
          body: JSON.stringify({ ...original, name: 'Renamed PHP', type: 'php' }),
        });
        if (updated.status !== 200 || updated.body.data.type !== 'php' || updated.body.data.script_path !== original.script_path) {
          throw new Error('updating task lost PHP type or script binding');
        }

        for (const id of ids) {
          const removed = await request('/api/tasks/' + id, { method: 'DELETE', headers: { cookie } });
          if (removed.status !== 200 || removed.body.ok !== true) throw new Error('delete failed for ' + id);
        }
        const missing = await request('/api/tasks/999999', { method: 'DELETE', headers: { cookie } });
        if (missing.status !== 404) throw new Error('missing task did not return 404');

        await shutdown('core API integration test');
        process.stdout.write(JSON.stringify({ types: types.length, deleted: ids.length }));
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PANEL_RUNTIME_ROOT: runtimeRoot,
        HOST: '127.0.0.1',
        PORT: '0',
      },
      encoding: 'utf8',
      timeout: 30000,
    });

    assert.equal(result.signal, null, result.stderr || 'integration test timed out');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"types":4/);
    assert.match(result.stdout, /"deleted":4/);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
