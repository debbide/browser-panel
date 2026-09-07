(function exposeSettingsController(global) {
  function create(deps = {}) {
    const api = deps.api || {};
    const view = deps.view || {};
    const actions = deps.actions || {};
    let mounted = false;

    function mount() {
      if (mounted) return;
      mounted = true;
      if (typeof actions.mount === 'function') actions.mount({ api, view });
    }

    function unmount() {
      if (!mounted) return;
      mounted = false;
      if (typeof actions.unmount === 'function') actions.unmount();
    }

    async function load() {
      if (typeof actions.load === 'function') return actions.load({ api, view });
      return undefined;
    }

    return { mount, unmount, load };
  }

  global.SettingsController = { create };
})(window);
