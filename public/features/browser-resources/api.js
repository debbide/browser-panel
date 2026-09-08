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
    listResourceEntries(kind, dir = '') {
      const config = this.resourceFilesystems[kind];
      if (!config) return Promise.resolve({ data: { entries: [] } });
      const suffix = dir ? `?path=${encodeURIComponent(dir)}` : '';
      return global.fetchJson(`${config.api}${suffix}`);
    },
    resourceAction(kind, path, action, extra = {}) {
      const config = this.resourceFilesystems[kind];
      return global.fetchJson(`${config.api}/${action}`, {
        method: 'POST',
        ...json({ path, ...extra }),
      });
    },
    deleteResourceEntry(kind, path) {
      const config = this.resourceFilesystems[kind];
      return global.fetchJson(config.api, { method: 'DELETE', ...json({ path }) });
    },
    createResourceDirectory(kind, parent, name) {
      const config = this.resourceFilesystems[kind];
      return global.fetchJson(`${config.api}/mkdir`, {
        method: 'POST',
        ...json({ parent, name }),
      });
    },
    resourceFilesystems: {
      extensions: { api: '/api/extensions-fs', rootLabel: '/home/browser/browser-work/' },
      profiles: { api: '/api/profiles-fs', rootLabel: 'profiles/' },
    },
  };
})(window);
