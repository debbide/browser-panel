(function exposeFileBrowserView(global) {
  function formatBytes(size) {
    const value = Number(size) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  function formatMtime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      const text = String(value);
      return text.length >= 16 ? text.slice(0, 16).replace('T', ' ') : text;
    }
    const pad = (part) => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function renderBreadcrumb(element, path, escapeHtml) {
    if (!element) return;
    element.innerHTML = `<code>tasks/${escapeHtml(path || '')}${path ? '/' : ''}</code>`;
  }

  function renderEntries(element, entries, renderer) {
    if (!element) return;
    renderer(element, Array.isArray(entries) ? entries : []);
  }

  global.FileBrowserView = { formatBytes, formatMtime, renderBreadcrumb, renderEntries };
})(window);
