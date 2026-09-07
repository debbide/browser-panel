(function exposeSchedulerApi(global) {
  global.SchedulerApi = {
    load: () => global.fetchJson('/api/settings/scheduler'),
    save: (body) => global.fetchJson('/api/settings/scheduler', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  };
})(window);
