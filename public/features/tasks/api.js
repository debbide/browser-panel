(function exposeTasksApi(global) {
  const jsonHeaders = { 'Content-Type': 'application/json' };

  function listTasks() {
    return global.fetchJson('/api/tasks');
  }

  function saveTask(id, payload) {
    return global.fetchJson(id ? `/api/tasks/${id}` : '/api/tasks', {
      method: id ? 'PUT' : 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(payload),
    });
  }

  function runTask(id, profileId, options = {}) {
    // Default is async (202 + runId); pass { wait: true } for the legacy
    // blocking semantics (?wait=1, waits for the whole task to finish).
    const wait = options && options.wait ? '?wait=1' : '';
    return global.fetchJson(`/api/tasks/${id}/run${wait}`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ profile_id: profileId || null }),
    });
  }

  function stopTask(id) {
    return global.fetchJson(`/api/tasks/${id}/stop`, { method: 'POST' });
  }

  function deleteTask(id) {
    return global.fetchJson(`/api/tasks/${id}`, { method: 'DELETE' });
  }

  async function testCondition(id, condition) {
    const response = await global.fetchJson(`/api/tasks/${id}/condition/test`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ condition }),
    });
    return response.data;
  }

  global.TasksApi = { listTasks, saveTask, runTask, stopTask, deleteTask, testCondition };
})(window);
