(function exposeFileBrowserView(global) {
  const { formatBytes, formatFsMtime: formatMtime } = global.FsPresentation;

  function renderBreadcrumb(element, path, escapeHtml) {
    if (!element) return;
    element.innerHTML = `<code>tasks/${escapeHtml(path || '')}${path ? '/' : ''}</code>`;
  }

  function renderEntries(element, entries, renderer) {
    if (!element) return;
    renderer(element, Array.isArray(entries) ? entries : []);
  }

  global.FileBrowserView = { formatBytes, formatMtime, promptFsName: global.FsPresentation.promptFsName, renderBreadcrumb, renderEntries };
})(window);
