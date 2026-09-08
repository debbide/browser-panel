const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { createTaskRouter } = require('../../server/tasks/task-routes');

async function request(app, path) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: 'DELETE',
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function createApp(remove) {
  const app = express();
  app.use('/api/tasks', createTaskRouter({ remove }));
  return app;
}

test('task routes reject deleting a running task', async () => {
  const response = await request(
    createApp(() => ({ removed: false, reason: 'task_running' })),
    '/api/tasks/7'
  );

  assert.equal(response.status, 409);
  assert.deepEqual(response.body, {
    message: 'Task is currently running and cannot be deleted',
    code: 'task_running',
  });
});

test('task routes preserve missing and successful delete responses', async () => {
  const missing = await request(
    createApp(() => ({ removed: false, reason: 'not_found' })),
    '/api/tasks/8'
  );
  assert.equal(missing.status, 404);

  const removed = await request(
    createApp(() => ({ removed: true })),
    '/api/tasks/9'
  );
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { ok: true });
});
