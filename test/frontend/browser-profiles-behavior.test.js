const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { evaluateFunctions, read } = require('./helpers');
const vm = require('node:vm');

const profiles = [
  {
    id: 7,
    name: 'Account <A>',
    user_data_dir: '/profiles/a',
    runtime_stack: 'ruyipage',
    proxy_mode: 'launch',
    proxy_value: 'socks5://127.0.0.1:1080',
    locale: 'en-US',
    timezone_id: 'Asia/Shanghai',
  },
  {
    id: 8,
    name: 'Account B',
    user_data_dir: '',
    runtime_stack: 'playwright',
    proxy_mode: 'direct',
    locale: '',
    timezone_id: '',
  },
];

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function loadManagedEnvironment() {
  const context = vm.createContext({ window: {} });
  vm.runInContext(read('public/features/environment/managed-env.js'), context);
  return context.window.ManagedEnvironment;
}

function createHarness({ responses = [] } = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <select id="browser-profile-select"><option value="7" selected>old</option></select>
    <select id="task-profile-select"><option value="8" selected>old</option></select>
    <select id="task-profile-mode"><option value="temp" selected>temp</option></select>
    <div id="profiles-list"></div>
  </body>`, { url: 'https://panel.test/' });
  const calls = [];
  const order = [];
  const toasts = [];
  const confirmations = [];
  const queue = [...responses];
  let envRows = [];
  const globals = {
    window: dom.window,
    document: dom.window.document,
    FormData: dom.window.FormData,
    browserProfileSelect: dom.window.document.querySelector('#browser-profile-select'),
    taskProfileSelect: dom.window.document.querySelector('#task-profile-select'),
    taskProfileModeSelect: dom.window.document.querySelector('#task-profile-mode'),
    profilesList: dom.window.document.querySelector('#profiles-list'),
    escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    },
    fetchJson: async (url, options) => {
      calls.push([url, options]);
      order.push(`fetch:${url}`);
      const response = queue.shift();
      if (response instanceof Error) throw response;
      return response === undefined ? { data: [] } : response;
    },
    toast(message, type) {
      toasts.push([message, type]);
      order.push(`toast:${message}`);
    },
    dialogConfirm(message, action) {
      confirmations.push(message);
      action();
    },
    updateProxyModeUI(mode, value, field) {
      field.hidden = mode.value !== 'launch';
      value.disabled = mode.value !== 'launch';
    },
    setupPresetCustomControl(select, custom, value) {
      select.value = [...select.options].some((option) => option.value === value) ? value : '__custom__';
      custom.value = select.value === '__custom__' ? value : '';
    },
    getPresetCustomValue(select, custom) {
      return select.value === '__custom__' ? custom.value : select.value;
    },
    createEnvEditor() {
      return {
        setRows(rows) { envRows = rows; },
        addRow() { envRows.push({ name: '', value: '' }); },
        collect() { return envRows; },
      };
    },
    filterManagedEnvRows(rows) { return rows; },
    PROFILE_MANAGED_ENV_KEYS: new Set(),
    LOCALE_PRESETS: [
      ['', 'default'],
      ['en-US', 'English (United States)'],
    ],
    TIMEZONE_PRESETS: [
      ['', 'default'],
      ['Asia/Shanghai', 'Asia/Shanghai'],
    ],
  };
  dom.window.lucide = { createIcons({ root }) { order.push(`icons:${root.id || root.className}`); } };
  globals.window.window = globals.window;
  const context = vm.createContext({
    window: dom.window,
    document: dom.window.document,
    FormData: dom.window.FormData,
  });
  context.window.window = context.window;
  vm.runInContext(read('public/features/browser-resources/controller.js'), context);
  const api = {
    resourceFilesystems: {
      extensions: { api: '/api/extensions-fs', rootLabel: '/home/browser/browser-work/' },
      profiles: { api: '/api/profiles-fs', rootLabel: 'profiles/' },
    },
    listProfiles: () => globals.fetchJson('/api/browser-profiles'),
    loadProfileEnv: (id) => globals.fetchJson(`/api/browser-profiles/${id}/env`),
    createProfile: (body) => globals.fetchJson('/api/browser-profiles', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
    updateProfile: (id, body) => globals.fetchJson(`/api/browser-profiles/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
    saveProfileEnv: (id, body) => globals.fetchJson(`/api/browser-profiles/${id}/env`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
    deleteProfile: (id) => globals.fetchJson(`/api/browser-profiles/${id}`, { method: 'DELETE' }),
  };
  const state = context.window.BrowserResourcesController.createState();
  state.profileStore.replace(profiles.map((profile) => ({ ...profile })));
  const controller = context.window.BrowserResourcesController.create({
    api,
    view: {},
    state,
    elements: {
      browserProfileSelect: globals.browserProfileSelect,
      taskProfileSelect: globals.taskProfileSelect,
      taskProfileModeSelect: globals.taskProfileModeSelect,
      profilesList: globals.profilesList,
    },
    actions: {
      escapeHtml: globals.escapeHtml,
      toast: globals.toast,
      dialogConfirm: globals.dialogConfirm,
      isTaskTempProfileMode: () => globals.taskProfileModeSelect.value !== 'persistent',
      setTaskBrowserProxyInput() {},
      updateProxyModeUI: globals.updateProxyModeUI,
      setupPresetCustomControl: globals.setupPresetCustomControl,
      getPresetCustomValue: globals.getPresetCustomValue,
      createEnvEditor: globals.createEnvEditor,
      filterManagedEnvRows: globals.filterManagedEnvRows,
      PROFILE_MANAGED_ENV_KEYS: globals.PROFILE_MANAGED_ENV_KEYS,
      LOCALE_PRESETS: globals.LOCALE_PRESETS,
      TIMEZONE_PRESETS: globals.TIMEZONE_PRESETS,
    },
  });
  return {
    dom, calls, order, toasts, confirmations, globals,
    ...controller,
    getProfilesCache: () => controller.profileStore.getAll(),
  };
}

