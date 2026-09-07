(function exposeFileBrowserController(global) {
  function create(deps = {}) {
    const actions = deps.actions || {};
    let mounted = false;
    let path = '';

    function mount() {
      if (mounted) return;
      mounted = true;
      if (typeof actions.mount === 'function') actions.mount();
    }

    function unmount() {
      if (!mounted) return;
      mounted = false;
      if (typeof actions.unmount === 'function') actions.unmount();
    }

    async function load(nextPath = path) {
      path = String(nextPath || '').replace(/^\/+|\/+$/g, '');
      if (typeof actions.load === 'function') return actions.load(path);
      return undefined;
    }

    function currentPath() {
      return path;
    }

    return { mount, unmount, load, currentPath };
  }

  global.FileBrowserController = { create };
})(window);
