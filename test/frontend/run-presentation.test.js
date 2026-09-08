const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { read } = require("./helpers");

function loadModule() {
  const window = {};
  vm.runInContext(read("public/core/run-presentation.js"), vm.createContext({ Number, window }));
  return window.RunPresentation;
}

test("run presentation preserves formatting contracts", () => {
  const presentation = loadModule();
  assert.equal(presentation.prettyErrorCode("timeout"), "超时");
  assert.equal(presentation.prettyErrorCode("custom_error"), "custom_error");
  assert.equal(presentation.formatBytes(1536), "1.5KB");
  assert.equal(presentation.logLineClass("任务完成"), "is-success");
  assert.equal(presentation.logLineClass("WARN slow"), "is-warn");
  assert.equal(presentation.classifyShotKind("yolo_hard/miss/sample.png"), "漏选/未认出");
  assert.equal(presentation.classifyShotKind("table_page.png"), "题图");
  const first = { task_id: 3, id: 9 };
  const latest = presentation.indexLatestRunsByTask([first, { task_id: 3, id: 8 }]);
  assert.equal(latest.get(3), first);
});

test("run presentation loads before runtime and owns its helpers", () => {
  const html = read("public/index.html");
  const runtime = read("public/panel-runtime.js");
  const shared = html.indexOf("/core/run-presentation.js?v=20260908a");
  const runtimeScript = html.indexOf("/panel-runtime.js?v=20260907a");
  assert.ok(shared >= 0);
  assert.ok(runtimeScript > shared);
  assert.doesNotMatch(runtime, /function prettyErrorCode\(/);
  assert.doesNotMatch(runtime, /function formatBytes\(/);
  assert.doesNotMatch(runtime, /function logLineClass\(/);
  assert.doesNotMatch(runtime, /function classifyShotKind\(/);
  assert.match(runtime, /indexLatestRunsByTask\(runs\)/);
});
