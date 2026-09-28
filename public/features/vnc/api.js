(function exposeVncApi(global) {
  global.VncApi = {
    load: () => global.fetchJson('/api/vnc/settings'),
    save: (body) => global.fetchJson('/api/vnc/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    test: (body) => global.fetchJson('/api/vnc/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }),
  };
})(window);
