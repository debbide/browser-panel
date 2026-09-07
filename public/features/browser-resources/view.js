(function exposeBrowserResourcesView(global) {
  function renderBrowserControls(render, state) {
    return render(state);
  }

  function renderProfiles(render, profiles) {
    return render(profiles);
  }

  function renderResourceEntries(render, entries) {
    return render(entries);
  }

  global.BrowserResourcesView = {
    renderBrowserControls,
    renderProfiles,
    renderResourceEntries,
  };
})(window);
