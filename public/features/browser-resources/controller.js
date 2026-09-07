(function exposeBrowserResourcesController(global) {
  function create({ api, view, actions = {} }) {
    let mounted = false;

    function mount() {
      if (mounted) return;
      mounted = true;
      actions.mount?.({ api, view });
    }

    function unmount() {
      if (!mounted) return;
      mounted = false;
      actions.unmount?.();
    }

    function load() {
      return actions.load?.();
    }

    return { mount, unmount, load };
  }

  global.BrowserResourcesController = { create };
})(window);
