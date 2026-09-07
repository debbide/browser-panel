(function exposeTasksModel(global) {
  function resolveTaskType(scriptPath, fallbackType) {
    const normalizedPath = String(scriptPath || '').toLowerCase();
    if (normalizedPath.endsWith('.py')) return 'python';
    if (normalizedPath.endsWith('.php')) return 'php';
    if (normalizedPath.endsWith('.sh')) return 'shell';
    return fallbackType;
  }

  global.TasksModel = { resolveTaskType };
})(window);
