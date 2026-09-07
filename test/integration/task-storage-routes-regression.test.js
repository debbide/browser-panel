const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '../..');

test('task storage routes preserve auth, methods, payloads, production paths, and file safety', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-task-storage-'));
  try {
    const script = String.raw`
      (async () => {
        const fs = require('node:fs');
        const path = require('node:path');
        const config = require('./config');
        const { startServer, shutdown } = require('./server/index');
        fs.mkdirSync(config.paths.tasksDir, { recursive: true });
        fs.writeFileSync(path.join(config.paths.tasksDir, 'top.js'), 'console.log("top");\n');
        fs.mkdirSync(path.join(config.paths.tasksDir, 'nested'), { recursive: true });
        fs.writeFileSync(path.join(config.paths.tasksDir, 'nested', 'child.py'), 'print("child")\n');
        fs.writeFileSync(path.join(config.paths.tasksDir, 'nested', 'binary.png'), Buffer.from([0, 1, 2, 3]));

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
          return { status: response.status, body, cookie: response.headers.get('set-cookie') || '' };
        };

        for (const pathname of ['/api/scripts', '/api/tasks-fs', '/api/tasks-fs/read?path=top.js']) {
          const response = await request(pathname);
          if (response.status !== 401 || response.body.code !== 'unauthenticated') throw new Error('auth contract failed: ' + pathname);
        }

        const setup = await request('/api/auth/setup', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'storage-admin', password: 'storage-password', confirmPassword: 'storage-password' }),
        });
        const cookie = setup.cookie.split(';')[0];
        const headers = { 'content-type': 'application/json', cookie };

        const scripts = await request('/api/scripts', { headers: { cookie } });
        if (scripts.status !== 200 || scripts.body.data.length !== 1 || scripts.body.data[0].path !== 'tasks/top.js') throw new Error('top-level script contract failed');
        const recursive = await request('/api/scripts?recursive=1', { headers: { cookie } });
        if (recursive.status !== 200 || !recursive.body.data || !recursive.body.data.some((entry) => entry.path === 'tasks/nested/child.py')) throw new Error('recursive script contract failed: ' + JSON.stringify(recursive));

        const traversal = await request('/api/tasks-fs/read?path=..%2Foutside.txt', { headers: { cookie } });
        if (traversal.status !== 400 || traversal.body.message !== 'Invalid path') throw new Error('traversal safety failed');
        const binary = await request('/api/tasks-fs/read?path=nested%2Fbinary.png', { headers: { cookie } });
        if (binary.status !== 400 || binary.body.message !== 'Binary file — use download') throw new Error('binary edit safety failed');
        const rootDelete = await request('/api/tasks-fs', { method: 'DELETE', headers, body: JSON.stringify({ path: '' }) });
        if (rootDelete.status !== 400 || rootDelete.body.message !== 'Cannot delete tasks root') throw new Error('root delete safety failed');

        const mkdir = await request('/api/tasks-fs/mkdir', { method: 'POST', headers, body: JSON.stringify({ parent: '', name: 'route-safe' }) });
        if (mkdir.status !== 200 || mkdir.body.data.path !== 'route-safe') throw new Error('mkdir contract failed');
        const write = await request('/api/tasks-fs/write', { method: 'PUT', headers, body: JSON.stringify({ path: 'route-safe/file.sh', content: 'echo safe\n' }) });
        if (write.status !== 200 || write.body.data.path !== 'route-safe/file.sh') throw new Error('write contract failed');
        const read = await request('/api/tasks-fs/read?path=route-safe%2Ffile.sh', { headers: { cookie } });
        if (read.status !== 200 || read.body.data.content !== 'echo safe\n') throw new Error('read contract failed');
        const download = await request('/api/tasks-fs/download?path=route-safe%2Ffile.sh', { headers: { cookie } });
        if (download.status !== 200 || download.body !== 'echo safe\n') throw new Error('download contract failed');
        const wrongMethod = await request('/api/tasks-fs/write', { method: 'POST', headers, body: '{}' });
        if (wrongMethod.status !== 200 || !String(wrongMethod.body).includes('<!DOCTYPE html>')) throw new Error('method fallback contract failed');
        const removed = await request('/api/tasks-fs', { method: 'DELETE', headers, body: JSON.stringify({ path: 'route-safe' }) });
        if (removed.status !== 200 || removed.body.ok !== true) throw new Error('delete contract failed');

        if (!path.resolve(config.paths.tasksDir).startsWith(path.resolve(process.env.PANEL_RUNTIME_ROOT))) throw new Error('runtime path isolation failed');
        await shutdown('task storage route regression test');
        process.stdout.write(JSON.stringify({ checked: 14 }));
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: projectRoot,
      env: { ...process.env, PANEL_RUNTIME_ROOT: runtimeRoot, HOST: '127.0.0.1', PORT: '0' },
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(result.signal, null, result.stderr || 'task storage route regression test timed out');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"checked":14/);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
