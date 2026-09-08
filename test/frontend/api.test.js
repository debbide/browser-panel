const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { read } = require('./helpers');

function response({ status = 200, contentType = 'application/json', body = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => contentType },
    json: async () => body,
    text: async () => String(body),
  };
}

function loadSessionApi({ fetch, location = { pathname: '/', search: '', replace() {} } }) {
  const window = { fetch, location };
  vm.runInNewContext(read('public/core/session-api.js'), { window, encodeURIComponent });
  return window.SessionApi;
}

test('fetchJson returns JSON responses', async () => {
  const { fetchJson } = loadSessionApi({ fetch: async () => response({ body: { data: 1 } }) });
  assert.deepEqual(await fetchJson('/api/example'), { data: 1 });
});

test('fetchJson preserves non-JSON and HTML error text', async () => {
  let fetch = async () => response({ contentType: 'text/plain', body: 'plain' });
  let functions = loadSessionApi({ fetch });
  await assert.rejects(functions.fetchJson('/api/plain'), /接口 \/api\/plain 返回了非 JSON 响应/);
  fetch = async () => response({ contentType: 'text/html', body: '<!doctype html>' });
  functions = loadSessionApi({ fetch });
  await assert.rejects(functions.fetchJson('/api/html'), /返回了页面内容，后端路由可能异常/);
});

test('fetchJson redirects once on 401 and reports session expiry', async () => {
  const replacements = [];
  const location = { pathname: '/panel', search: '?tab=tasks', replace: (value) => replacements.push(value) };
  const { fetchJson } = loadSessionApi({
    fetch: async () => response({ status: 401 }),
    location,
  });
  await assert.rejects(fetchJson('/api/tasks'), /会话已失效，正在跳转登录页/);
  assert.deepEqual(replacements, ['/login.html?next=%2Fpanel%3Ftab%3Dtasks']);
});

test('fetchJson preserves backend error output and network errors', async () => {
  let functions = loadSessionApi({
    fetch: async () => response({ status: 500, body: { message: '执行失败', output: 'stderr' } }),
  });
  await assert.rejects(functions.fetchJson('/api/tasks'), /执行失败\nstderr/);
  functions = loadSessionApi({ fetch: async () => { throw new Error('offline'); } });
  await assert.rejects(functions.fetchJson('/api/tasks'), /offline/);
});

test('session API owns request helpers and loads before panel runtime', () => {
  const runtime = read('public/panel-runtime.js');
  const html = read('public/index.html');
  const moduleIndex = html.indexOf('/core/session-api.js');
  const runtimeIndex = html.indexOf('/panel-runtime.js');

  assert.doesNotMatch(runtime, /function fetchJson\s*\(/);
  assert.doesNotMatch(runtime, /function goLogin\s*\(/);
  assert.match(runtime, /const \{ fetchJson, goLogin \} = SessionApi/);
  assert.ok(html.includes(String.fromCharCode(60) + 'script src="/core/session-api.js?v=20260908a">' + String.fromCharCode(60) + '/script>'));
  assert.ok(moduleIndex >= 0);
  assert.ok(runtimeIndex > moduleIndex);
});
