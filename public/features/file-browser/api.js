(function exposeFileBrowserApi(global) {
  const jsonHeaders = { 'Content-Type': 'application/json' };

  function request(path, method, payload) {
    return global.fetchJson(path, {
      method,
      headers: jsonHeaders,
      body: JSON.stringify(payload),
    });
  }

  function list(path = '') {
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    return global.fetchJson(`/api/tasks-fs${query}`);
  }

  function read(path) {
    return global.fetchJson(`/api/tasks-fs/read?path=${encodeURIComponent(path)}`);
  }

  function write(payload) {
    return request('/api/tasks-fs/write', 'POST', payload);
  }

  function remove(path) {
    return request('/api/tasks-fs', 'DELETE', { path });
  }

  function mkdir(payload) {
    return request('/api/tasks-fs/mkdir', 'POST', payload);
  }

  function createFile(payload) {
    return request('/api/tasks-fs/create-file', 'POST', payload);
  }

  function upload(payload) {
    return request('/api/tasks-fs/upload', 'POST', payload);
  }

  global.FileBrowserApi = { list, read, write, remove, mkdir, createFile, upload };
})(window);
