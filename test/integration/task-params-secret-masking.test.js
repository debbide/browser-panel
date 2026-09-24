const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '../..');

test('S3: GET /api/tasks never returns plaintext secrets in params', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-s3-'));
  try {
    const script = String.raw`
      (async () => {
        const { startServer, shutdown } = require('./server/index');
        const db = require('./server/db');
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
        const setup = await request('/api/auth/setup', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 's3-admin', password: 's3-password', confirmPassword: 's3-password' }),
        });
        if (setup.status !== 200) throw new Error('setup failed');
        const cookie = setup.cookie.split(';')[0];
        const headers = { 'content-type': 'application/json', cookie };

        const SECRET = 's3-super-secret-plain-123';
        const created = await request('/api/tasks', {
          method: 'POST', headers,
          body: JSON.stringify({
            name: 'S3 secret task',
            type: 'shell',
            script_path: 'tasks/s3-test.sh',
            env: [
              { name: 'S3_TEST_API_TOKEN', value: SECRET, is_secret: 1 },
              { name: 'S3_TEST_PLAIN', value: 'visible-value', is_secret: 0 },
            ],
          }),
        });
        if (created.status !== 200) throw new Error('task create failed: ' + JSON.stringify(created.body));
        const taskId = created.body.data.id;

        // 1. API masks secrets in params / params_json, keeps plain values.
        const listed = await request('/api/tasks', { headers });
        const task = listed.body.data.find((t) => t.id === taskId);
        if (!task) throw new Error('task not listed');
        if (task.params.S3_TEST_API_TOKEN !== '') throw new Error('params leaks plaintext secret');
        if (task.params.S3_TEST_PLAIN !== 'visible-value') throw new Error('params lost plain value');
        if (String(task.params_json).includes(SECRET)) throw new Error('params_json leaks plaintext secret');
        if (JSON.stringify(task).includes(SECRET)) throw new Error('task payload leaks plaintext secret anywhere');

        // 2. Runtime still resolves the real secret (execution path untouched).
        const rawMap = db.getTaskEnvMap(db.getTask(taskId));
        if (rawMap.S3_TEST_API_TOKEN !== SECRET) throw new Error('runtime lost real secret value');

        // 3. Historical plaintext in params_json gets scrubbed (tasks with env entries).
        db.db.prepare('UPDATE tasks SET params_json = ? WHERE id = ?')
          .run(JSON.stringify({ S3_TEST_API_TOKEN: SECRET, S3_TEST_PLAIN: 'visible-value' }), taskId);
        const scrubbed = db.scrubParamsJsonSecrets();
        if (scrubbed < 1) throw new Error('scrub did not touch the legacy row');
        const after = db.db.prepare('SELECT params_json FROM tasks WHERE id = ?').get(taskId).params_json;
        if (after.includes(SECRET)) throw new Error('scrub left plaintext secret in params_json');
        if (!after.includes('visible-value')) throw new Error('scrub removed a non-secret value');

        // 4. Tasks without env entries keep params_json as source of truth (no scrub).
        const legacy = await request('/api/tasks', {
          method: 'POST', headers,
          body: JSON.stringify({ name: 'S3 legacy task', type: 'shell', script_path: 'tasks/s3-legacy.sh' }),
        });
        const legacyId = legacy.body.data.id;
        db.db.prepare('UPDATE tasks SET params_json = ? WHERE id = ?')
          .run(JSON.stringify({ LEGACY_TOKEN: 'legacy-secret-456' }), legacyId);
        db.scrubParamsJsonSecrets();
        const legacyAfter = db.db.prepare('SELECT params_json FROM tasks WHERE id = ?').get(legacyId).params_json;
        if (!legacyAfter.includes('legacy-secret-456')) throw new Error('scrub touched source-of-truth params_json');
        // ...but the API still masks it on the way out.
        const listed2 = await request('/api/tasks', { headers });
        const legacyTask = listed2.body.data.find((t) => t.id === legacyId);
        if (JSON.stringify(legacyTask).includes('legacy-secret-456')) throw new Error('API leaks legacy secret');

        await shutdown('s3 integration test');
        process.stdout.write('s3-ok');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: projectRoot,
      // S4: secret env values are encrypted at rest; the test runtime needs a
      // master key like production does.
      env: { ...process.env, PANEL_RUNTIME_ROOT: runtimeRoot, HOST: '127.0.0.1', PORT: '0' },
      encoding: 'utf8',
      timeout: 60000,
    });

    assert.equal(result.signal, null, result.stderr || 'integration test timed out');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /s3-ok/);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
