(function exposeBrowserResourcesApi(global) {
  const json = (body) => ({
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  global.BrowserResourcesApi = {
    loadBrowser: () => global.fetchJson('/api/browser'),
    openBrowser: (body) => global.fetchJson('/api/browser/open', {
      method: 'POST',
      ...json(body),
    }),
    closeBrowser: () => global.fetchJson('/api/browser/close', { method: 'POST' }),
    listProfiles: () => global.fetchJson('/api/browser-profiles'),
    loadProfileEnv: (id) => global.fetchJson(`/api/browser-profiles/${id}/env`),
    createProfile: (body) => global.fetchJson('/api/browser-profiles', {
      method: 'POST',
      ...json(body),
    }),
    updateProfile: (id, body) => global.fetchJson(`/api/browser-profiles/${id}`, {
      method: 'PUT',
      ...json(body),
    }),
    saveProfileEnv: (id, body) => global.fetchJson(`/api/browser-profiles/${id}/env`, {
      method: 'PUT',
      ...json(body),
    }),
    deleteProfile: (id) => global.fetchJson(`/api/browser-profiles/${id}`, { method: 'DELETE' }),
    resourceFilesystems: {
      extensions: { api: '/api/extensions-fs', rootLabel: '/home/browser/browser-work/' },
      profiles: { api: '/api/profiles-fs', rootLabel: 'profiles/' },
    },
  };
})(window);
