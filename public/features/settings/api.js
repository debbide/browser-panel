(function exposeSettingsApi(global) {
  const jsonHeaders = { 'Content-Type': 'application/json' };

  function post(path, payload) {
    return global.fetchJson(path, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(payload),
    });
  }

  function loadScheduler() {
    return global.fetchJson('/api/settings/scheduler');
  }

  function loadTelegram() {
    return global.fetchJson('/api/settings/telegram');
  }

  function saveTelegram(payload) {
    return post('/api/settings/telegram', payload);
  }

  function testTelegram() {
    return global.fetchJson('/api/settings/telegram/test', { method: 'POST' });
  }

  function saveScheduler(payload) {
    return post('/api/settings/scheduler', payload);
  }

  function loadSuccessHeuristics() {
    return global.fetchJson('/api/settings/success-heuristics');
  }

  function saveSuccessHeuristics(payload) {
    return post('/api/settings/success-heuristics', payload);
  }

  function loadBrowserRuntime() {
    return global.fetchJson('/api/settings/browser-runtime');
  }

  function saveBrowserRuntime(payload) {
    return post('/api/settings/browser-runtime', payload);
  }

  global.SettingsApi = {
    loadTelegram,
    saveTelegram,
    testTelegram,
    loadScheduler,
    saveScheduler,
    loadSuccessHeuristics,
    saveSuccessHeuristics,
    loadBrowserRuntime,
    saveBrowserRuntime,
  };
})(window);
