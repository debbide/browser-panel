const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { read } = require('./helpers');

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createHarness({ responses = [], prompts = [] } = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <button id="fs-btn-up"></button><button id="fs-btn-refresh"></button>
    <button id="fs-btn-new-file"></button><button id="fs-btn-new-folder"></button>
    <button id="fs-btn-upload"></button><button id="fs-btn-upload-folder"></button>
    <input id="fs-upload-input" type="file"><input id="fs-upload-folder-input" type="file">
    <div id="fs-breadcrumb"></div><div id="fs-list"></div>
  </body>`, { url: 'https://panel.test/' });
  const calls = [];
  const toasts = [];
  const confirmations = [];
  const opened = [];
  let scriptLoads = 0;
  let promptIndex = 0;
  let responseIndex = 0;
  const fetchJson = async (path, options) => {
    calls.push([path, options && JSON.parse(JSON.stringify(options))]);
    const response = responses[responseIndex++];
    if (response instanceof Error) throw response;
    return response || { data: { entries: [] } };
  };
  const globals = {
    document: dom.window.document,
    window: dom.window,
    fetchJson,
    escapeHtml: (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    formatFsMtime: (value) => value ? `time:${value}` : '-',
    formatBytes: (value) => `${value} B`,
    pathBasename: (value) => String(value).split('/').pop(),
    promptFsName: async () => prompts[promptIndex++] ?? null,
    toast: (message, type) => toasts.push([message, type]),
    dialogConfirm: (message, action) => { confirmations.push(message); return action(); },
    loadScripts: async () => { scriptLoads += 1; },
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    Uint8Array,
    String,
    Error,
    JSON,
    encodeURIComponent,
    setTimeout: (callback) => callback(),
  };
  dom.window.open = (...args) => opened.push(args);
  dom.window.lucide = { createIcons() {} };
  Object.assign(dom.window, {
    fetchJson,
    escapeHtml: globals.escapeHtml,
    toast: globals.toast,
    dialogConfirm: globals.dialogConfirm,
    loadScripts: globals.loadScripts,
    pathBasename: globals.pathBasename,
    promptFsName: globals.promptFsName,
    btoa: globals.btoa,
  });
  const context = vm.createContext(globals);
  context.window.FileBrowserApi = {};
  context.window.FileBrowserView = {
    formatMtime: globals.formatFsMtime,
    formatBytes: globals.formatBytes,
    promptFsName: globals.promptFsName,
  };
  vm.runInContext(read('public/features/file-browser/controller.js'), context);
  const controller = context.window.FileBrowserController.create({
    api: context.window.FileBrowserApi,
    view: context.window.FileBrowserView,
    actions: {
      toast: globals.toast,
      dialogConfirm: globals.dialogConfirm,
      loadScripts: globals.loadScripts,
      pathBasename: globals.pathBasename,
    },
  });
  const subject = {
    loadTasksFs: controller.load,
    openTasksFileEditor: controller.openFileEditor,
    wireTasksFsUi: controller.mount,
    currentPath: controller.currentPath,
  };
  return { ...subject, dom, calls, toasts, confirmations, opened, scriptLoads: () => scriptLoads };
}

test('file browser renders entries, navigates directories, and preserves non-selection behavior', async () => {
  const harness = createHarness({ responses: [
    { data: { entries: [
      { type: 'dir', name: 'nested', path: 'root/nested', mtime: 'd' },
      { type: 'file', name: '<script>.js', path: 'root/<script>.js', size: 7, mtime: 'f', text: true },
    ] } },
    { data: { entries: [] } },
  ] });
  await harness.loadTasksFs('/root/');
  const document = harness.dom.window.document;
  assert.equal(harness.currentPath(), 'root');
  assert.equal(document.querySelector('#fs-breadcrumb').textContent, 'tasks/root/');
  assert.deepEqual([...document.querySelectorAll('.files-row-head div')].map((node) => node.textContent.trim()), ['名称', '大小', '修改时间', '']);
  assert.equal(document.querySelector('.files-row.is-dir .files-meta').textContent, '文件夹');
  assert.equal(document.querySelectorAll('.files-row:not(.files-row-head).selected').length, 0);
  assert.equal(document.querySelectorAll('.files-row:not(.files-row-head)')[1].querySelector('.files-name').innerHTML, '&lt;script&gt;.js');
  document.querySelector('.files-row.is-dir').dispatchEvent(new harness.dom.window.MouseEvent('click', { bubbles: true }));
  await flush();
  assert.equal(harness.currentPath(), 'root/nested');
  assert.equal(document.querySelector('#fs-list').textContent, '空目录');
});

test('file browser create actions preserve payloads, refresh order, modal handoff, and errors', async () => {
  const harness = createHarness({
    prompts: ['folder', 'script.js', 'broken'],
    responses: [
      { data: { entries: [] } },
      {}, { data: { entries: [] } },
      { data: { path: 'work/script.js' } }, { data: { entries: [] } }, { data: { content: '' } },
      new Error('create denied'),
    ],
  });
  await harness.loadTasksFs('work');
  harness.wireTasksFsUi();
  const document = harness.dom.window.document;
  document.querySelector('#fs-btn-new-folder').click();
  await flush();
  document.querySelector('#fs-btn-new-file').click();
  await flush(); await flush();
  document.querySelector('#fs-btn-new-folder').click();
  await flush();
  assert.deepEqual(harness.calls.slice(1, 3), [
    ['/api/tasks-fs/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent: 'work', name: 'folder' }) }],
    ['/api/tasks-fs?path=work', undefined],
  ]);
  assert.equal(document.querySelectorAll('.files-editor-dialog').length, 1);
  assert.equal(harness.scriptLoads(), 1);
  assert.ok(harness.toasts.some(([message, type]) => message === 'create denied' && type === 'error'));
});

test('file browser delete preserves confirmation, payload, refresh timing, and failure handling', async () => {
  const harness = createHarness({ responses: [
    { data: { entries: [{ type: 'file', name: 'a.js', path: 'dir/a.js', size: 1, text: false }] } },
    {}, { data: { entries: [] } },
  ] });
  await harness.loadTasksFs('dir');
  harness.dom.window.document.querySelector('.danger').click();
  await flush();
  assert.deepEqual(harness.confirmations, ['确定删除「a.js」？']);
  assert.deepEqual(harness.calls[1], ['/api/tasks-fs', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'dir/a.js' }) }]);
  assert.equal(harness.calls[2][0], '/api/tasks-fs?path=dir');
  assert.equal(harness.scriptLoads(), 1);
  assert.ok(harness.toasts.some(([message, type]) => message === '已删除' && type === 'success'));
});

test('file editor preserves DOM, save payload, modal dismissal, and read errors', async () => {
  const harness = createHarness({ responses: [
    { data: { name: 'a.js', content: 'old' } }, {}, { data: { entries: [] } }, new Error('read denied'),
  ] });
  harness.openTasksFileEditor('dir/a.js');
  await flush();
  const document = harness.dom.window.document;
  const area = document.querySelector('.files-editor-area');
  assert.equal(area.value, 'old');
  area.value = 'new';
  document.querySelector('.fs-ed-save').click();
  await flush();
  assert.deepEqual(harness.calls[1], ['/api/tasks-fs/write', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'dir/a.js', content: 'new' }) }]);
  assert.equal(document.querySelector('.files-editor-dialog'), null);
  harness.openTasksFileEditor('denied.js');
  await flush();
  assert.ok(harness.toasts.some(([message, type]) => message === 'read denied' && type === 'error'));
});

test('file browser upload preserves progress text, filtering, payloads, refresh timing, and one-time bindings', async () => {
  const harness = createHarness({ responses: [{ data: { entries: [] } }, {}, {}, { data: { entries: [] } }] });
  await harness.loadTasksFs('target');
  const document = harness.dom.window.document;
  const counts = new Map();
  for (const id of ['fs-btn-up', 'fs-btn-refresh', 'fs-btn-new-file', 'fs-btn-new-folder', 'fs-btn-upload', 'fs-upload-input', 'fs-btn-upload-folder', 'fs-upload-folder-input']) {
    const element = document.getElementById(id);
    const original = element.addEventListener.bind(element);
    element.addEventListener = (type, handler, options) => { counts.set(`${id}:${type}`, (counts.get(`${id}:${type}`) || 0) + 1); original(type, handler, options); };
  }
  harness.wireTasksFsUi();
  assert.ok([...counts.values()].every((count) => count === 1));
  const input = document.querySelector('#fs-upload-folder-input');
  const files = [
    { name: 'a.js', webkitRelativePath: 'pack/a.js', arrayBuffer: async () => Uint8Array.from([97]).buffer },
    { name: 'x.pyc', webkitRelativePath: 'pack/__pycache__/x.pyc', arrayBuffer: async () => Uint8Array.from([120]).buffer },
    { name: 'b.js', webkitRelativePath: 'pack/b.js', arrayBuffer: async () => Uint8Array.from([98]).buffer },
  ];
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  input.dispatchEvent(new harness.dom.window.Event('change'));
  await flush(); await flush();
  const uploads = harness.calls.filter(([path]) => path === '/api/tasks-fs/upload');
  assert.equal(uploads.length, 2);
  assert.deepEqual(JSON.parse(uploads[0][1].body), { parent: 'target', name: 'a.js', relativePath: 'pack/a.js', encoding: 'base64', content: 'YQ==' });
  assert.ok(harness.toasts.some(([message, type]) => message === '开始上传 3 个文件…' && type === 'info'));
  assert.ok(harness.toasts.some(([message, type]) => message === '文件夹上传完成：2 个文件，跳过 1' && type === 'success'));
  assert.equal(harness.calls.at(-1)[0], '/api/tasks-fs?path=target');
  assert.equal(harness.scriptLoads(), 1);
});

test('filesystem prompt resolves trimmed values through buttons, keyboard, and dismissal', async () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const context = vm.createContext({ window: dom.window, document: dom.window.document, setTimeout: (callback) => callback(), Date });
  context.window.window = context.window;
  context.window.escapeHtml = (value) => String(value);
  vm.runInContext(read('public/core/fs-presentation.js'), context);
  const promise = context.window.FsPresentation.promptFsName('Title', 'name');
  const input = dom.window.document.querySelector('.fs-nm-input');
  input.value = '  chosen  ';
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(await promise, 'chosen');
  const cancelled = context.window.FsPresentation.promptFsName('Title', 'name');
  dom.window.document.querySelector('.modal-mask').click();
  assert.equal(await cancelled, null);
});
