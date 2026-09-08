const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { read } = require("./helpers");

function loadModule(window) {
  vm.runInContext(read("public/core/clipboard.js"), vm.createContext({ window }));
  return window.Clipboard;
}

test("clipboard uses the secure clipboard API when available", async () => {
  const writes = [];
  const window = {
    isSecureContext: true,
    navigator: { clipboard: { writeText: async (text) => writes.push(text) } },
  };
  await loadModule(window).copyText("hello");
  assert.deepEqual(writes, ["hello"]);
});

test("clipboard loads before runtime and owns its implementation", () => {
  const html = read("public/index.html");
  const runtime = read("public/panel-runtime.js");
  const shared = html.indexOf("/core/clipboard.js?v=20260908a");
  const runtimeScript = html.indexOf("/panel-runtime.js?v=20260907a");
  assert.ok(shared >= 0);
  assert.ok(runtimeScript > shared);
  assert.doesNotMatch(runtime, /async function copyText\(/);
  assert.match(runtime, /const \{ copyText \} = Clipboard;/);
});
