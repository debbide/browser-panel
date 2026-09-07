(function exposeStateStore(global) {
  function createStateStore(initialState = {}) {
    let state = { ...initialState };
    const subscribers = new Set();

    return {
      get() {
        return state;
      },
      update(patch) {
        state = { ...state, ...patch };
        subscribers.forEach((subscriber) => subscriber(state));
        return state;
      },
      subscribe(subscriber) {
        subscribers.add(subscriber);
        return () => subscribers.delete(subscriber);
      },
    };
  }

  global.createStateStore = createStateStore;
})(window);

let profilesCache = [];
let editingId = null;
let tasksCache = [];
let runsCache = [];
let runningTaskIds = new Set();
let stoppingTaskIds = new Set();
let scriptsCache = [];
let lastRunsByTask = new Map();
let selectedScriptPath = '';
let browserSessionOpen = false;
let browserOpenedAt = null;
