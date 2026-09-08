(function exposeBrowserResourcesView(global) {
  function renderBrowserControls(render, state) {
    return render(state);
  }

  function renderProfiles(render, profiles) {
    return render(profiles);
  }

  function renderResourceStatus(root, state, escapeHtml) {
    const list = root.querySelector('.resource-list');
    const breadcrumb = root.querySelector('.resource-breadcrumb');
    breadcrumb.innerHTML = `<code>${escapeHtml(state.rootLabel)}${escapeHtml(state.path)}${state.path ? '/' : ''}</code>`;
    list.innerHTML = '<div class="files-list-empty">加载中…</div>';
    return list;
  }

  function renderResourceEmpty(list) {
    list.innerHTML = '<div class="files-list-empty">空目录</div>';
  }

  function renderResourceError(list, error, escapeHtml) {
    list.innerHTML = `<div class="files-list-empty">${escapeHtml(error.message || '加载失败')}</div>`;
  }

  function renderResourceEntries(render, entries) {
    return render(entries);
  }

  global.BrowserResourcesView = {
    renderBrowserControls,
    renderProfiles,
    renderResourceStatus,
    renderResourceEmpty,
    renderResourceError,
    renderResourceEntries,
  };
})(window);
