const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '../..');

test('critical backend routes preserve settings, groups, files, metadata, and cleanup contracts', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-routes-'));
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
        const setup = await request('/api/auth/setup', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'routes-admin', password: 'routes-password', confirmPassword: 'routes-password' }),
        });
        if (setup.status !== 200) throw new Error('setup failed');
        const cookie = setup.cookie.split(';')[0];
        const headers = { 'content-type': 'application/json', cookie };

        const scheduler = await request('/api/settings/scheduler', {
          method: 'POST', headers, body: JSON.stringify({ allowParallel: true }),
        });
        if (scheduler.status !== 200 || scheduler.body.data.allowParallel !== true) throw new Error('scheduler save failed');
        const schedulerRead = await request('/api/settings/scheduler', { headers: { cookie } });
        if (schedulerRead.body.data.allowParallel !== true || !Array.isArray(schedulerRead.body.data.runningTaskIds)) throw new Error('scheduler read failed');

        const envSaved = await request('/api/env', {
          method: 'PUT', headers, body: JSON.stringify({ scope: 'global', env: [{ name: 'ROUTE_VALUE', value: 'ok', is_secret: false }] }),
        });
        if (envSaved.status !== 200 || envSaved.body.data.length !== 1) throw new Error('env save failed');
        const envRead = await request('/api/env?scope=global', { headers: { cookie } });
        if (!envRead.body.data.some((entry) => entry.name === 'ROUTE_VALUE' && entry.value === 'ok')) throw new Error('env read failed');

        const createdGroup = await request('/api/task-groups', {
          method: 'POST', headers, body: JSON.stringify({ name: 'Routes Group' }),
        });
        if (createdGroup.status !== 200 || !createdGroup.body.data.id) throw new Error('group create failed');
        const groupId = createdGroup.body.data.id;
        const renamedGroup = await request('/api/task-groups/' + groupId, {
          method: 'PUT', headers, body: JSON.stringify({ name: 'Renamed Group' }),
        });
        if (renamedGroup.status !== 200 || renamedGroup.body.data.name !== 'Renamed Group') throw new Error('group update failed');
        const groups = await request('/api/task-groups', { headers: { cookie } });
        if (!groups.body.data.some((group) => group.id === groupId)) throw new Error('group list failed');

        const madeDir = await request('/api/tasks-fs/mkdir', {
          method: 'POST', headers, body: JSON.stringify({ parent: '', name: 'route-files' }),
        });
        if (madeDir.status !== 200) throw new Error('mkdir failed');
        const written = await request('/api/tasks-fs/write', {
          method: 'PUT', headers, body: JSON.stringify({ path: 'route-files/sample.js', content: "console.log('route');\n" }),
        });
        if (written.status !== 200) throw new Error('write failed');
        const read = await request('/api/tasks-fs/read?path=route-files%2Fsample.js', { headers: { cookie } });
        if (read.status !== 200 || !read.body.data.content.includes("console.log('route')")) throw new Error('read failed');
        const listed = await request('/api/tasks-fs?path=route-files', { headers: { cookie } });
        if (!listed.body.data.entries.some((entry) => entry.name === 'sample.js')) throw new Error('list failed');
        const removedFile = await request('/api/tasks-fs', {
          method: 'DELETE', headers, body: JSON.stringify({ path: 'route-files' }),
        });
        if (removedFile.status !== 200 || removedFile.body.ok !== true) throw new Error('delete failed');

        const cleanup = await request('/api/storage/cleanup/preview?retentionDays=30', { headers: { cookie } });
        if (cleanup.status !== 200 || !cleanup.body.data || cleanup.body.data.dryRun !== true) throw new Error('cleanup preview failed');
        const meta = await request('/api/meta', { headers: { cookie } });
        if (meta.status !== 200 || !meta.body.data.paths.tasksDir || !meta.body.data.paths.runtimeDataDir) throw new Error('meta failed');

        const deletedGroup = await request('/api/task-groups/' + groupId, { method: 'DELETE', headers: { cookie } });
        if (deletedGroup.status !== 200 || deletedGroup.body.ok !== true) throw new Error('group delete failed');

        await shutdown('backend routes integration test');
        process.stdout.write('backend-routes-ok');
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: projectRoot,
      env: { ...process.env, PANEL_RUNTIME_ROOT: runtimeRoot, HOST: '127.0.0.1', PORT: '0' },
      encoding: 'utf8',
      timeout: 30000,
    });

    assert.equal(result.signal, null, result.stderr || 'integration test timed out');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /backend-routes-ok/);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
