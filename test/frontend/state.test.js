const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { read } = require('./helpers');

function loadCoreModule(path, globals = {}) {
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    ...globals,
  });
  context.window = context;
  vm.runInContext(read(path), context);
  return context;
}

test('state updates preserve fields that are not modified', () => {
  const context = loadCoreModule('public/core/state.js');
  const store = context.createStateStore({ activePanel: 'tasks', filter: 'all' });
  const notifications = [];
  store.subscribe((state) => notifications.push({ ...state }));
  store.update({ filter: 'running' });
  assert.deepEqual({ ...store.get() }, { activePanel: 'tasks', filter: 'running' });
  assert.deepEqual(notifications, [{ activePanel: 'tasks', filter: 'running' }]);
});

test('SSE start is idempotent and unload closes the connection', () => {
  const connections = [];
  const listeners = new Map();
  class FakeEventSource {
    static CLOSED = 2;
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.handlers = new Map();
      this.closed = false;
      connections.push(this);
    }
    addEventListener(type, handler) {
      this.handlers.set(type, handler);
    }
    close() {
      this.closed = true;
    }
  }
  const document = {
    hidden: false,
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    getElementById() {
      return { hidden: true };
    },
  };
  const context = loadCoreModule('public/core/events.js', {
    document,
    EventSource: FakeEventSource,
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
  });
  const stream = context.createEventStream({ refreshStatus() {}, loadWarpStatus() {} });
  stream.start();
  stream.start();
  assert.equal(connections.length, 1);
  assert.equal(listeners.has('visibilitychange'), true);
  assert.equal(listeners.has('beforeunload'), true);
  listeners.get('beforeunload')();
  assert.equal(connections[0].closed, true);
});

test('SSE events refresh only their declared business domains', () => {
  const connections = [];
  class FakeEventSource {
    static CLOSED = 2;
    constructor() {
      this.handlers = new Map();
      connections.push(this);
    }
    addEventListener(type, handler) {
      this.handlers.set(type, handler);
    }
    close() {}
  }
  const calls = [];
  const context = loadCoreModule('public/core/events.js', {
    document: {
      hidden: false,
      addEventListener() {},
      getElementById() {
        return { hidden: false };
      },
    },
    EventSource: FakeEventSource,
    addEventListener() {},
  });
  const stream = context.createEventStream({
    refreshStatus() { calls.push('status'); },
    loadWarpStatus() { calls.push('warp'); },
    refreshDebounceMs: 0,
  });
  stream.start();
  connections[0].handlers.get('task')();
  connections[0].handlers.get('warp')();
  return new Promise((resolve) => setTimeout(resolve, 5)).then(() => {
    assert.deepEqual(calls, ['warp', 'status']);
  });
});

test('queued refresh preserves the active SSE connection', () => {
  const connections = [];
  class FakeEventSource {
    static CLOSED = 2;
    constructor() {
      this.handlers = new Map();
      this.closed = false;
      connections.push(this);
    }
    addEventListener(type, handler) {
      this.handlers.set(type, handler);
    }
    close() {
      this.closed = true;
    }
  }
  const context = loadCoreModule('public/core/events.js', {
    document: { hidden: false, addEventListener() {}, getElementById() { return null; } },
    EventSource: FakeEventSource,
    addEventListener() {},
  });
  const stream = context.createEventStream({
    refreshStatus() {},
    loadWarpStatus() {},
    refreshDebounceMs: 0,
  });
  stream.start();
  stream.scheduleRefresh();
  assert.equal(connections.length, 1);
  assert.equal(connections[0].closed, false);
});

test('active panel activation keeps tab and header state synchronized', () => {
  const source = read('public/panel-runtime.js');
  assert.match(source, /function activateAppTab\(targetId/);
  assert.match(source, /classList\.toggle\('active'/);
  assert.match(source, /tabContents\.forEach/);
});

test('task filter and backup selections use persistent module state', () => {
  const source = read('public/core/state.js');
  assert.match(source, /let selectedBackupTaskIds = new Set\(\)/);
  assert.match(source, /let tasksCache = \[\]/);
  assert.match(read('public/panel-runtime.js'), /window\.selectTaskGroup/);
});

test('SSE startup is guarded and reconnect timing remains explicit', () => {
  const source = read('public/core/events.js');
  assert.match(source, /function createEventStream\(/);
  assert.match(source, /if \(started\) return;/);
  assert.match(source, /new EventSource\(sseUrl\)/);
  assert.match(source, /EventSource 自带重连/);
  assert.match(source, /startFallbackPolling\(\)/);
});

test('SSE events refresh only declared domains', () => {
  const source = read('public/core/events.js');
  assert.match(source, /eventSource\.addEventListener\('task'/);
  assert.match(source, /eventSource\.addEventListener\('state'/);
  assert.match(source, /const onStateEvent = \(\) => scheduleRefresh\(\)/);
});
