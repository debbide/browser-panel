(function exposeBackupStorageController(global) {
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
      actions.loadSettings?.();
      actions.loadList?.();
    }

    return { mount, unmount, load };
  }

  global.BackupStorageController = { create };
})(window);
