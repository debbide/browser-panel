const test = require('node:test');
const assert = require('node:assert/strict');

const { createSystemRouteRegistrars } = require('../../server/routes/system-routes');

function capturePublicRoutes(deps = {}) {
  const routes = {};
  const fakeApp = { get: (path, handler) => { routes[path] = handler; } };
  const { registerPublicRoutes } = createSystemRouteRegistrars({
    getVersion: () => ({ label: 'v9.9.9-test' }),
    ...deps,
  });
  registerPublicRoutes(fakeApp);
  return routes;
}

function fakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  return res;
}

test('/healthz is registered as a public route and returns ok + version', () => {
  const routes = capturePublicRoutes();
  assert.ok(typeof routes['/healthz'] === 'function', '/healthz handler must be registered');
  const res = fakeRes();
  routes['/healthz']({}, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, version: 'v9.9.9-test' });
});

test('/healthz carries no sensitive fields', () => {
  const routes = capturePublicRoutes();
  const res = fakeRes();
  routes['/healthz']({}, res);
  const text = JSON.stringify(res.body);
  assert.ok(!/token|secret|password|key/i.test(text), `unexpected sensitive-looking content: ${text}`);
});

test('existing public /api/version route is untouched', () => {
  const routes = capturePublicRoutes();
  assert.ok(typeof routes['/api/version'] === 'function');
  const res = fakeRes();
  routes['/api/version']({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.label, 'v9.9.9-test');
});
