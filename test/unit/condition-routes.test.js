const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { createConditionRouter } = require('../../server/routes/condition-routes');

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

function createApp(overrides = {}) {
  const updates = [];
  const task = { id: 7, condition_enabled: 1, condition_json: '{"type":"http_check"}' };
  const app = express();
  app.use(express.json());
  app.use('/api', createConditionRouter({
    db: {
      getTask: (id) => id === 7 ? task : null,
      updateTask: (id, value) => updates.push([id, value]),
    },
    listConditionTypes: () => [{ type: 'http_check', label: 'HTTP' }],
    parseConditionJson: JSON.parse,
    normalizeConditionPayload: (value) => value,
    evaluateTaskCondition: async () => ({ status: 'ok', detail: 'ready', shouldTrigger: true }),
    now: () => new Date('2026-09-07T00:00:00.000Z'),
    ...overrides,
  }));
  return { app, updates };
}

test('condition routes preserve type listing and missing-task contracts', async () => {
  const { app } = createApp();
  const types = await request(app, 'GET', '/api/conditions/types');
  assert.deepEqual(types.body, { data: [{ type: 'http_check', label: 'HTTP' }] });

  const missing = await request(app, 'POST', '/api/tasks/9/condition/test', {});
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { message: 'Task not found' });
});

test('condition routes preserve draft evaluation without persisting saved status', async () => {
  let evaluated;
  const { app, updates } = createApp({
    evaluateTaskCondition: async (task) => {
      evaluated = task;
      return { status: 'draft', detail: 'preview', shouldTrigger: false };
    },
  });
  const response = await request(app, 'POST', '/api/tasks/7/condition/test', {
    condition_json: '{"type":"remaining_callback","config":{"url":"https://example.test"}}',
  });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(evaluated.condition_json).type, 'remaining_callback');
  assert.deepEqual(updates, []);
});

test('condition routes persist bounded status fields for saved evaluations', async () => {
  const { app, updates } = createApp({
    evaluateTaskCondition: async () => ({ status: 'ok', detail: 'x'.repeat(700) }),
  });
  const response = await request(app, 'POST', '/api/tasks/7/condition/test', {});
  assert.equal(response.status, 200);
  assert.equal(updates.length, 1);
  assert.equal(updates[0][1].condition_last_detail.length, 500);
  assert.equal(updates[0][1].condition_last_checked_at, '2026-09-07T00:00:00.000Z');
});
