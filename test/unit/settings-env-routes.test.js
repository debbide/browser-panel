const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createSettingsEnvRouter } = require('../../server/routes/settings-env');

async function withServer(options, run) {
  const app = express();
  app.use(express.json());
  app.use(createSettingsEnvRouter(options));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function readJson(response) {
  return JSON.parse(await response.text());
}

test('scheduler settings preserve response shape and boolean persistence', async () => {
  let allowParallel = false;
  const db = {
    isTaskParallelAllowed: () => allowParallel,
    setTaskParallelAllowed(value) {
      allowParallel = value;
      return allowParallel;
    },
  };

  await withServer({ db, getRunningTaskIds: () => [7, 9] }, async (baseUrl) => {
    let response = await fetch(`${baseUrl}/api/settings/scheduler`);
    assert.equal(response.status, 200);
    assert.deepEqual(await readJson(response), {
      data: { allowParallel: false, runningTaskIds: [7, 9] },
    });

    response = await fetch(`${baseUrl}/api/settings/scheduler`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowParallel: 1 }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await readJson(response), {
      data: { allowParallel: true, runningTaskIds: [7, 9] },
    });
  });
});

test('env routes preserve scope, secret-safe DB output, task sync and github compatibility', async () => {
  let githubCompat = false;
  const calls = [];
  const publicRows = [{
    id: 1,
    scope: 'task',
    owner_id: 42,
    name: 'TOKEN',
    value: '',
    valueMasked: '***',
    is_secret: 1,
    has_value: true,
    updated_at: '2026-09-07 00:00:00',
  }];
  const db = {
    listEnvEntriesPublic(scope, ownerId) {
      calls.push(['list', scope, ownerId]);
      return publicRows;
    },
    replaceEnvEntries(scope, ownerId, entries) {
      calls.push(['replace', scope, ownerId, entries]);
      return publicRows;
    },
    syncTaskParamsJsonFromEnv(ownerId) {
      calls.push(['sync', ownerId]);
    },
    isGithubCompatEnabled: () => githubCompat,
    setGithubCompatEnabled(value) {
      githubCompat = value;
      calls.push(['github', value]);
      return githubCompat;
    },
  };

  await withServer({ db, getRunningTaskIds: () => [] }, async (baseUrl) => {
    let response = await fetch(`${baseUrl}/api/env?scope=task&owner_id=42`);
    assert.equal(response.status, 200);
    assert.deepEqual(await readJson(response), { data: publicRows, githubCompat: false });
    assert.deepEqual(calls.shift(), ['list', 'task', 42]);

    response = await fetch(`${baseUrl}/api/env`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'task',
        owner_id: 42,
        env: [{ name: 'TOKEN', value: '', is_secret: '1' }],
        githubCompat: true,
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await readJson(response), { data: publicRows, githubCompat: true });
    assert.deepEqual(calls, [
      ['replace', 'task', 42, [{ name: 'TOKEN', value: '', is_secret: 1 }]],
      ['sync', 42],
      ['github', true],
    ]);
  });
});

test('settings and env persistence failures remain HTTP 400 responses', async () => {
  const db = {
    isTaskParallelAllowed: () => false,
    setTaskParallelAllowed() { throw new Error('scheduler rejected'); },
    listEnvEntriesPublic() { throw new Error('invalid scope'); },
    isGithubCompatEnabled: () => false,
  };

  await withServer({ db, getRunningTaskIds: () => [] }, async (baseUrl) => {
    let response = await fetch(`${baseUrl}/api/settings/scheduler`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowParallel: true }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await readJson(response), { message: 'scheduler rejected' });

    response = await fetch(`${baseUrl}/api/env?scope=invalid`);
    assert.equal(response.status, 400);
    assert.deepEqual(await readJson(response), { message: 'invalid scope' });
  });
});
