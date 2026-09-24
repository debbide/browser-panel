const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { extractFunction, read } = require('./helpers');

function flush(times = 5) {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) p = p.then(() => new Promise((r) => setImmediate(r)));
  return p;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
    FakeEventSource.instances.push(this);
  }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(fn);
  }
  removeEventListener() {}
  close() { this.closed = true; }
  fire(name, payload) {
    for (const fn of this.listeners.get(name) || []) fn({ data: JSON.stringify(payload) });
  }
}
FakeEventSource.instances = [];

function loadOpenRunLog({ fetchJson }) {
  FakeEventSource.instances = [];
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://panel.test/' });
  const source = extractFunction(read('public/panel-runtime.js'), 'openRunLog');
  const context = vm.createContext({
    document: dom.window.document,
    window: dom.window,
    fetchJson,
    EventSource: FakeEventSource,
    prettyStatus: (s) => s,
    formatBytes: (n) => String(n),
    logLineClass: () => '',
    escapeHtml: (s) => s,
    toast: () => {},
    copyText: async () => {},
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    AbortController,
    setTimeout,
    clearTimeout,
    Promise,
    JSON,
    Number,
    URL,
  });
  vm.runInContext(`${source}\nthis.exports = { openRunLog };`, context);
  return { openRunLog: context.exports.openRunLog, dom };
}

test('F6: truncated event invalidates an in-flight stale drain (viewer never wedges)', async () => {
  const calls = [];
  const waiters = [];
  const fetchJson = async (url) => {
    const m = /offset=(\d+)/.exec(url);
    const offset = m ? Number(m[1]) : 0;
    calls.push(offset);
    const d = deferred();
    waiters.push({ offset, d });
    return d.promise;
  };
  const { openRunLog, dom } = loadOpenRunLog({ fetchJson });

  const opened = openRunLog(42);
  await flush();
  assert.equal(calls.length, 1, 'initial fetch must go out');
  // Initial load: 50KB of log, cursor parked at 40000.
  waiters[0].d.resolve({ data: { content: 'OLD-HEAD\n', nextOffset: 40000, size: 50000, status: 'running', taskId: 7 } });
  await opened;
  await flush();
  assert.deepEqual(calls, [0, 40000], 'drain must start fetching from the old cursor');

  // The stale drain's fetch is still in flight (its response was computed from
  // the pre-truncation file). The server now reports the truncation.
  const es = FakeEventSource.instances[0];
  assert.ok(es, 'EventSource must be subscribed');
  es.fire('log', { size: 1000, truncated: true });
  await flush();
  assert.deepEqual(calls, [0, 40000, 0], 'a fresh drain must restart from offset 0 after truncation');

  // Now the stale response arrives late (computed before the truncation).
  waiters[1].d.resolve({ data: { content: 'STALE-CHUNK\n', nextOffset: 41000, size: 50000 } });
  // And the fresh drain gets the new tail.
  waiters[2].d.resolve({ data: { content: 'NEW-TAIL\n', nextOffset: 1000, size: 1000 } });
  await flush(10);

  const terminal = dom.window.document.querySelector('[data-log-terminal]');
  const html = terminal.innerHTML;
  assert.ok(!html.includes('STALE-CHUNK'), 'stale pre-truncation content must not be appended after reset');
  assert.ok(html.includes('NEW-TAIL'), 'the new tail must be shown');

  // The viewer must not be wedged: a later growth event still triggers a drain.
  const before = calls.length;
  es.fire('log', { size: 1200 });
  await flush();
  assert.ok(calls.length > before, 'viewer must keep syncing after the truncation');
  const lastOffset = calls[calls.length - 1];
  assert.ok(lastOffset <= 1200, `cursor must stay within the truncated file, got offset ${lastOffset}`);

  // Cleanup: close the drawer.
  dom.window.document.querySelector('[data-close-log]').click();
  await flush();
});