test('current runtime renders profile options, active selections, cards, and visible text', () => {
  const harness = createHarness();
  harness.renderProfiles();
  assert.equal(harness.globals.browserProfileSelect.value, '7');
  assert.equal(harness.globals.taskProfileSelect.value, '8');
  assert.match(harness.globals.browserProfileSelect.innerHTML, /Account &lt;A&gt; \[ruyipage\]/);
  assert.match(harness.globals.taskProfileSelect.textContent, /不绑定配置（仅系统默认代理）/);
  assert.match(harness.globals.profilesList.innerHTML, /Account &lt;A&gt;/);
  assert.match(harness.globals.profilesList.textContent, /Firefox/);
  assert.match(harness.globals.profilesList.textContent, /手动代理/);
  assert.match(harness.globals.profilesList.textContent, /Asia\/Shanghai/);
  assert.match(harness.globals.profilesList.innerHTML, /editProfile\(7\)/);
  assert.match(harness.globals.profilesList.innerHTML, /deleteProfile\(7\)/);
});

test('current runtime loads profiles through the exact API and preserves matching selection', async () => {
  const harness = createHarness({ responses: [{ data: profiles }] });
  await harness.loadProfiles();
  assert.deepEqual(harness.calls, [['/api/browser-profiles', undefined]]);
  assert.equal(harness.globals.browserProfileSelect.value, '7');
  assert.equal(harness.globals.taskProfileSelect.value, '8');
  assert.ok(harness.order.indexOf('fetch:/api/browser-profiles') < harness.order.indexOf('icons:profiles-list'));
});

