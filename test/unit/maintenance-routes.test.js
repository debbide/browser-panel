const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { createMaintenanceRouter } = require('../../server/routes/maintenance-routes');

async function request(app, method, path, body) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const contentType = response.headers.get('content-type') || '';
    const responseBody = contentType.includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, body: responseBody, headers: response.headers };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function createApp(overrides = {}) {
  const calls = [];
  const backup = {
    normalizeTaskIds: (value) => value,
    exportBackup: (options) => {
      calls.push(['export', options]);
      return { header: { encrypted: false, taskName: '示例' }, data: '{}' };
    },
    buildExportFilename: (_date, header) => `${header.taskName || 'backup'}.json`,
    parseBackup: (value, options) => {
      calls.push(['parse', value, options]);
      return { parsed: true };
    },
    analyze: (value, options) => ({ value, options }),
    toPreview: (value) => value,
    importBackup: (value, options) => {
      calls.push(['import', value, options]);
      return { imported: true };
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createMaintenanceRouter({
    backup,
    cleanupStorage: (_db, options) => ({ ...options, failures: [] }),
    normalizeRetentionDays: Number,
    normalizeCategories: (value) => value,
    db: {},
    getRunningTaskIds: () => [4],
    reloadJobs: () => calls.push(['reload']),
    executeTask: () => {},
    emit: (...args) => calls.push(['emit', ...args]),
    meta: { browser: { headless: true }, paths: { tasksDir: '/tasks' } },
    ...overrides,
  }));
  return { app, calls };
}

test('maintenance routes preserve cleanup preview and metadata contracts', async () => {
  const { app } = createApp();
  const cleanup = await request(app, 'GET', '/api/storage/cleanup/preview?retentionDays=30&categories=logs,tmp');
  assert.equal(cleanup.status, 200);
  assert.equal(cleanup.body.data.dryRun, true);
  assert.equal(cleanup.body.data.retentionDays, 30);
  assert.deepEqual(cleanup.body.data.categories, ['logs', 'tmp']);
  assert.deepEqual(cleanup.body.data.runningTaskIds, [4]);

  const meta = await request(app, 'GET', '/api/meta');
  assert.deepEqual(meta.body, { data: { browser: { headless: true }, paths: { tasksDir: '/tasks' } } });
});

test('backup export keeps whitespace passphrases unencrypted and UTF-8 disposition', async () => {
  const { app, calls } = createApp();
  const response = await request(app, 'POST', '/api/backup/export', { task_ids: [7], passphrase: '   ' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.match(response.headers.get('content-disposition'), /filename="task\.json"/);
  assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''/);
  assert.deepEqual(calls[0], ['export', { taskIds: [7], passphrase: null }]);
});

test('backup import reloads jobs and emits task change only after success', async () => {
  const { app, calls } = createApp();
  const response = await request(app, 'POST', '/api/backup/import', { backup: { schema_version: 4 }, passphrase: 'secret' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { data: { imported: true } });
  assert.deepEqual(calls.slice(1), [['reload'], ['emit', 'tasks', { imported: true }]]);
});
