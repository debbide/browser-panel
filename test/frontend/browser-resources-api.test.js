const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { read } = require('./helpers');

function loadApi(fetchJson) {
  const context = vm.createContext({ window: { fetchJson } });
  context.window.window = context.window;
  vm.runInContext(read('public/features/browser-resources/api.js'), context);
  return context.window.BrowserResourcesApi;
}

test('browser resources API exposes browser and profile operations', () => {
  const api = loadApi(async () => ({}));
  for (const name of ['loadBrowser', 'openBrowser', 'closeBrowser', 'listProfiles', 'loadProfileEnv', 'createProfile', 'updateProfile', 'saveProfileEnv', 'deleteProfile']) {
    assert.equal(typeof api[name], 'function', name);
  }
});

test('browser session API preserves paths, methods, and payloads', async () => {
  const calls = [];
  const api = loadApi(async (...args) => { calls.push(args); return { data: {} }; });
  const options = { profile_id: 7, headless: false };
  await api.loadBrowser();
  await api.openBrowser(options);
  await api.closeBrowser();
  assert.deepEqual(calls.map(([path, request]) => [path, request && JSON.parse(JSON.stringify(request))]), [
    ['/api/browser', undefined],
    ['/api/browser/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    }],
    ['/api/browser/close', { method: 'POST' }],
  ]);
});

test('profile API preserves CRUD and environment request contracts', async () => {
  const calls = [];
  const api = loadApi(async (...args) => { calls.push(args); return { data: {} }; });
  const profile = { name: 'default', proxy: '' };
  const env = { FOO: 'bar' };
  await api.listProfiles();
  await api.loadProfileEnv(12);
  await api.createProfile(profile);
  await api.updateProfile(12, profile);
  await api.saveProfileEnv(12, env);
  await api.deleteProfile(12);
  assert.deepEqual(calls.map(([path, request]) => [path, request && JSON.parse(JSON.stringify(request))]), [
    ['/api/browser-profiles', undefined],
    ['/api/browser-profiles/12/env', undefined],
    ['/api/browser-profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile),
    }],
    ['/api/browser-profiles/12', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile),
    }],
    ['/api/browser-profiles/12/env', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(env),
    }],
    ['/api/browser-profiles/12', { method: 'DELETE' }],
  ]);
});

test('resource filesystem definitions preserve API roots and labels', () => {
  const api = loadApi(async () => ({}));
  assert.deepEqual(JSON.parse(JSON.stringify(api.resourceFilesystems)), {
    extensions: { api: '/api/extensions-fs', rootLabel: '/home/browser/browser-work/' },
    profiles: { api: '/api/profiles-fs', rootLabel: 'profiles/' },
  });
});
