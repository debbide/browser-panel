const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { read } = require('./helpers');

function loadModule(path, name) {
  const context = vm.createContext({ window: {} });
  context.window.window = context.window;
  vm.runInContext(read(path), context);
  return context.window[name];
}

test('file browser view exposes stable formatting and rendering boundaries', () => {
  const view = loadModule('public/features/file-browser/view.js', 'FileBrowserView');
  assert.equal(view.formatBytes(0), '0 B');
  assert.equal(view.formatBytes(1536), '1.5 KB');
  assert.equal(view.formatMtime(''), '—');
  assert.equal(typeof view.renderBreadcrumb, 'function');
  assert.equal(typeof view.renderEntries, 'function');
});

test('file browser controller exposes idempotent lifecycle and navigation', () => {
  const controller = loadModule('public/features/file-browser/controller.js', 'FileBrowserController');
  const instance = controller.create({ api: {}, view: {} });
  assert.equal(typeof instance.mount, 'function');
  assert.equal(typeof instance.unmount, 'function');
  assert.equal(typeof instance.load, 'function');
  assert.equal(typeof instance.currentPath, 'function');
});

test('production page loads file browser modules before app', () => {
  const html = read('public/index.html');
  const api = html.indexOf('/features/file-browser/api.js?v=20260907a');
  const view = html.indexOf('/features/file-browser/view.js?v=20260907a');
  const controller = html.indexOf('/features/file-browser/controller.js?v=20260907a');
  const app = html.indexOf('/app.js?v=20260814c');
  assert.ok(api >= 0);
  assert.ok(view > api);
  assert.ok(controller > view);
  assert.ok(app > controller);
});

test('application entry delegates file browser startup', () => {
  const source = read('public/panel-runtime.js');
  assert.match(source, /FileBrowserController\.create\(/);
  assert.match(source, /fileBrowserController\.mount\(\)/);
  assert.match(source, /fileBrowserController\.load\(/);
});

test('file browser freezes DOM, visible text, modal, selection, and binding contracts before extraction', () => {
  const html = read('public/index.html');
  const runtime = read('public/panel-runtime.js');
  for (const id of [
    'scripts-tab', 'fs-btn-up', 'fs-btn-refresh', 'fs-btn-new-file',
    'fs-btn-new-folder', 'fs-btn-upload', 'fs-btn-upload-folder',
    'fs-upload-input', 'fs-upload-folder-input', 'fs-breadcrumb', 'fs-list',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  for (const text of ['加载中…', '空目录', '名称', '大小', '修改时间', '编辑', '下载', '删除', '已删除', '删除失败']) {
    assert.match(runtime, new RegExp(text));
  }
  assert.match(runtime, /let fsCurrentPath = ''/);
  assert.match(runtime, /fsCurrentPath = String\(dir \|\| ''\)\.replace/);
  assert.match(runtime, /files-editor-dialog/);
  assert.match(runtime, /fs-ed-save/);
  assert.match(runtime, /fs-nm-ok/);
  assert.match(runtime, /dialogConfirm\(`确定删除「\$\{ent\.name\}」？`/);
  assert.equal((runtime.match(/function wireTasksFsUi\(/g) || []).length, 1);
});

test('file browser freezes API refresh and static loading order contracts before extraction', () => {
  const runtime = read('public/panel-runtime.js');
  const html = read('public/index.html');
  assert.match(runtime, /await loadTasksFs\(fsCurrentPath\);[\s\S]*await loadScripts\(\)/);
  assert.match(runtime, /window\.open\(`\/api\/tasks-fs\/download\?path=\$\{encodeURIComponent\(ent\.path\)\}`/);
  const paths = [
    '/features/file-browser/api.js?v=20260907a',
    '/features/file-browser/view.js?v=20260907a',
    '/features/file-browser/controller.js?v=20260907a',
    '/panel-runtime.js?v=20260907a',
    '/app.js?v=20260814c',
  ];
  const positions = paths.map((path) => html.indexOf(path));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
});