test('current runtime opens create modal and preserves create, env, toast, close, refresh ordering', async () => {
  const harness = createHarness({ responses: [{ data: { id: 11 } }, { data: {} }, { data: profiles }] });
  await harness.openProfileModal(null);
  const dialog = harness.dom.window.document.querySelector('.modal.open');
  assert.match(dialog.textContent, /新建浏览器配置/);
  assert.match(dialog.textContent, /配置级变量/);
  const form = dialog.querySelector('#profile-form');
  form.elements.name.value = 'Created';
  form.elements.user_data_dir.value = '/profiles/created';
  form.elements.runtime_stack.value = 'playwright';
  form.elements.proxy_mode.value = 'launch';
  form.elements.proxy_mode.dispatchEvent(new harness.dom.window.Event('change', { bubbles: true }));
  form.elements.proxy_value.value = 'http://proxy.test:8080';
  form.dispatchEvent(new harness.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  assert.equal(harness.calls[0][0], '/api/browser-profiles');
  assert.equal(harness.calls[0][1].method, 'POST');
  assert.equal(harness.calls[0][1].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(harness.calls[0][1].body), {
    name: 'Created', user_data_dir: '/profiles/created', proxy_mode: 'launch',
    proxy: 'http://proxy.test:8080', proxy_value: 'http://proxy.test:8080',
    runtime_stack: 'playwright', locale: '', timezone_id: '',
  });
  assert.equal(harness.calls[1][0], '/api/browser-profiles/11/env');
  assert.equal(harness.calls[1][1].method, 'PUT');
  assert.equal(harness.calls[1][1].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(harness.calls[1][1].body), { env: [] });
  assert.equal(harness.calls[2][0], '/api/browser-profiles');
  assert.deepEqual(harness.toasts, [['配置已创建', 'success']]);
  assert.equal(harness.dom.window.document.querySelector('.modal.open'), null);
  assert.ok(harness.order.indexOf('toast:配置已创建') < harness.order.lastIndexOf('fetch:/api/browser-profiles'));
});

test('current runtime edit loads env, updates profile and env, then refreshes', async () => {
  const harness = createHarness({ responses: [{ data: [{ name: 'TOKEN', value: 'one' }] }, { data: {} }, { data: {} }, { data: profiles }] });
  harness.editProfile(7);
  await flush();
  const dialog = harness.dom.window.document.querySelector('.modal.open');
  assert.match(dialog.textContent, /编辑配置/);
  assert.equal(dialog.querySelector('[name="name"]').value, 'Account <A>');
  dialog.querySelector('#profile-form').dispatchEvent(new harness.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  assert.equal(harness.calls[0][0], '/api/browser-profiles/7/env');
  assert.equal(harness.calls[1][0], '/api/browser-profiles/7');
  assert.equal(harness.calls[1][1].method, 'PUT');
  assert.equal(harness.calls[2][0], '/api/browser-profiles/7/env');
  assert.deepEqual(JSON.parse(harness.calls[2][1].body), { env: [{ name: 'TOKEN', value: 'one' }] });
  assert.equal(harness.calls[3][0], '/api/browser-profiles');
  assert.deepEqual(harness.toasts, [['配置已更新', 'success']]);
});

test('current runtime tolerates env-load failure and reports save errors without closing', async () => {
  const harness = createHarness({ responses: [new Error('env unavailable'), new Error('save unavailable')] });
  await harness.openProfileModal(profiles[0]);
  const dialog = harness.dom.window.document.querySelector('.modal.open');
  dialog.querySelector('#profile-form').dispatchEvent(new harness.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  assert.deepEqual(harness.toasts, [['save unavailable', 'error']]);
  assert.ok(harness.dom.window.document.querySelector('.modal.open'));
  assert.equal(harness.calls.length, 2);
});

test('current runtime delete confirms exact text, deletes, toasts, then refreshes', async () => {
  const harness = createHarness({ responses: [{ data: {} }, { data: profiles }] });
  harness.deleteProfile(7);
  await flush();
  assert.deepEqual(harness.confirmations, ['确定要删除配置「Account <A>」吗？']);
  assert.equal(harness.calls[0][0], '/api/browser-profiles/7');
  assert.equal(harness.calls[0][1].method, 'DELETE');
  assert.equal(harness.calls[1][0], '/api/browser-profiles');
  assert.deepEqual(harness.toasts, [['配置已删除', 'success']]);
  assert.ok(harness.order.indexOf('toast:配置已删除') < harness.order.lastIndexOf('fetch:/api/browser-profiles'));
});

test('current runtime delete reports API errors without refreshing', async () => {
  const harness = createHarness({ responses: [new Error('delete unavailable')] });
  harness.deleteProfile(8);
  await flush();
  assert.deepEqual(harness.toasts, [['delete unavailable', 'error']]);
  assert.equal(harness.calls.length, 1);
});

test('current runtime has one profile implementation and one add-profile binding owner', () => {
  const runtime = read('public/panel-runtime.js');
  const controller = read('public/features/browser-resources/controller.js');
  for (const pattern of [
    /function renderProfileOptions\s*\(/g,
    /function renderProfiles\s*\(/g,
    /async function loadProfiles\s*\(/g,
    /function openProfileModal\s*\(/g,
  ]) {
    assert.equal((runtime.match(pattern) || []).length, 0);
    assert.equal((controller.match(pattern) || []).length, 1);
  }
  assert.equal((runtime.match(/addProfileBtn\.addEventListener\('click'/g) || []).length, 0);
  assert.equal((controller.match(/on\(elements\.addProfileBtn, 'click'/g) || []).length, 1);
});

function taskView() {
  const context = vm.createContext({ window: {} });
  context.window = context;
  vm.runInContext(read('public/features/tasks/view.js'), context);
  return context.TasksView;
}

function taskCardDeps(profileRows = profiles) {
  return {
    taskIsRunning: () => false,
    latestRunSummary: () => ({}),
    profileStore: {
      find(id) {
        return profileRows.find((profile) => String(profile.id) === String(id));
      },
    },
    describeConditionValueFull: () => '',
    describeCondition: () => '',
    conditionStatusClass: () => '',
    describeConditionValue: () => '',
    describeNextRun: () => '',
    selectedBackupTaskIds: new Set(),
    backupSelectionMode: false,
    escapeHtml: (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]),
  };
}

test('legacy task cards resolve bound profiles and preserve missing/default fallbacks', () => {
  const view = taskView();
  const bound = view.taskCard({ id: 1, name: 'Bound', type: 'js', use_persistent: 1, browser_profile_id: 7 }, '', taskCardDeps());
  const missing = view.taskCard({ id: 2, name: 'Missing', type: 'js', use_persistent: 0, browser_profile_id: 99 }, '', taskCardDeps());
  const persistentDefault = view.taskCard({ id: 3, name: 'Default', type: 'js', use_persistent: 1, browser_profile_id: null }, '', taskCardDeps());
  const temporaryDefault = view.taskCard({ id: 4, name: 'Fresh', type: 'js', use_persistent: 0, browser_profile_id: null }, '', taskCardDeps());
  assert.match(bound, /持久 · Account &lt;A&gt;/);
  assert.match(bound, /持久浏览器配置 · Account &lt;A&gt;/);
  assert.match(missing, /临时 · #99/);
  assert.match(persistentDefault, /持久 · 默认配置/);
  assert.match(temporaryDefault, /临时 · 每次全新/);
});

test('legacy profile selectors preserve active selection, labels, escaping, and missing fallback', () => {
  const harness = createHarness();
  harness.renderProfileOptions(harness.globals.browserProfileSelect, 7);
  assert.equal(harness.globals.browserProfileSelect.value, '7');
  assert.equal(harness.globals.browserProfileSelect.options[0].textContent, '默认配置');
  assert.equal(harness.globals.browserProfileSelect.options[1].textContent, 'Account <A> [ruyipage]');
  harness.renderProfileOptions(harness.globals.taskProfileSelect, 8);
  assert.equal(harness.globals.taskProfileSelect.value, '8');
  assert.equal(harness.globals.taskProfileSelect.options[0].textContent, '不绑定配置（仅系统默认代理）');
  harness.renderProfileOptions(harness.globals.taskProfileSelect, 404);
  assert.equal(harness.globals.taskProfileSelect.value, '');
});

test('legacy profile refresh updates shared task selectors after state replacement', async () => {
  const refreshed = [{ id: 12, name: 'New', runtime_stack: 'playwright' }];
  const harness = createHarness({ responses: [{ data: refreshed }] });
  await harness.loadProfiles();
  assert.deepEqual(harness.getProfilesCache(), refreshed);
  assert.equal(harness.globals.browserProfileSelect.options[1].value, '12');
  assert.equal(harness.globals.taskProfileSelect.options[1].value, '12');
  assert.equal(harness.order[0], 'fetch:/api/browser-profiles');
});

test('legacy task edit restores profile mode and selected profile with missing-profile fallback', () => {
  const selections = [];
  const modeSelect = { value: '' };
  const browserProfileInput = { value: '' };
  const form = {
    name: {}, type: {}, script_path: {}, timeout_sec: {},
    elements: { enabled: {}, browser_profile_id: browserProfileInput },
  };
  const globals = {
    form,
    TasksModel: {
      parseParamsJson(raw) {
        if (!raw) return {};
        if (typeof raw === 'object' && !Array.isArray(raw)) return { ...raw };
        try {
          const parsed = JSON.parse(String(raw));
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch {
          return {};
        }
      },
      resolveTaskType: (_path, type) => type,
    },
    window: {},
    isHost2PlayScript: () => false,
    parseTaskSchedule: () => ({
      enabled: true, mode: '', fixedDays: '', fixedHours: '', fixedMinutes: '',
      intervalMin: '', intervalMax: '', intervalUnit: '', dailyTimeStart: '',
      dailyTimeEnd: '', dailyDayMin: '', dailyDayMax: '',
    }),
    scheduleModeSelect: {}, fixedDaysEl: {}, fixedHoursEl: {}, fixedMinutesEl: {},
    intervalMinEl: {}, intervalMaxEl: {}, intervalUnitEl: {},
    dailyTimeStartEl: null, dailyTimeEndEl: null, dailyDayMinEl: null, dailyDayMaxEl: null,
    updateScheduleModeUI() {}, fillConditionForm() {},
    taskProfileModeSelect: modeSelect,
    updateTaskProfileModeUI() {},
    taskProfileSelect: {},
    browserResourcesController: { renderProfileOptions(_select, selected) { selections.push(selected); } },
    renderTaskGroupOptions() {},
    document: { getElementById: () => null },
    setTaskBrowserProxyInput() {},
    taskParamsBlock: null,
    filterManagedEnvRows: () => [],
    findManagedParamValue: loadManagedEnvironment().findManagedParamValue,
    taskEnvEditor: { setRows() {} },
  };
  globals.window.TasksModel = globals.TasksModel;
  const { fillTaskForm } = evaluateFunctions([
    'parseParamsJson',
    'syncTaskParamsUI',
    'setTaskProfileMode',
    'fillTaskForm',
  ], globals);

  fillTaskForm({
    name: 'Persistent', type: 'js', script_path: '/task.js', timeout_sec: 30,
    use_persistent: '1', browser_profile_id: 8, env: [], group_id: null,
  });
  assert.equal(modeSelect.value, 'persistent');
  assert.equal(selections.at(-1), 8);
  assert.equal(browserProfileInput.value, 8);

  fillTaskForm({
    name: 'Missing', type: 'js', script_path: '/task.js', timeout_sec: 30,
    use_persistent: undefined, browser_profile_id: null, env: [], group_id: null,
  });
  assert.equal(modeSelect.value, 'temp');
  assert.equal(selections.at(-1), '');
  assert.equal(browserProfileInput.value, '');
});

test('legacy binding ownership covers task profile mode, selection, proxy copy, and add profile once', () => {
  const runtime = read('public/panel-runtime.js');
  const controller = read('public/features/browser-resources/controller.js');
  for (const pattern of [
    /taskProfileModeSelect\.addEventListener\('change'/g,
    /taskProfileSelect\.addEventListener\('change'/g,
    /taskProxyFromProfileBtn\.addEventListener\('click'/g,
  ]) assert.equal((runtime.match(pattern) || []).length, 1);
  assert.equal((controller.match(/on\(elements\.addProfileBtn, 'click'/g) || []).length, 1);
});
