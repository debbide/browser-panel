const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { createRuntimeRouter } = require('../../server/routes/runtime-routes');

async function request(app, method, path, body) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function createApp(dependencies) {
  const app = express();
  app.use(express.json());
  app.use('/api', createRuntimeRouter(dependencies));
  return app;
}

test('runtime routes preserve run conflicts and profile forwarding', async () => {
  const calls = [];
  const app = createApp({
    async triggerTaskExecution(taskId, options) {
      calls.push([taskId, options]);
      return { status: 409, payload: { message: 'Task is already running', code: 'already_running' } };
    },
    stopTask() { return false; },
    listRunsByTask() { return []; },
    listRuns() { return []; },
  });

  const response = await request(app, 'POST', '/api/tasks/7/run', { profile_id: 12 });
  assert.equal(response.status, 409);
  assert.deepEqual(response.body, { message: 'Task is already running', code: 'already_running' });
  assert.deepEqual(calls, [[7, { profileId: 12 }]]);
});

test('runtime routes preserve missing stop and run history responses', async () => {
  const app = createApp({
    async triggerTaskExecution() { throw new Error('boom'); },
    stopTask() { return false; },
    listRunsByTask(taskId) { return [{ id: 1, task_id: taskId }]; },
    listRuns(limit) { return [{ id: limit }]; },
  });

  const stopped = await request(app, 'POST', '/api/tasks/9/stop');
  assert.equal(stopped.status, 404);
  assert.deepEqual(stopped.body, { message: 'No running task can be stopped right now' });

  const taskRuns = await request(app, 'GET', '/api/tasks/9/runs');
  assert.deepEqual(taskRuns.body, { data: [{ id: 1, task_id: 9 }] });

  const runs = await request(app, 'GET', '/api/runs');
  assert.deepEqual(runs.body, { data: [{ id: 100 }] });
});
