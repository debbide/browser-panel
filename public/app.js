// 会话失效时统一跳登录页。用一个标记挡住并发请求 —— 面板启动时会同时打十几个
// 接口，401 一起回来的话会连着 replace 十几次，浏览器历史被塞满。
let redirectingToLogin = false;

function goLogin() {
  if (redirectingToLogin) return;
  redirectingToLogin = true;
  const next = location.pathname + location.search;
  const suffix = next && next !== '/' ? `?next=${encodeURIComponent(next)}` : '';
  location.replace(`/login.html${suffix}`);
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  // 401 一律跳登录页。这里必须在 content-type 检查之前拦 —— 服务端给 /api/* 回的是
  // JSON，但真要漏到下面就会被当成普通业务错误弹 toast，用户看不出是掉登录了。
  if (res.status === 401) {
    goLogin();
    throw new Error('会话已失效，正在跳转登录页');
  }
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await res.text();
    const looksLikeHtml = /^\s*<!doctype html/i.test(text) || /^\s*<html/i.test(text);
    if (looksLikeHtml) {
      throw new Error(`接口 ${url} 返回了页面内容，后端路由可能异常`);
    }
    throw new Error(`接口 ${url} 返回了非 JSON 响应`);
  }

  const data = await res.json();
  if (!res.ok) {
    const message = String(data.message || '请求失败');
    const output = data.output ? `\n${String(data.output).slice(-1200)}` : '';
    throw new Error(`${message}${output}`);
  }
  return data;
}

window.toast = function(msg, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  let icon = 'info';
  if (type === 'success') icon = 'check-circle';
  if (type === 'error') icon = 'alert-triangle';
  if (type === 'warn') icon = 'alert-circle';
  
  el.innerHTML = `<i data-lucide="${icon}" class="icon-sm"></i> <span>${escapeHtml(msg)}</span>`;
  container.appendChild(el);
  if (window.lucide) window.lucide.createIcons({ root: el });

  setTimeout(() => {
    el.classList.add('toast-fade-out');
    el.addEventListener('animationend', () => el.remove());
  }, 4000);
};

window.dialogConfirm = function(msg, onConfirm) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask open';
  mask.style.zIndex = '9999';
  
  const dialog = document.createElement('div');
  dialog.className = 'modal open';
  dialog.style.alignItems = 'center';
  dialog.style.justifyContent = 'center';
  dialog.style.zIndex = '10000';
  dialog.innerHTML = `
    <div class="modal-panel" style="max-width: 320px; width: 100%; text-align: center; padding: 24px;">
      <div style="color: var(--accent-color); margin-bottom: 16px;"><i data-lucide="help-circle" style="width: 48px; height: 48px;"></i></div>
      <h3 style="margin-bottom: 8px;">操作确认</h3>
      <p class="muted" style="margin-bottom: 24px;">${escapeHtml(msg)}</p>
      <div class="row" style="justify-content: center;">
        <button id="cd-cancel" class="alt">取消</button>
        <button id="cd-confirm" style="background: #ef4444; box-shadow: 0 4px 12px rgba(239, 68, 68, 0.2);">确定</button>
      </div>
    </div>
  `;
  document.body.appendChild(mask);
  document.body.appendChild(dialog);
  if (window.lucide) window.lucide.createIcons({ root: dialog });

  const close = () => { mask.remove(); dialog.remove(); };
  dialog.querySelector('#cd-cancel').addEventListener('click', close);
  dialog.querySelector('#cd-confirm').addEventListener('click', () => { close(); onConfirm(); });
};

function dialogPassphrase(msg, onConfirm, allowEmpty = false) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask open';
  mask.style.zIndex = '9999';

  const dialog = document.createElement('div');
  dialog.className = 'modal open';
  dialog.style.alignItems = 'center';
  dialog.style.justifyContent = 'center';
  dialog.style.zIndex = '10000';
  dialog.innerHTML = `
    <div class="modal-panel" style="max-width: 360px; width: 100%; padding: 24px;">
      <h3 style="margin-bottom: 8px;">设置密码</h3>
      <p class="muted" style="margin-bottom: 16px;">${escapeHtml(msg)}</p>
      <label style="display:block; margin-bottom:4px; font-size:0.85em; font-weight:600;">密码</label>
      <input id="bp-pp-input" type="password" autocomplete="off" placeholder="输入密码" style="width:100%; box-sizing:border-box; margin-bottom:8px;" />
      <label style="display:block; margin-bottom:4px; font-size:0.85em; font-weight:600;">确认密码</label>
      <input id="bp-pp-confirm" type="password" autocomplete="off" placeholder="再次输入" style="width:100%; box-sizing:border-box; margin-bottom:18px;" />
      <p id="bp-pp-error" class="muted" style="color:#ef4444; margin-bottom:12px; display:none;"></p>
      <div class="row" style="justify-content: flex-end;">
        <button id="bp-pp-cancel" class="alt">取消</button>
        <button id="bp-pp-confirm-btn">确定</button>
      </div>
    </div>
  `;
  document.body.appendChild(mask);
  document.body.appendChild(dialog);
  if (window.lucide) window.lucide.createIcons({ root: dialog });

  const input = dialog.querySelector('#bp-pp-input');
  const confirm = dialog.querySelector('#bp-pp-confirm');
  const error = dialog.querySelector('#bp-pp-error');
  const close = () => { mask.remove(); dialog.remove(); };

  const validate = () => {
    const pw = input.value;
    const pw2 = confirm.value;
    if (!allowEmpty && !pw.trim()) return '密码不能为空';
    if (!allowEmpty && pw.length < 8) return '密码至少需要 8 个字符';
    if (pw !== pw2) return '两次输入的密码不一致';
    return null;
  };

  dialog.querySelector('#bp-pp-cancel').addEventListener('click', close);
  dialog.querySelector('#bp-pp-confirm-btn').addEventListener('click', () => {
    const err = validate();
    if (err) { error.textContent = err; error.style.display = 'block'; return; }
    close();
    onConfirm(input.value || null);
  });

  // Enter in either field submits
  const submit = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const err = validate();
      if (err) { error.textContent = err; error.style.display = 'block'; return; }
      close();
      onConfirm(input.value || null);
    }
  };
  input.addEventListener('keydown', submit);
  confirm.addEventListener('keydown', submit);
  // Focus first input
  setTimeout(() => input.focus(), 100);
}

window.dialogPassphrase = dialogPassphrase;

/** 导入用：只问一次密码，不需要确认输入（错了会被解密直接顶回来）。 */
function dialogPassphraseOnce(msg, onConfirm) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask open';
  mask.style.zIndex = '9999';

  const dialog = document.createElement('div');
  dialog.className = 'modal open';
  dialog.style.alignItems = 'center';
  dialog.style.justifyContent = 'center';
  dialog.style.zIndex = '10000';
  dialog.innerHTML = `
    <div class="modal-panel" style="max-width: 360px; width: 100%; padding: 24px;">
      <h3 style="margin-bottom: 8px;">输入密码</h3>
      <p class="muted" style="margin-bottom: 16px;">${escapeHtml(msg)}</p>
      <input id="bp-pp1-input" type="password" autocomplete="off" placeholder="导出时设置的密码" style="width:100%; box-sizing:border-box; margin-bottom:18px;" />
      <p id="bp-pp1-error" class="muted" style="color:#ef4444; margin-bottom:12px; display:none;"></p>
      <div class="row" style="justify-content: flex-end;">
        <button id="bp-pp1-cancel" class="alt">取消</button>
        <button id="bp-pp1-ok">确定</button>
      </div>
    </div>
  `;
  document.body.appendChild(mask);
  document.body.appendChild(dialog);

  const input = dialog.querySelector('#bp-pp1-input');
  const error = dialog.querySelector('#bp-pp1-error');
  const close = () => { mask.remove(); dialog.remove(); };
  const go = () => {
    if (!input.value) { error.textContent = '密码不能为空'; error.style.display = 'block'; return; }
    close();
    onConfirm(input.value);
  };
  dialog.querySelector('#bp-pp1-cancel').addEventListener('click', close);
  dialog.querySelector('#bp-pp1-ok').addEventListener('click', go);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  setTimeout(() => input.focus(), 100);
}

const LOCALE_PRESETS = ['zh-CN', 'zh-TW', 'en-US', 'en-GB', 'ja-JP', 'ko-KR'];
const TIMEZONE_PRESETS = [
  'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Tokyo', 'Asia/Seoul',
  'UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin',
];

function setupPresetCustomControl(selectEl, inputEl, value = '', onChange) {
  if (!selectEl || !inputEl) return;
  const raw = String(value || '').trim();
  const known = Array.from(selectEl.options).some((option) => option.value === raw);
  selectEl.value = raw && known ? raw : (raw ? '__custom__' : '');
  inputEl.value = raw && !known ? raw : '';
  inputEl.hidden = selectEl.value !== '__custom__';
  inputEl.disabled = selectEl.value !== '__custom__';
  if (onChange !== undefined) selectEl._presetCustomOnChange = onChange;
  if (!selectEl.dataset.presetCustomBound) {
    selectEl.addEventListener('change', () => {
      const custom = selectEl.value === '__custom__';
      inputEl.hidden = !custom;
      inputEl.disabled = !custom;
      if (!custom) inputEl.value = '';
      if (typeof selectEl._presetCustomOnChange === 'function') {
        selectEl._presetCustomOnChange();
      }
    });
    inputEl.addEventListener('input', () => {
      if (typeof selectEl._presetCustomOnChange === 'function') {
        selectEl._presetCustomOnChange();
      }
    });
    selectEl.dataset.presetCustomBound = '1';
  }
}

function getPresetCustomValue(selectEl, inputEl) {
  if (!selectEl) return '';
  return selectEl.value === '__custom__'
    ? String(inputEl?.value || '').trim()
    : String(selectEl.value || '').trim();
}

const PROXY_ENV_ALIAS_KEYS = [
  'PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
];

const MANAGED_TASK_ENV_KEYS = new Set([
  'USE_GLOBAL_TELEGRAM',
  'USE_TEMP_PROFILE',
  'BROWSER_PROXY',
  'BROWSER_RUNTIME_STACK',
  'BROWSER_PROXY_MODE',
  'BROWSER_PROXY_VALUE',
  'BROWSER_RUYI_FPFILE',
  ...PROXY_ENV_ALIAS_KEYS,
  'BROWSER_LOCALE',
  'BROWSER_TIMEZONE',
]);
const PROFILE_MANAGED_ENV_KEYS = new Set(['BROWSER_LOCALE', 'BROWSER_TIMEZONE']);

function isManagedEnvKey(name, keys = MANAGED_TASK_ENV_KEYS) {
  return keys.has(String(name || '').trim().toUpperCase());
}

function filterManagedEnvRows(rows, keys = MANAGED_TASK_ENV_KEYS) {
  return (Array.isArray(rows) ? rows : []).filter((entry) => !isManagedEnvKey(entry?.name, keys));
}

function filterManagedEnvObject(source, keys = MANAGED_TASK_ENV_KEYS) {
  const out = {};
  for (const [name, value] of Object.entries(source || {})) {
    if (!isManagedEnvKey(name, keys)) out[name] = value;
  }
  return out;
}

function findManagedEnvValue(rows, name) {
  const target = String(name || '').toUpperCase();
  const hit = (Array.isArray(rows) ? rows : []).find(
    (entry) => String(entry?.name || '').trim().toUpperCase() === target
  );
  return hit ? String(hit.value || '').trim() : '';
}

function findManagedParamValue(params, name) {
  const target = String(name || '').toUpperCase();
  for (const [key, value] of Object.entries(params || {})) {
    if (String(key || '').trim().toUpperCase() === target) return String(value || '').trim();
  }
  return '';
}

function deleteManagedMapKeys(map, names) {
  const targets = new Set(names.map((name) => String(name).toUpperCase()));
  for (const key of [...map.keys()]) {
    if (targets.has(String(key || '').toUpperCase())) map.delete(key);
  }
}

function deleteManagedObjectKeys(object, names) {
  const targets = new Set(names.map((name) => String(name).toUpperCase()));
  for (const key of Object.keys(object || {})) {
    if (targets.has(String(key || '').toUpperCase())) delete object[key];
  }
}

const tasksEl = document.getElementById('tasks');
const form = document.getElementById('task-form');
const modalImportForm = document.getElementById('modal-import-form');
const modal = document.getElementById('task-modal');
const modalMask = document.getElementById('modal-mask');
const modalTitle = document.getElementById('modal-title');
const modalCloseBtn = document.getElementById('modal-close-btn');
const formTitle = document.getElementById('form-title');
const formHint = document.getElementById('form-hint');
const saveBtn = document.getElementById('save-btn');
const resetBtn = document.getElementById('reset-btn');
const modalImportBtn = document.getElementById('modal-import-btn');
const refreshScriptsModalBtn = document.getElementById('refresh-scripts-modal-btn');
const addTaskBtn = document.getElementById('add-task-btn');
const backupSelectBtn = document.getElementById('backup-select-btn');
const backupImportBtn = document.getElementById('backup-import-btn');
const backupFileInput = document.getElementById('backup-file-input');
const backupSelectionBar = document.getElementById('backup-selection-bar');
const backupSelectAll = document.getElementById('backup-select-all');
const backupSelectionCount = document.getElementById('backup-selection-count');
const backupIncludeSecrets = document.getElementById('backup-include-secrets');
const backupExportBtn = document.getElementById('backup-export-btn');
const backupSelectCancelBtn = document.getElementById('backup-select-cancel-btn');
const backupImportModal = document.getElementById('backup-import-modal');
const backupImportMask = document.getElementById('backup-import-mask');
const openBrowserBtn = document.getElementById('open-browser-btn');
const browserProfileSelect = document.getElementById('browser-profile-select');
const taskProfileSelect = document.getElementById('task-profile-select');
const taskProfileModeSelect = document.getElementById('task-profile-mode');
const taskProfileModeHint = document.getElementById('task-profile-mode-hint');
const taskProfilePersistentFields = document.getElementById('task-profile-persistent-fields');
const taskUsePersistentInput = document.getElementById('task-use-persistent');
const taskBrowserType = document.getElementById('task-browser-type');
const taskProxyMode = document.getElementById('task-proxy-mode');
const taskProxyInput = document.getElementById('task-proxy-input');
const taskProxyValueField = document.getElementById('task-proxy-value-field');
const taskProxyFromProfileBtn = document.getElementById('task-proxy-from-profile');
const taskProxyHint = document.getElementById('task-proxy-hint');
const addProfileBtn = document.getElementById('add-profile-btn');
const profilesList = document.getElementById('profiles-list');
let profilesCache = [];
const closeBrowserBtn = document.getElementById('close-browser-btn');
const scriptSelectEl = document.getElementById('script-select');
const useScriptBtn = document.getElementById('use-script-btn');
const editScriptBtn = document.getElementById('edit-script-btn');

const scheduleModeSelect = document.getElementById('schedule-mode-select');
const fixedFieldsEl = document.getElementById('fixed-schedule-fields');
const intervalFieldsEl = document.getElementById('interval-schedule-fields');
const dailyWindowFieldsEl = document.getElementById('daily-window-schedule-fields');
const fixedSummaryEl = document.getElementById('fixed-schedule-summary');
const intervalSummaryEl = document.getElementById('interval-schedule-summary');

const fixedDaysEl = form.elements.fixed_days;
const fixedHoursEl = form.elements.fixed_hours;
const fixedMinutesEl = form.elements.fixed_minutes;
const intervalMinEl = form.elements.interval_min;
const intervalMaxEl = form.elements.interval_max;
const intervalUnitEl = form.elements.interval_unit;
const dailyTimeStartEl = form.elements.daily_time_start;
const dailyTimeEndEl = form.elements.daily_time_end;
const dailyDayMinEl = form.elements.daily_day_min;
const dailyDayMaxEl = form.elements.daily_day_max;
const dailyWindowSummaryEl = document.getElementById('daily-window-schedule-summary');

const tgForm = document.getElementById('tg-form');
const tgStatusText = document.getElementById('tg-status-text');
const tgBotToken = document.getElementById('tg-bot-token');
const tgChatId = document.getElementById('tg-chat-id');
const tgProxy = document.getElementById('tg-proxy');
const tgWebhookUrl = document.getElementById('tg-webhook-url');
const tgTokenHelp = document.getElementById('tg-token-help');
const tgWebhookHelp = document.getElementById('tg-webhook-help');
const tgSaveBtn = document.getElementById('tg-save-btn');
const tgTestBtn = document.getElementById('tg-test-btn');
const schedulerForm = document.getElementById('scheduler-form');
const schedulerStatusText = document.getElementById('scheduler-status-text');
const schedulerAllowParallel = document.getElementById('scheduler-allow-parallel');
const schedulerSaveBtn = document.getElementById('scheduler-save-btn');
const successHeuristicsForm = document.getElementById('success-heuristics-form');
const successHeuristicsStatus = document.getElementById('success-heuristics-status');
const shEnabled = document.getElementById('sh-enabled');
const shGraceSec = document.getElementById('sh-grace-sec');
const shSuccessPatterns = document.getElementById('sh-success-patterns');
const shFailurePatterns = document.getElementById('sh-failure-patterns');
const shSaveBtn = document.getElementById('sh-save-btn');
const browserRuntimeForm = document.getElementById('browser-runtime-form');
const browserRuntimeStatus = document.getElementById('browser-runtime-status');
const brRuntimeStack = document.getElementById('br-runtime-stack');
const brUsePlaywrightExtra = document.getElementById('br-use-playwright-extra');
const brPluginPackages = document.getElementById('br-plugin-packages');
const brExtensionDirs = document.getElementById('br-extension-dirs');
const brSaveBtn = document.getElementById('br-save-btn');
const brInstallBtn = document.getElementById('br-install-btn');
const brInstallBrowserBtn = document.getElementById('br-install-browser-btn');
const storageCleanupDays = document.getElementById('storage-cleanup-days');
const storageCleanupCategories = document.getElementById('storage-cleanup-categories');
const storageCleanupPreviewBtn = document.getElementById('storage-cleanup-preview-btn');
const storageCleanupRunBtn = document.getElementById('storage-cleanup-run-btn');
const storageCleanupStatus = document.getElementById('storage-cleanup-status');
const storageCleanupResult = document.getElementById('storage-cleanup-result');
let storageCleanupPreview = null;
const visionForm = document.getElementById('vision-form');
const visionStatusText = document.getElementById('vision-status-text');
const visionChannelsList = document.getElementById('vision-channels-list');
const visionAddChannelBtn = document.getElementById('vision-add-channel');
const visionTestBtn = document.getElementById('vision-test-btn');
const visionSaveBtn = document.getElementById('vision-save-btn');
const cloudBackupForm = document.getElementById('cloud-backup-form');
const cloudBackupStatusText = document.getElementById('cloud-backup-status-text');
const cloudBackupEnabled = document.getElementById('cloud-backup-enabled');
const cloudBackupEndpoint = document.getElementById('cloud-backup-endpoint');
const cloudBackupRegion = document.getElementById('cloud-backup-region');
const cloudBackupBucket = document.getElementById('cloud-backup-bucket');
const cloudBackupAccessKey = document.getElementById('cloud-backup-access-key');
const cloudBackupSecretKey = document.getElementById('cloud-backup-secret-key');
const cloudBackupToken = document.getElementById('cloud-backup-token');
const cloudBackupProxy = document.getElementById('cloud-backup-proxy');
const cloudBackupPathStyle = document.getElementById('cloud-backup-path-style');
const cloudBackupPrefix = document.getElementById('cloud-backup-prefix');
const cloudBackupRetention = document.getElementById('cloud-backup-retention');
const cloudBackupSchedule = document.getElementById('cloud-backup-schedule');
const cloudBackupTimeFields = document.getElementById('cloud-backup-time-fields');
const cloudBackupHour = document.getElementById('cloud-backup-hour');
const cloudBackupMinute = document.getElementById('cloud-backup-minute');
const cloudBackupPassphrase = document.getElementById('cloud-backup-passphrase');
const cloudBackupPassphraseConfirm = document.getElementById('cloud-backup-passphrase-confirm');
const cloudBackupTestBtn = document.getElementById('cloud-backup-test-btn');
const cloudBackupSaveBtn = document.getElementById('cloud-backup-save-btn');
const cloudBackupClearBtn = document.getElementById('cloud-backup-clear-btn');
const cloudBackupLabel = document.getElementById('cloud-backup-label');
const cloudBackupRunBtn = document.getElementById('cloud-backup-run-btn');
const cloudBackupRefreshBtn = document.getElementById('cloud-backup-refresh-btn');
const cloudBackupNextText = document.getElementById('cloud-backup-next-text');
const cloudBackupList = document.getElementById('cloud-backup-list');
const cloudRestoreModal = document.getElementById('cloud-restore-modal');
const cloudRestoreMask = document.getElementById('cloud-restore-mask');
const cloudBackupUploadBtn = document.getElementById('cloud-backup-upload-btn');
const cloudBackupUploadInput = document.getElementById('cloud-backup-upload-input');
const taskParamsBlock = document.getElementById('task-params-block');
const taskParamsHint = document.getElementById('task-params-hint');
const taskEnvEditor = document.getElementById('task-env-editor');
const taskEnvAddRowBtn = document.getElementById('task-env-add-row');
const taskEnvTemplateHost2playBtn = document.getElementById('task-env-template-host2play');
const taskEnvApplyRawBtn = document.getElementById('task-env-apply-raw');
const taskEnvExportRawBtn = document.getElementById('task-env-export-raw');
const taskUseGlobalTelegram = document.getElementById('task-use-global-telegram');
const paramJsonRaw = document.getElementById('param-json-raw');
const globalEnvEditor = document.getElementById('global-env-editor');
const globalEnvAddRowBtn = document.getElementById('global-env-add-row');
const globalEnvImportBtn = document.getElementById('global-env-import');
const globalEnvSaveBtn = document.getElementById('global-env-save');
const githubCompatEnabled = document.getElementById('github-compat-enabled');
const conditionEnabledEl = document.getElementById('condition-enabled');
const conditionFieldsEl = document.getElementById('condition-fields');
const conditionTypeEl = document.getElementById('condition-type');
const conditionCheckIntervalEl = document.getElementById('condition-check-interval');
const conditionCheckUnitEl = document.getElementById('condition-check-unit');
const conditionCooldownEl = document.getElementById('condition-cooldown');
const conditionCooldownUnitEl = document.getElementById('condition-cooldown-unit');
const conditionUrlEl = document.getElementById('condition-url');
const conditionProxyEl = document.getElementById('condition-proxy');
const conditionMethodEl = document.getElementById('condition-method');
const conditionTimeoutEl = document.getElementById('condition-timeout');
const conditionSuccessStatusesEl = document.getElementById('condition-success-statuses');
const conditionExpectBodyEl = document.getElementById('condition-expect-body');
const conditionHttpFieldsEl = document.getElementById('condition-http-fields');
const conditionRemainingFieldsEl = document.getElementById('condition-remaining-fields');
const conditionWindowValueEl = document.getElementById('condition-window-value');
const conditionWindowUnitEl = document.getElementById('condition-window-unit');
const conditionJitterMinEl = document.getElementById('condition-jitter-min');
const conditionJitterMaxEl = document.getElementById('condition-jitter-max');
const conditionJitterUnitEl = document.getElementById('condition-jitter-unit');
const conditionTriggerIfExpiredEl = document.getElementById('condition-trigger-if-expired');
const conditionCallbackStatusText = document.getElementById('condition-callback-status-text');
const conditionTestBtn = document.getElementById('condition-test-btn');
const conditionLastStatusText = document.getElementById('condition-last-status-text');

const tabBtns = Array.from(document.querySelectorAll('.tab-btn'));
const tabContents = Array.from(document.querySelectorAll('.tab-content'));
const appShell = document.getElementById('app-shell');
const appSidebar = document.getElementById('app-sidebar');
const appNavToggle = document.getElementById('app-nav-toggle');
const appNavMask = document.getElementById('app-nav-mask');
const workspaceTitle = document.getElementById('workspace-title');
const workspaceSubtitle = document.getElementById('workspace-subtitle');
const workspaceHeaderActions = Array.from(document.querySelectorAll('[data-header-actions-for]'));
const mobileNavQuery = window.matchMedia('(max-width: 900px)');

const tabMeta = {
  'tasks-tab': ['Dashboard', '管理任务、运行状态与手动浏览器。'],
  'profiles-tab': ['Browser Profiles', '维护独立的浏览器数据与代理配置。'],
  'scripts-tab': ['Script Management', '管理任务脚本、目录与上传文件。'],
  'extensions-tab': ['插件管理', '上传、解压和管理浏览器插件目录。'],
  'profile-files-tab': ['用户目录', '管理浏览器用户数据目录与压缩包。'],
  'warp-tab': ['Cloudflare WARP', '管理 WARP 连接与双栈出口。'],
  'notifications-tab': ['TG Notifications', '配置 Telegram 通知与测试消息。'],
  'config-tab': ['Global Settings', '查找并调整面板级运行设置。'],
};

function syncAppSidebarAccessibility() {
  if (!appSidebar) return;
  const drawerOpen = appShell?.classList.contains('is-nav-open');
  appSidebar.inert = mobileNavQuery.matches && !drawerOpen;
  appSidebar.setAttribute('aria-hidden', mobileNavQuery.matches && !drawerOpen ? 'true' : 'false');
}

function closeAppNav({ restoreFocus = false } = {}) {
  if (!appShell || !appNavToggle || !appNavMask) return;
  appShell.classList.remove('is-nav-open');
  document.body.classList.remove('app-nav-open');
  appNavMask.hidden = true;
  appNavToggle.setAttribute('aria-expanded', 'false');
  appNavToggle.setAttribute('aria-label', '打开主导航');
  syncAppSidebarAccessibility();
  if (restoreFocus) appNavToggle.focus();
}

function openAppNav() {
  if (!appShell || !appNavToggle || !appNavMask) return;
  appShell.classList.add('is-nav-open');
  document.body.classList.add('app-nav-open');
  appNavMask.hidden = false;
  appNavToggle.setAttribute('aria-expanded', 'true');
  appNavToggle.setAttribute('aria-label', '关闭主导航');
  syncAppSidebarAccessibility();
  const selected = tabBtns.find((btn) => btn.getAttribute('aria-selected') === 'true');
  requestAnimationFrame(() => selected?.focus());
}

function activateAppTab(targetId, { focus = false } = {}) {
  const btn = tabBtns.find((item) => item.getAttribute('data-tab') === targetId);
  const panel = document.getElementById(targetId);
  if (!btn || !panel) return;

  tabBtns.forEach((item) => {
    const selected = item === btn;
    item.classList.toggle('active', selected);
    item.setAttribute('aria-selected', selected ? 'true' : 'false');
    item.tabIndex = selected ? 0 : -1;
  });
  tabContents.forEach((content) => {
    const selected = content === panel;
    content.classList.toggle('active', selected);
    content.hidden = !selected;
    content.setAttribute('aria-hidden', selected ? 'false' : 'true');
  });

  workspaceHeaderActions.forEach((actions) => {
    actions.hidden = actions.getAttribute('data-header-actions-for') !== targetId;
  });
  closeTaskOverflow();

  const meta = tabMeta[targetId] || ['', ''];
  if (workspaceTitle) workspaceTitle.textContent = meta[0];
  if (workspaceSubtitle) workspaceSubtitle.textContent = meta[1];
  closeAppNav();
  if (focus) btn.focus();

  if (targetId === 'scripts-tab') loadTasksFs(fsCurrentPath);
  if (targetId === 'extensions-tab') loadResourceManager('extensions');
  if (targetId === 'profile-files-tab') loadResourceManager('profiles');
  if (targetId === 'warp-tab') loadWarpStatus();
  if (targetId === 'config-tab' && typeof window.__onConfigTabShow === 'function') {
    window.__onConfigTabShow();
  }
}

tabBtns.forEach((btn, index) => {
  btn.addEventListener('click', () => activateAppTab(btn.getAttribute('data-tab')));
  btn.addEventListener('keydown', (event) => {
    let nextIndex = null;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = (index + 1) % tabBtns.length;
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex = (index - 1 + tabBtns.length) % tabBtns.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabBtns.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    activateAppTab(tabBtns[nextIndex].getAttribute('data-tab'), { focus: true });
  });
});

appNavToggle?.addEventListener('click', () => {
  if (appShell?.classList.contains('is-nav-open')) closeAppNav({ restoreFocus: true });
  else openAppNav();
});
appNavMask?.addEventListener('click', () => closeAppNav({ restoreFocus: true }));
mobileNavQuery.addEventListener('change', () => closeAppNav());
syncAppSidebarAccessibility();
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && appShell?.classList.contains('is-nav-open')) {
    closeAppNav({ restoreFocus: true });
  }
});

/* ---------- Global config: searchable index + section scroll ---------- */
function setupConfigSubnav() {
  const root = document.getElementById('config-tab');
  const nav = document.getElementById('config-subnav');
  const searchInput = document.getElementById('config-search-input');
  const searchResults = document.getElementById('config-search-results');
  const searchStatus = document.getElementById('config-search-status');
  if (!root || !nav) return;

  const buttons = Array.from(nav.querySelectorAll('.config-subnav-btn[data-config-target]'));
  const topSections = Array.from(root.querySelectorAll('.config-section[id]'));
  const searchable = Array.from(root.querySelectorAll('[data-config-title][id]')).map((el) => ({
    id: el.id,
    title: el.dataset.configTitle || '',
    path: el.dataset.configPath || '',
    haystack: `${el.dataset.configTitle || ''} ${el.dataset.configPath || ''} ${el.dataset.configKeywords || ''}`.toLocaleLowerCase(),
  }));
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function setActive(id) {
    buttons.forEach((btn) => {
      const active = btn.getAttribute('data-config-target') === id;
      btn.classList.toggle('active', active);
      if (active) btn.setAttribute('aria-current', 'location');
      else btn.removeAttribute('aria-current');
    });
  }

  function navigateTo(id, { focus = true } = {}) {
    const el = document.getElementById(id);
    if (!el) return;
    if (el instanceof HTMLDetailsElement) el.open = true;
    const parent = el.closest('.config-section');
    setActive(id);
    el.classList.remove('config-search-target');
    void el.offsetWidth;
    el.classList.add('config-search-target');
    el.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'start' });
    if (focus) {
      const focusTarget = el instanceof HTMLDetailsElement ? el.querySelector('summary') : el.querySelector('h2');
      if (focusTarget) {
        focusTarget.tabIndex = -1;
        window.setTimeout(() => focusTarget.focus({ preventScroll: true }), reducedMotion.matches ? 0 : 300);
      }
    }
    if (parent && id !== parent.id && !buttons.some((btn) => btn.getAttribute('data-config-target') === id)) {
      setActive(parent.id);
    }
  }

  buttons.forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      navigateTo(btn.getAttribute('data-config-target'));
    });
  });

  let ticking = false;
  function updateActiveFromScroll() {
    ticking = false;
    if (root.hidden || !root.classList.contains('active')) return;
    const headerHeight = document.querySelector('.workspace-header')?.getBoundingClientRect().height || 0;
    const navHeight = window.innerWidth <= 1060 ? nav.getBoundingClientRect().height : 0;
    const marker = headerHeight + navHeight + 18;
    let current = topSections[0]?.id;
    topSections.forEach((section) => {
      if (section.getBoundingClientRect().top <= marker) current = section.id;
    });
    if (current === 'cfg-advanced') {
      root.querySelectorAll('#cfg-advanced > .config-details').forEach((details) => {
        if (details.getBoundingClientRect().top <= marker + 8) current = details.id;
      });
    }
    if (current) setActive(current);
  }

  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(updateActiveFromScroll);
  }, { passive: true });

  let highlightedIndex = -1;
  let currentMatches = [];
  function highlightResult(index) {
    const resultButtons = Array.from(searchResults?.querySelectorAll('.config-search-result') || []);
    if (!resultButtons.length) return;
    highlightedIndex = (index + resultButtons.length) % resultButtons.length;
    resultButtons.forEach((btn, i) => btn.classList.toggle('is-highlighted', i === highlightedIndex));
    resultButtons[highlightedIndex].scrollIntoView({ block: 'nearest' });
  }

  function closeSearchResults({ clear = false } = {}) {
    if (clear && searchInput) searchInput.value = '';
    if (searchResults) searchResults.hidden = true;
    highlightedIndex = -1;
    currentMatches = [];
    if (clear && searchStatus) searchStatus.textContent = '输入设置名称或用途';
  }

  function renderSearch() {
    if (!searchInput || !searchResults || !searchStatus) return;
    const query = searchInput.value.trim().toLocaleLowerCase();
    highlightedIndex = -1;
    if (!query) {
      closeSearchResults();
      searchStatus.textContent = '输入设置名称或用途';
      return;
    }
    currentMatches = searchable.filter((item) => item.haystack.includes(query)).slice(0, 8);
    searchStatus.textContent = currentMatches.length ? `找到 ${currentMatches.length} 项设置` : '未找到匹配设置';
    searchResults.innerHTML = currentMatches.length
      ? currentMatches.map((item, index) => `<button type="button" class="config-search-result" data-result-index="${index}"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.path)}</span></button>`).join('')
      : '<div class="config-search-empty">换一个名称或用途试试</div>';
    searchResults.hidden = false;
  }

  searchInput?.addEventListener('input', renderSearch);
  searchInput?.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' && currentMatches.length) {
      event.preventDefault();
      highlightResult(highlightedIndex + 1);
    } else if (event.key === 'ArrowUp' && currentMatches.length) {
      event.preventDefault();
      highlightResult(highlightedIndex - 1);
    } else if (event.key === 'Enter' && currentMatches.length) {
      event.preventDefault();
      const item = currentMatches[highlightedIndex >= 0 ? highlightedIndex : 0];
      closeSearchResults();
      navigateTo(item.id);
    } else if (event.key === 'Escape') {
      closeSearchResults({ clear: true });
    }
  });
  searchResults?.addEventListener('click', (event) => {
    const btn = event.target.closest('.config-search-result');
    if (!btn) return;
    const item = currentMatches[Number(btn.dataset.resultIndex)];
    if (!item) return;
    closeSearchResults();
    navigateTo(item.id);
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.config-search')) closeSearchResults();
  });

  window.__onConfigTabShow = () => {
    if (!nav.querySelector('.config-subnav-btn.active') && buttons[0]) setActive(buttons[0].getAttribute('data-config-target'));
    requestAnimationFrame(updateActiveFromScroll);
  };
}

setupConfigSubnav();

let editingId = null;
let tasksCache = [];
let backupSelectionMode = false;
let selectedBackupTaskIds = new Set();
let pendingBackupPayload = null;
let runsCache = [];
let runningTaskIds = new Set();
// 点了停止、但服务端还没报 is_running=false 的任务。
// runningTaskIds 是 OR 进 isRunning 的，只能强制点亮不能强制熄灭：停止真正生效前
// 服务端仍回 is_running=true，光从 runningTaskIds 删掉按钮还是灰的。所以熄灭方向
// 需要这个独立的覆盖标记，优先级高于服务端状态。
let stoppingTaskIds = new Set();
// 停止覆盖不退场，直到服务端确认 is_running=false（loadTasks 里统一清）。
// 原来有个 10 秒自动过期兜底：优雅停止一慢（SIGTERM 后要等 1.5 秒才 SIGKILL），
// 覆盖先过期、服务端还在报 running，按钮就会在停止确认前弹回"运行中"再落回"启动"。
// 只有停止请求失败（catch 分支）才解除覆盖，交回服务端状态。
function markStopping(id) {
  stoppingTaskIds.add(id);
}

function clearStopping(id) {
  return stoppingTaskIds.delete(id);
}
let scriptsCache = [];
let lastRunsByTask = new Map();
let selectedScriptPath = '';
let browserSessionOpen = false;
let browserOpenedAt = null;

function escapeHtml(input) {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function prettyErrorCode(code) {
  const map = {
    timeout: '超时',
    permission_error: '权限错误',
    script_error: '脚本错误',
    browser_task_error: '浏览器任务错误',
    browser_launch_error: '浏览器启动错误',
    missing_result: '缺少结果文件',
    already_running: '任务已在运行',
    stopped: '已停止',
    browser_already_open: '浏览器已手动打开',
  };
  return map[code] || code || '';
}

function renderBrowserControls() {
  if (openBrowserBtn) {
    openBrowserBtn.disabled = browserSessionOpen;
    openBrowserBtn.innerHTML = browserSessionOpen
      ? '<i data-lucide="monitor-check" class="icon-sm"></i> 已启动'
      : '<i data-lucide="monitor-play" class="icon-sm"></i> 启动';
    if (window.lucide) window.lucide.createIcons({ root: openBrowserBtn });
  }
  if (closeBrowserBtn) {
    closeBrowserBtn.disabled = !browserSessionOpen;
    closeBrowserBtn.innerHTML = browserSessionOpen
      ? '<i data-lucide="monitor-stop" class="icon-sm"></i> 关闭浏览器'
      : '<i data-lucide="monitor-off" class="icon-sm"></i> 未启动';
    if (window.lucide) window.lucide.createIcons({ root: closeBrowserBtn });
  }
  if (browserSessionOpen && browserOpenedAt) {
    addTaskBtn.title = `浏览器已打开：${shortTime(browserOpenedAt)}`;
  } else {
    addTaskBtn.title = '';
  }
}

async function loadBrowserStatus() {
  const data = await fetchJson('/api/browser');
  browserSessionOpen = Boolean(data.data?.open);
  browserOpenedAt = data.data?.openedAt || null;
  renderBrowserControls();
}

async function openBrowserSession() {
  if (openBrowserBtn) openBrowserBtn.disabled = true;
  try {
    const profileId = browserProfileSelect ? browserProfileSelect.value : '';
    toast('正在启动浏览器…', 'info');
    await fetchJson('/api/browser/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_id: profileId || null }),
    });
    await loadBrowserStatus();
    toast('浏览器已成功启动（常驻，手动关闭或点「关闭浏览器」）', 'success');
  } catch (error) {
    await loadBrowserStatus().catch(() => {});
    toast(error.message || '浏览器启动失败', 'error');
  } finally {
    renderBrowserControls();
  }
}

async function closeBrowserSession() {
  try {
    await fetchJson('/api/browser/close', { method: 'POST' });
    await loadBrowserStatus();
    toast('浏览器会话已安全关闭', 'success');
  } catch (error) {
    toast(error.message || '浏览器关闭失败', 'error');
  }
}

function prettyStatus(status) {
  if (status === 'success') return '成功';
  if (status === 'failed') return '失败';
  if (status === 'running') return '运行中';
  if (status === 'stopped') return '已停止';
  return status || '-';
}

function prettyUnit(unit) {
  if (unit === 'minutes') return '分钟';
  if (unit === 'days') return '天';
  return '小时';
}

function shortTime(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value).replace('T', ' ').slice(0, 19);
  const pad = n => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function openModal(mode = 'create') {
  modal.classList.add('open');
  modalMask.hidden = false;
  modalTitle.textContent = mode === 'edit' ? '编辑任务' : '新建任务';
  updateScheduleDetailsUI();
  updateConditionFieldsUI();
  updateTaskFormSummary();
  if (typeof window.__onTaskModalShow === 'function') {
    window.__onTaskModalShow();
  }
}

function closeModal() {
  modal.classList.remove('open');
  modalMask.hidden = true;
}

function getScheduleMode() {
  return scheduleModeSelect.value || 'fixed';
}

function updateFixedSummary() {
  const days = Number(fixedDaysEl.value || 0);
  const hours = Number(fixedHoursEl.value || 0);
  const minutes = Number(fixedMinutesEl.value || 0);
  fixedSummaryEl.textContent = `每隔 ${days} 天 ${hours} 小时 ${minutes} 分钟执行一次`;
}

function updateIntervalSummary() {
  const min = Number(intervalMinEl.value || 1);
  const max = Math.max(min, Number(intervalMaxEl.value || min));
  const unit = prettyUnit(intervalUnitEl.value || 'minutes');
  intervalSummaryEl.textContent = `每次检查将在 ${min} - ${max} ${unit}内随机触发`;
}

function updateDailyWindowSummary() {
  if (!dailyWindowSummaryEl) return;
  const start = dailyTimeStartEl?.value || '08:00';
  const end = dailyTimeEndEl?.value || '12:00';
  const min = Math.max(1, Number(dailyDayMinEl?.value || 1));
  const max = Math.max(min, Number(dailyDayMaxEl?.value || min));
  const gap = min === max
    ? (min === 1 ? '每天' : `每 ${min} 天`)
    : `每隔 ${min} - ${max} 天随机`;
  dailyWindowSummaryEl.textContent = `${gap} ${start} - ${end} 之间随机执行`;
}

function updateScheduleModeUI() {
  const mode = getScheduleMode();
  fixedFieldsEl.hidden = mode !== 'fixed';
  intervalFieldsEl.hidden = mode !== 'interval';
  if (dailyWindowFieldsEl) dailyWindowFieldsEl.hidden = mode !== 'daily_window';
  
  fixedFieldsEl.setAttribute('aria-hidden', mode === 'fixed' ? 'false' : 'true');
  intervalFieldsEl.setAttribute('aria-hidden', mode === 'interval' ? 'false' : 'true');
  if (dailyWindowFieldsEl) dailyWindowFieldsEl.setAttribute('aria-hidden', mode === 'daily_window' ? 'false' : 'true');
  
  fixedFieldsEl.classList.toggle('active-pane', mode === 'fixed');
  intervalFieldsEl.classList.toggle('active-pane', mode === 'interval');
  if (dailyWindowFieldsEl) dailyWindowFieldsEl.classList.toggle('active-pane', mode === 'daily_window');

  const isFixed = mode === 'fixed';
  const isInterval = mode === 'interval';
  const isDaily = mode === 'daily_window';

  intervalMinEl.disabled = !isInterval;
  intervalMaxEl.disabled = !isInterval;
  intervalUnitEl.disabled = !isInterval;
  fixedDaysEl.disabled = !isFixed;
  fixedHoursEl.disabled = !isFixed;
  fixedMinutesEl.disabled = !isFixed;
  if (dailyTimeStartEl) dailyTimeStartEl.disabled = !isDaily;
  if (dailyTimeEndEl) dailyTimeEndEl.disabled = !isDaily;
  if (dailyDayMinEl) dailyDayMinEl.disabled = !isDaily;
  if (dailyDayMaxEl) dailyDayMaxEl.disabled = !isDaily;

  updateFixedSummary();
  updateIntervalSummary();
  updateDailyWindowSummary();
}

function buildSchedulePayloadFromForm() {
  const enabled = form.elements.enabled.checked;
  if (!enabled) {
    return { enabled: false, cron_expr: '', schedule_mode: 'fixed', interval_min: null, interval_max: null, interval_unit: null, daily_time_start: null, daily_time_end: null, daily_day_min: null, daily_day_max: null, next_run_at: null };
  }

  if (getScheduleMode() === 'daily_window') {
    const dayMin = Math.max(1, Number(dailyDayMinEl?.value || 1));
    const dayMax = Math.max(dayMin, Number(dailyDayMaxEl?.value || dayMin));
    return {
      enabled: true,
      cron_expr: '',
      schedule_mode: 'daily_window',
      interval_min: null,
      interval_max: null,
      interval_unit: null,
      daily_time_start: dailyTimeStartEl?.value || '08:00',
      daily_time_end: dailyTimeEndEl?.value || '12:00',
      daily_day_min: dayMin,
      daily_day_max: dayMax,
      next_run_at: null,
    };
  }

  if (getScheduleMode() === 'interval') {
    const min = Math.max(1, Number(intervalMinEl.value || 1));
    const max = Math.max(min, Number(intervalMaxEl.value || min));
    return {
      enabled: true,
      cron_expr: '',
      schedule_mode: 'interval',
      interval_min: min,
      interval_max: max,
      interval_unit: intervalUnitEl.value || 'minutes',
      next_run_at: null,
    };
  }

  const days = Math.max(0, Number(fixedDaysEl.value || 0));
  const hours = Math.max(0, Number(fixedHoursEl.value || 0));
  const minutes = Math.max(0, Number(fixedMinutesEl.value || 0));
  const totalMinutes = days * 24 * 60 + hours * 60 + minutes;
  const safeMinutes = Math.max(1, totalMinutes);
  if (safeMinutes % (24 * 60) === 0) {
    return {
      enabled: true,
      cron_expr: '',
      schedule_mode: 'fixed',
      interval_min: safeMinutes / (24 * 60),
      interval_max: safeMinutes / (24 * 60),
      interval_unit: 'days',
      next_run_at: null,
    };
  }
  if (safeMinutes % 60 === 0) {
    return {
      enabled: true,
      cron_expr: '',
      schedule_mode: 'fixed',
      interval_min: safeMinutes / 60,
      interval_max: safeMinutes / 60,
      interval_unit: 'hours',
      next_run_at: null,
    };
  }
  return {
    enabled: true,
    cron_expr: '',
    schedule_mode: 'fixed',
    interval_min: safeMinutes,
    interval_max: safeMinutes,
    interval_unit: 'minutes',
    next_run_at: null,
  };
}

function parseTaskSchedule(task) {
  if (!task || !task.enabled) {
    return { enabled: false, mode: 'fixed', fixedDays: 0, fixedHours: 4, fixedMinutes: 0, intervalMin: 5, intervalMax: 10, intervalUnit: 'minutes', dailyTimeStart: '08:00', dailyTimeEnd: '12:00', dailyDayMin: 1, dailyDayMax: 1 };
  }
  if (task.schedule_mode === 'daily_window') {
    return { enabled: true, mode: 'daily_window', fixedDays: 0, fixedHours: 4, fixedMinutes: 0, intervalMin: 5, intervalMax: 10, intervalUnit: 'minutes', dailyTimeStart: task.daily_time_start || '08:00', dailyTimeEnd: task.daily_time_end || '12:00', dailyDayMin: Number(task.daily_day_min || 1), dailyDayMax: Number(task.daily_day_max || task.daily_day_min || 1) };
  }
  if (task.schedule_mode === 'interval') {
    return { enabled: true, mode: 'interval', fixedDays: 0, fixedHours: 4, fixedMinutes: 0, intervalMin: Number(task.interval_min || 5), intervalMax: Number(task.interval_max || 10), intervalUnit: task.interval_unit || 'minutes', dailyTimeStart: '08:00', dailyTimeEnd: '12:00', dailyDayMin: 1, dailyDayMax: 1 };
  }
  let totalMinutes = Number(task.interval_min || task.interval_max || 0);
  if ((task.interval_unit || 'minutes') === 'days') totalMinutes *= 24 * 60;
  else if ((task.interval_unit || 'minutes') === 'hours') totalMinutes *= 60;
  const fixedDays = Math.floor(totalMinutes / (24 * 60));
  totalMinutes -= fixedDays * 24 * 60;
  const fixedHours = Math.floor(totalMinutes / 60);
  totalMinutes -= fixedHours * 60;
  return { enabled: true, mode: 'fixed', fixedDays, fixedHours, fixedMinutes: totalMinutes, intervalMin: 5, intervalMax: 10, intervalUnit: 'minutes', dailyTimeStart: '08:00', dailyTimeEnd: '12:00', dailyDayMin: 1, dailyDayMax: 1 };
}

function describeTaskSchedule(task) {
  if (!task.enabled) return '未启用';
  if (task.schedule_mode === 'daily_window') return `每天 ${task.daily_time_start || '00:00'}-${task.daily_time_end || '23:59'} 随机`;
  if (task.schedule_mode === 'interval') return `${task.interval_min} - ${task.interval_max} ${prettyUnit(task.interval_unit)}之间`;
  const parsed = parseTaskSchedule(task);
  return `${parsed.fixedDays}天 ${parsed.fixedHours}小时 ${parsed.fixedMinutes}分`;
}

function intervalToUnitValue(sec) {
  const s = Math.max(0, Number(sec) || 0);
  if (s === 0) return { value: 0, unit: 'minutes' };
  if (s >= 3600 && s % 3600 === 0) return { value: s / 3600, unit: 'hours' };
  return { value: Math.max(1, Math.round(s / 60)), unit: 'minutes' };
}

function unitValueToSec(value, unit, minSec = 0) {
  const n = Math.max(0, Number(value) || 0);
  const sec = unit === 'hours' ? n * 3600 : n * 60;
  return Math.max(minSec, sec);
}

function getConditionType() {
  return String(conditionTypeEl?.value || 'http_check').trim() || 'http_check';
}

/** Preview T = W - R for remaining_callback (inside window, not W+R). */
function updateRemainingThresholdPreview() {
  const el = document.getElementById('condition-threshold-preview');
  if (!el) return;
  const unitLabel = (u) => (u === 'hours' ? '小时' : (u === 'days' ? '天' : '分钟'));
  const wUnit = conditionWindowUnitEl?.value || 'minutes';
  const jUnit = conditionJitterUnitEl?.value || wUnit;
  const w = Number(conditionWindowValueEl?.value || 0);
  let jMin = Number(conditionJitterMinEl?.value || 0);
  let jMax = Number(conditionJitterMaxEl?.value || 0);
  if (!Number.isFinite(w) || w <= 0) {
    el.textContent = '预计触发：请填写有效的续期窗口 W';
    return;
  }
  if (!Number.isFinite(jMin) || jMin < 0) jMin = 0;
  if (!Number.isFinite(jMax) || jMax < 0) jMax = 0;
  if (jMax < jMin) {
    const t = jMin;
    jMin = jMax;
    jMax = t;
  }
  // Same unit compare when units match; otherwise only show formula in window unit when jitter unit differs
  if (wUnit === jUnit) {
    if (jMax > w) {
      el.textContent = `预计触发：偏移不能大于窗口（当前 max=${jMax} > W=${w}）`;
      el.style.color = 'var(--danger, #f87171)';
      return;
    }
    el.style.color = '';
    const tMin = Math.max(0, w - jMax);
    const tMax = Math.max(0, w - jMin);
    el.textContent = `预计触发：到期前 ${tMin}～${tMax} ${unitLabel(wUnit)}（T=W−偏移，仍在 ${w} ${unitLabel(wUnit)} 窗口内）`;
    return;
  }
  el.style.color = '';
  el.textContent = `预计触发：T = ${w} ${unitLabel(wUnit)} − 偏移 ${jMin}～${jMax} ${unitLabel(jUnit)}（窗口内，非 W+偏移）`;
}

function buildConditionPayloadFromForm() {
  const enabled = Boolean(conditionEnabledEl && conditionEnabledEl.checked);
  if (!enabled) {
    return { condition_enabled: false };
  }
  const type = getConditionType();

  if (type === 'remaining_callback') {
    const windowValue = Number(conditionWindowValueEl?.value || 30);
    const jitterMin = Number(conditionJitterMinEl?.value || 5);
    const jitterMax = Number(conditionJitterMaxEl?.value || 10);
    if (!Number.isFinite(windowValue) || windowValue <= 0) {
      throw new Error('续期窗口必须大于 0');
    }
    if (!Number.isFinite(jitterMin) || jitterMin < 0 || !Number.isFinite(jitterMax) || jitterMax < 0) {
      throw new Error('随机提前区间无效');
    }
    if (jitterMax < jitterMin) {
      throw new Error('随机提前上限不能小于下限');
    }
    // No polling UI for callback mode: scheduler follows trigger_at from script reports.
    // Keep small defaults so backend schema stays valid.
    return {
      condition_enabled: true,
      condition: {
        type: 'remaining_callback',
        check_interval_sec: 60,
        cooldown_sec: 600,
        config: {
          window_value: windowValue,
          window_unit: conditionWindowUnitEl?.value || 'minutes',
          jitter_min: jitterMin,
          jitter_max: jitterMax,
          jitter_unit: conditionJitterUnitEl?.value || 'minutes',
          trigger_if_expired: Boolean(conditionTriggerIfExpiredEl?.checked),
        },
      },
    };
  }

  const checkUnit = conditionCheckUnitEl?.value || 'minutes';
  const coolUnit = conditionCooldownUnitEl?.value || 'minutes';
  const checkSec = unitValueToSec(conditionCheckIntervalEl?.value || 5, checkUnit, 30);
  const coolSec = unitValueToSec(conditionCooldownEl?.value || 10, coolUnit, 0);
  const url = String(conditionUrlEl?.value || '').trim();
  if (!url) {
    throw new Error('启用 HTTP 条件时请填写检测 URL');
  }
  return {
    condition_enabled: true,
    condition: {
      type: 'http_check',
      check_interval_sec: checkSec,
      cooldown_sec: coolSec,
      config: {
        url,
        method: conditionMethodEl?.value || 'GET',
        timeout_ms: Math.min(60000, Math.max(1000, (Number(conditionTimeoutEl?.value) || 10) * 1000)),
        success_statuses: String(conditionSuccessStatusesEl?.value || '200-399').trim() || '200-399',
        expect_body_includes: String(conditionExpectBodyEl?.value || '').trim(),
        proxy: String(conditionProxyEl?.value || '').trim(),
      },
    },
  };
}

function fillConditionForm(task) {
  const enabled = Boolean(Number(task && task.condition_enabled));
  if (conditionEnabledEl) conditionEnabledEl.checked = enabled;
  const cond = (task && task.condition) || {};
  const cfg = cond.config || {};
  const type = cond.type || 'http_check';
  if (conditionTypeEl) conditionTypeEl.value = type;
  const check = intervalToUnitValue(cond.check_interval_sec || 300);
  const cool = intervalToUnitValue(cond.cooldown_sec || 600);
  if (conditionCheckIntervalEl) conditionCheckIntervalEl.value = check.value;
  if (conditionCheckUnitEl) conditionCheckUnitEl.value = check.unit;
  if (conditionCooldownEl) conditionCooldownEl.value = cool.value;
  if (conditionCooldownUnitEl) conditionCooldownUnitEl.value = cool.unit;
  if (conditionUrlEl) conditionUrlEl.value = cfg.url || '';
  if (conditionProxyEl) conditionProxyEl.value = cfg.proxy || '';
  if (conditionMethodEl) conditionMethodEl.value = cfg.method || 'GET';
  if (conditionTimeoutEl) conditionTimeoutEl.value = Math.round((Number(cfg.timeout_ms) || 10000) / 1000);
  if (conditionSuccessStatusesEl) conditionSuccessStatusesEl.value = cfg.success_statuses || '200-399';
  if (conditionExpectBodyEl) conditionExpectBodyEl.value = cfg.expect_body_includes || '';
  if (conditionWindowValueEl) conditionWindowValueEl.value = cfg.window_value ?? 30;
  if (conditionWindowUnitEl) conditionWindowUnitEl.value = cfg.window_unit || 'minutes';
  if (conditionJitterMinEl) conditionJitterMinEl.value = cfg.jitter_min ?? 5;
  if (conditionJitterMaxEl) conditionJitterMaxEl.value = cfg.jitter_max ?? 10;
  if (conditionJitterUnitEl) conditionJitterUnitEl.value = cfg.jitter_unit || cfg.window_unit || 'minutes';
  if (conditionTriggerIfExpiredEl) conditionTriggerIfExpiredEl.checked = Boolean(cfg.trigger_if_expired);
  updateConditionLastStatusText(task);
  updateConditionCallbackStatusText(task);
  updateConditionFieldsUI();
}

function resetConditionForm() {
  if (conditionEnabledEl) conditionEnabledEl.checked = false;
  if (conditionTypeEl) conditionTypeEl.value = 'http_check';
  if (conditionCheckIntervalEl) conditionCheckIntervalEl.value = 5;
  if (conditionCheckUnitEl) conditionCheckUnitEl.value = 'minutes';
  if (conditionCooldownEl) conditionCooldownEl.value = 10;
  if (conditionCooldownUnitEl) conditionCooldownUnitEl.value = 'minutes';
  if (conditionUrlEl) conditionUrlEl.value = '';
  if (conditionProxyEl) conditionProxyEl.value = '';
  if (conditionMethodEl) conditionMethodEl.value = 'GET';
  if (conditionTimeoutEl) conditionTimeoutEl.value = 10;
  if (conditionSuccessStatusesEl) conditionSuccessStatusesEl.value = '200-399';
  if (conditionExpectBodyEl) conditionExpectBodyEl.value = '';
  if (conditionWindowValueEl) conditionWindowValueEl.value = 30;
  if (conditionWindowUnitEl) conditionWindowUnitEl.value = 'minutes';
  if (conditionJitterMinEl) conditionJitterMinEl.value = 5;
  if (conditionJitterMaxEl) conditionJitterMaxEl.value = 10;
  if (conditionJitterUnitEl) conditionJitterUnitEl.value = 'minutes';
  if (conditionTriggerIfExpiredEl) conditionTriggerIfExpiredEl.checked = false;
  updateConditionLastStatusText(null);
  updateConditionCallbackStatusText(null);
  updateConditionFieldsUI();
}

function setPanelVisible(el, visible) {
  if (!el) return;
  el.hidden = !visible;
  // Belt-and-suspenders: some CSS display:grid rules can fight [hidden]
  el.style.display = visible ? '' : 'none';
}

function updateConditionFieldsUI() {
  const on = Boolean(conditionEnabledEl && conditionEnabledEl.checked);
  setPanelVisible(conditionFieldsEl, on);
  if (conditionFieldsEl) conditionFieldsEl.style.opacity = '1';

  const type = getConditionType();
  const isRemaining = type === 'remaining_callback';

  // Interval/cooldown are nested inside HTTP panel; remaining panel is exclusive.
  setPanelVisible(conditionHttpFieldsEl, on && !isRemaining);
  setPanelVisible(conditionRemainingFieldsEl, on && isRemaining);
  if (on && isRemaining) updateRemainingThresholdPreview();

  const hintEl = document.getElementById('condition-type-hint');
  if (hintEl) {
    hintEl.textContent = !on
      ? '启用后选择类型，只显示该类型的配置。'
      : (isRemaining
        ? '当前：剩余时间回调。T=窗口−偏移（窗口内触发，不是窗口外提前）。'
        : '当前：HTTP 检测。配置检测间隔、冷却与 URL。');
  }

  const testLabelEl = document.getElementById('condition-test-btn-label');
  if (testLabelEl) {
    testLabelEl.textContent = isRemaining ? '测试回调条件' : '测试 HTTP 检测';
  } else if (conditionTestBtn) {
    conditionTestBtn.disabled = false;
    const icon = conditionTestBtn.querySelector('i');
    const label = isRemaining ? '测试回调条件' : '测试 HTTP 检测';
    conditionTestBtn.textContent = '';
    if (icon) conditionTestBtn.appendChild(icon);
    conditionTestBtn.append(` ${label}`);
  }
  if (conditionTestBtn) conditionTestBtn.disabled = false;

  updateTaskFormSummary();
}

function isScheduleEnabled() {
  const el = form?.elements?.enabled || document.getElementById('schedule-enabled');
  return Boolean(el && el.checked);
}

function updateScheduleDetailsUI() {
  const details = document.getElementById('schedule-details');
  if (details) details.hidden = !isScheduleEnabled();
  updateTaskFormSummary();
}

function updateTaskFormSummary() {
  const summaryEl = document.getElementById('task-form-summary');
  const scriptSummaryEl = document.getElementById('task-script-summary');
  const scriptPath = String(form?.elements?.script_path?.value || '').trim();
  const scriptLabel = scriptPath
    ? scriptPath.split(/[/\\]/).filter(Boolean).pop() || scriptPath
    : '';
  const timeout = String(form?.elements?.timeout_sec?.value || '300').trim() || '300';
  const schedOn = isScheduleEnabled();
  const mode = getScheduleMode();
  const modeLabel = mode === 'daily_window'
    ? '每天时段'
    : (mode === 'interval' ? '随机区间' : '固定周期');
  const condOn = Boolean(conditionEnabledEl && conditionEnabledEl.checked);
  const temp = isTaskTempProfileMode();

  if (scriptSummaryEl) {
    scriptSummaryEl.textContent = scriptPath
      ? `脚本：${scriptLabel} · 超时 ${timeout}s`
      : '脚本：未选择（右侧导入或选中）';
  }
  if (summaryEl) {
    const bits = [
      scriptPath ? `脚本 ${scriptLabel}` : '未选脚本',
      `超时 ${timeout}s`,
      temp ? '临时（用完删除）' : '持久配置',
      schedOn ? `定时·${modeLabel}` : '手动运行',
      condOn ? '条件触发' : '无条件',
    ];
    summaryEl.textContent = bits.join(' · ');
  }
}

function setupTaskModalSubnav() {
  const nav = document.getElementById('task-subnav');
  if (!nav) return;
  const buttons = Array.from(nav.querySelectorAll('.task-subnav-btn[data-task-target]'));
  const sections = buttons
    .map((btn) => document.getElementById(btn.getAttribute('data-task-target')))
    .filter(Boolean);

  function setActive(id) {
    buttons.forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-task-target') === id);
    });
  }

  buttons.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const id = btn.getAttribute('data-task-target');
      const el = document.getElementById(id);
      if (!el) return;
      setActive(id);
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  let ticking = false;
  function updateFromScroll() {
    ticking = false;
    if (!modal || !modal.classList.contains('open')) return;
    const body = modal.querySelector('.task-modal-body');
    const marker = 120;
    let current = sections[0]?.id;
    for (const sec of sections) {
      const top = sec.getBoundingClientRect().top;
      if (top - marker <= 8) current = sec.id;
    }
    if (current) setActive(current);
  }

  const scrollRoot = modal?.querySelector('.task-modal-body') || window;
  scrollRoot.addEventListener(
    'scroll',
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(updateFromScroll);
    },
    { passive: true }
  );

  window.__onTaskModalShow = () => {
    if (buttons[0]) setActive(buttons[0].getAttribute('data-task-target'));
    requestAnimationFrame(updateFromScroll);
  };
}

setupTaskModalSubnav();

function updateConditionLastStatusText(task) {
  if (!conditionLastStatusText) return;
  if (!task || !task.condition_last_status) {
    conditionLastStatusText.textContent = '最近：—';
    return;
  }
  const when = task.condition_last_checked_at ? shortTime(task.condition_last_checked_at) : '';
  const detail = task.condition_last_detail || '';
  conditionLastStatusText.textContent = `最近：${task.condition_last_status}${detail ? ` · ${detail}` : ''}${when ? ` · ${when}` : ''}`;
}

function formatRemainingSec(sec) {
  const s = Math.floor(Number(sec));
  if (!Number.isFinite(s)) return '—';
  const abs = Math.abs(s);
  const sign = s < 0 ? '-' : '';
  if (abs < 60) return `${sign}${abs}s`;
  if (abs < 3600) return `${sign}${Math.floor(abs / 60)}m`;
  if (abs < 86400) {
    const h = Math.floor(abs / 3600);
    const m = Math.floor((abs % 3600) / 60);
    return m ? `${sign}${h}h${m}m` : `${sign}${h}h`;
  }
  const d = Math.floor(abs / 86400);
  const h = Math.floor((abs % 86400) / 3600);
  return h ? `${sign}${d}d${h}h` : `${sign}${d}d`;
}

function updateConditionCallbackStatusText(task) {
  if (!conditionCallbackStatusText) return;
  if (!task || task.callback_remaining_sec == null || task.callback_remaining_sec === '') {
    conditionCallbackStatusText.textContent = '回调：尚未上报 remaining_sec（请先手动探测）';
    return;
  }
  const rem = Number(task.callback_remaining_sec);
  const reportedAt = task.callback_reported_at ? new Date(task.callback_reported_at).getTime() : NaN;
  let est = rem;
  if (Number.isFinite(reportedAt)) {
    est = rem - (Date.now() - reportedAt) / 1000;
  }
  const parts = [
    `回调：上报剩余 ${formatRemainingSec(rem)}`,
    `估算现余 ${formatRemainingSec(est)}`,
  ];
  if (task.callback_valid_until) parts.push(`到期 ${task.callback_valid_until}`);
  if (task.callback_trigger_at) parts.push(`预计触发 ${shortTime(task.callback_trigger_at)}`);
  if (task.callback_threshold_sec != null) parts.push(`阈值 ${formatRemainingSec(task.callback_threshold_sec)}`);
  if (task.callback_action) parts.push(`action=${task.callback_action}`);
  conditionCallbackStatusText.textContent = parts.join(' · ');
}

function describeCondition(task) {
  if (!task || !Number(task.condition_enabled)) return '';
  const cond = task.condition || {};
  if (cond.type === 'remaining_callback') return '剩余时间回调';
  if (cond.type === 'http_check') return 'HTTP 检测';
  return cond.type || '条件';
}

function conditionStatusClass(task) {
  // Prefer live callback data over a stale last_status string
  if (task && task.condition?.type === 'remaining_callback' && task.callback_remaining_sec != null && task.callback_remaining_sec !== '') {
    return 'active';
  }
  const s = task && task.condition_last_status;
  if (s === 'ok' || s === 'waiting' || s === 'due') return 'active';
  if (s === 'fail' || s === 'error' || s === 'expired') return 'failed';
  return 'idle';
}

/** Condition value for task cards — only key next-action info. */
function describeConditionValue(task) {
  if (!task || !Number(task.condition_enabled)) return '—';
  const cond = task.condition || {};
  if (cond.type === 'remaining_callback') {
    if (task.callback_trigger_at) {
      return `下次触发 ${shortTime(task.callback_trigger_at)}`;
    }
    if (task.callback_remaining_sec == null || task.callback_remaining_sec === '') {
      return '等待上报';
    }
    // Have remaining but no trigger yet
    const rem = Number(task.callback_remaining_sec);
    const reportedAt = task.callback_reported_at ? new Date(task.callback_reported_at).getTime() : NaN;
    let est = rem;
    if (Number.isFinite(reportedAt)) {
      est = rem - (Date.now() - reportedAt) / 1000;
    }
    return `现余约 ${formatRemainingSec(est)}`;
  }
  // HTTP: show last status briefly, or next check time
  if (task.condition_last_status === 'ok' || task.condition_last_status === 'fail' || task.condition_last_status === 'error') {
    if (task.condition_next_check_at) {
      return `${task.condition_last_status} · 下次 ${shortTime(task.condition_next_check_at)}`;
    }
    return String(task.condition_last_status);
  }
  if (task.condition_next_check_at) return `下次检测 ${shortTime(task.condition_next_check_at)}`;
  return '等待检测';
}

function describeConditionValueFull(task) {
  if (!task || !Number(task.condition_enabled)) return '';
  const cond = task.condition || {};
  if (cond.type === 'remaining_callback') {
    if (task.callback_remaining_sec == null || task.callback_remaining_sec === '') {
      return '等待脚本上报 remaining_sec（请先手动探测）';
    }
    const rem = Number(task.callback_remaining_sec);
    const reportedAt = task.callback_reported_at ? new Date(task.callback_reported_at).getTime() : NaN;
    let est = rem;
    if (Number.isFinite(reportedAt)) {
      est = rem - (Date.now() - reportedAt) / 1000;
    }
    const parts = [
      `估算剩余 ${formatRemainingSec(est)}`,
      `上报剩余 ${formatRemainingSec(rem)}`,
    ];
    if (task.callback_valid_until) parts.push(`Valid until ${task.callback_valid_until}`);
    if (task.callback_trigger_at) parts.push(`预计触发 ${shortTime(task.callback_trigger_at)}`);
    if (task.callback_threshold_sec != null) parts.push(`阈值 ${formatRemainingSec(task.callback_threshold_sec)}`);
    if (task.callback_action) parts.push(`action=${task.callback_action}`);
    if (task.condition_next_check_at) parts.push(`下次检查 ${shortTime(task.condition_next_check_at)}`);
    return parts.join(' · ');
  }
  if (task.condition_last_status) {
    return `${task.condition_last_status}${task.condition_last_detail ? ` · ${task.condition_last_detail}` : ''}`;
  }
  if (task.condition_next_check_at) return `下次检测 ${shortTime(task.condition_next_check_at)}`;
  return '等待检测';
}

function describeNextRun(task) {
  if (!task.enabled) {
    if (Number(task.condition_enabled)) {
      if (task.condition_next_check_at) return `条件检测：${shortTime(task.condition_next_check_at)}`;
      return '条件检测已启用';
    }
    return '未启用';
  }
  if (task.next_run_at) return `下次：${shortTime(task.next_run_at)}`;
  return describeTaskSchedule(task);
}

function isHost2PlayScript(scriptPath) {
  const value = String(scriptPath || '').toLowerCase();
  return value.includes('host2play_renew_dp') || value.includes('host2play');
}

function parseParamsJson(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return { ...raw };
  try {
    const parsed = JSON.parse(String(raw));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // ignore
  }
  return {};
}

function looksLikeSecretName(name) {
  return /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE|AUTH)/i.test(String(name || ''));
}

function parseEnvText(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  if (raw.startsWith('{')) {
    const obj = parseParamsJson(raw);
    return Object.entries(obj).map(([name, value]) => ({
      name,
      value: value == null ? '' : String(value),
      is_secret: looksLikeSecretName(name) ? 1 : 0,
      has_value: true,
    }));
  }
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    let name = trimmed.slice(0, eq).trim();
    if (name.startsWith('export ')) name = name.slice(7).trim();
    let value = trimmed.slice(eq + 1);
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    rows.push({
      name,
      value,
      is_secret: looksLikeSecretName(name) ? 1 : 0,
      has_value: Boolean(value),
    });
  }
  return rows;
}

/**
 * GitHub-style env editor: list of variables + Add/Edit dialog (not cramped inline cells).
 * API compatible: setRows / addRow / collect / exportText / importText
 */
function createEnvEditor(container) {
  if (!container) {
    return {
      setRows() {},
      addRow() {},
      collect() { return []; },
      exportText() { return ''; },
      importText() {},
    };
  }

  /** @type {Array<{name:string,value:string,is_secret:number,has_value?:boolean,valueMasked?:string}>} */
  let items = [];

  function normalizeEntry(entry = {}) {
    const name = String(entry.name || '').trim();
    const isSecret = Boolean(entry.is_secret);
    const value = entry.value == null ? '' : String(entry.value);
    const hasValue = entry.has_value !== undefined
      ? Boolean(entry.has_value)
      : Boolean(value || entry.valueMasked);
    return {
      name,
      value: isSecret && !value ? '' : value,
      is_secret: isSecret ? 1 : 0,
      has_value: hasValue,
      valueMasked: entry.valueMasked || '',
    };
  }

  function previewValue(entry) {
    if (entry.is_secret) {
      if (entry.valueMasked) return entry.valueMasked;
      if (entry.has_value || entry.value) return '••••••••';
      return '（空）';
    }
    const v = String(entry.value || '');
    if (!v) return '（空）';
    const one = v.replace(/\s+/g, ' ').trim();
    return one.length > 72 ? `${one.slice(0, 72)}…` : one;
  }

  function renderList() {
    container.innerHTML = '';
    container.classList.add('env-editor');

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'env-list-empty muted';
      empty.textContent = '暂无变量。点击「添加变量」在弹窗中配置。';
      container.appendChild(empty);
      if (window.lucide) window.lucide.createIcons({ root: container });
      return;
    }

    const table = document.createElement('div');
    table.className = 'env-list';
    table.innerHTML = `
      <div class="env-list-head">
        <span>名称</span>
        <span>值</span>
        <span></span>
      </div>
    `;

    items.forEach((entry, index) => {
      const row = document.createElement('div');
      row.className = 'env-list-row';
      row.dataset.index = String(index);
      const badge = entry.is_secret
        ? '<span class="env-badge env-badge-secret">Secret</span>'
        : '<span class="env-badge env-badge-var">Variable</span>';
      row.innerHTML = `
        <div class="env-list-name">
          <code>${escapeHtml(entry.name)}</code>
          ${badge}
        </div>
        <div class="env-list-value muted" title="${escapeHtml(previewValue(entry))}">${escapeHtml(previewValue(entry))}</div>
        <div class="env-list-actions">
          <button type="button" class="alt env-edit-btn" data-index="${index}">编辑</button>
          <button type="button" class="icon-btn env-remove-btn" data-index="${index}" title="删除">
            <i data-lucide="trash-2" class="icon-sm"></i>
          </button>
        </div>
      `;
      table.appendChild(row);
    });

    container.appendChild(table);

    container.querySelectorAll('.env-edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.getAttribute('data-index'));
        openEnvDialog(items[i], i);
      });
    });
    container.querySelectorAll('.env-remove-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.getAttribute('data-index'));
        const name = items[i]?.name || '';
        items.splice(i, 1);
        renderList();
        if (name) toast(`已移除 ${name}`, 'success');
      });
    });

    if (window.lucide) window.lucide.createIcons({ root: container });
  }

  function openEnvDialog(entry = null, editIndex = -1) {
    const isEdit = editIndex >= 0 && entry;
    const mask = document.createElement('div');
    mask.className = 'modal-mask open';
    mask.style.zIndex = '10050';
    const dialog = document.createElement('div');
    dialog.className = 'modal open env-var-dialog';
    dialog.style.cssText = 'z-index:10051; max-width:520px; width:min(520px,92vw);';
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = `
      <div class="modal-header">
        <div>
          <h2>${isEdit ? '更新变量' : '添加变量'}</h2>
          <p class="muted" style="margin:4px 0 0;font-size:13px;">名称将作为环境变量注入脚本进程</p>
        </div>
        <button type="button" class="icon-btn env-dlg-close" aria-label="关闭">
          <i data-lucide="x" class="icon-md"></i>
        </button>
      </div>
      <div class="modal-body" style="padding-top:8px;">
        <form class="stack-form env-dlg-form">
          <div>
            <label class="field-label">名称</label>
            <input type="text" class="env-dlg-name" placeholder="例如 RENEW_URLS" spellcheck="false" autocomplete="off" ${isEdit ? 'readonly' : ''} />
          </div>
          <div>
            <label class="field-label">值</label>
            <textarea class="env-dlg-value" rows="8" placeholder="变量值（支持多行）" spellcheck="false"></textarea>
            <p class="schedule-note env-dlg-secret-hint" hidden style="margin-top:6px;">
              Secret：留空表示保留已保存的值；填写则更新。
            </p>
          </div>
          <label class="inline-check">
            <input type="checkbox" class="env-dlg-secret" />
            作为 Secret（保存后掩码显示）
          </label>
          <div class="row" style="margin-top:12px; gap:8px; justify-content:flex-end;">
            <button type="button" class="alt env-dlg-cancel">取消</button>
            <button type="submit" class="btn-primary">${isEdit ? '更新' : '添加'}</button>
          </div>
        </form>
      </div>
    `;

    document.body.appendChild(mask);
    document.body.appendChild(dialog);
    if (window.lucide) window.lucide.createIcons({ root: dialog });

    const nameInput = dialog.querySelector('.env-dlg-name');
    const valueInput = dialog.querySelector('.env-dlg-value');
    const secretCb = dialog.querySelector('.env-dlg-secret');
    const secretHint = dialog.querySelector('.env-dlg-secret-hint');

    if (isEdit && entry) {
      nameInput.value = entry.name || '';
      secretCb.checked = Boolean(entry.is_secret);
      if (entry.is_secret) {
        valueInput.value = '';
        valueInput.placeholder = entry.valueMasked
          ? `已保存 ${entry.valueMasked}（留空不修改）`
          : (entry.has_value ? '已保存（留空不修改）' : 'Secret value');
        secretHint.hidden = false;
      } else {
        valueInput.value = entry.value || '';
      }
    }

    const syncSecretUi = () => {
      secretHint.hidden = !secretCb.checked;
      if (secretCb.checked && isEdit && entry?.is_secret && !valueInput.value) {
        valueInput.placeholder = entry.valueMasked
          ? `已保存 ${entry.valueMasked}（留空不修改）`
          : '已保存（留空不修改）';
      } else if (!secretCb.checked) {
        valueInput.placeholder = '变量值（支持多行）';
      }
    };
    secretCb.addEventListener('change', syncSecretUi);

    const close = () => {
      mask.remove();
      dialog.remove();
    };
    dialog.querySelector('.env-dlg-close').addEventListener('click', close);
    dialog.querySelector('.env-dlg-cancel').addEventListener('click', close);
    mask.addEventListener('click', close);

    dialog.querySelector('.env-dlg-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = String(nameInput.value || '').trim();
      if (!name) {
        toast('请填写变量名', 'warn');
        return;
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        toast(`变量名无效: ${name}（仅允许字母数字下划线）`, 'error');
        return;
      }
      const isSecret = Boolean(secretCb.checked);
      let value = String(valueInput.value ?? '');
      if (isEdit && isSecret && value === '' && entry) {
        // keep previous secret value
        value = entry.value || '';
      }
      const next = normalizeEntry({
        name,
        value,
        is_secret: isSecret ? 1 : 0,
        has_value: isSecret ? (Boolean(value) || entry?.has_value) : Boolean(value),
        valueMasked: isSecret ? (entry?.valueMasked || '') : '',
      });

      if (isEdit) {
        // name readonly on edit; replace in place
        items[editIndex] = next;
      } else {
        const exists = items.findIndex((x) => x.name === name);
        if (exists >= 0) {
          items[exists] = { ...items[exists], ...next, valueMasked: next.is_secret ? items[exists].valueMasked : '' };
          toast(`已更新已有变量 ${name}`, 'success');
        } else {
          items.push(next);
        }
      }
      renderList();
      close();
    });

    setTimeout(() => {
      if (isEdit) valueInput.focus();
      else nameInput.focus();
    }, 50);
  }

  function setRows(entries) {
    const list = Array.isArray(entries) ? entries : [];
    items = list
      .map(normalizeEntry)
      .filter((e) => e.name);
    renderList();
  }

  function addRow(entry = {}) {
    if (entry && entry.name) {
      openEnvDialog(normalizeEntry(entry), -1);
      // prefill after open — openEnvDialog with entry as new
      return;
    }
    openEnvDialog(null, -1);
  }

  function collect() {
    return items
      .filter((e) => e.name)
      .map((e) => {
        const isSecret = Boolean(e.is_secret);
        const value = e.value == null ? '' : String(e.value);
        // Secret values are blank in the form (masked server-side). Keep has_value so
        // re-sync / save does not drop EMAIL/PASSWORD-style secrets.
        const hasValue = isSecret
          ? Boolean(e.has_value || e.valueMasked || value)
          : Boolean(value);
        return {
          name: e.name,
          value,
          is_secret: isSecret ? 1 : 0,
          has_value: hasValue,
          valueMasked: e.valueMasked || '',
        };
      });
  }

  function exportText() {
    return collect()
      .map((e) => `${e.name}=${String(e.value).replace(/\n/g, '\\n')}`)
      .join('\n');
  }

  function importText(text) {
    const parsed = parseEnvText(text);
    if (!parsed.length) throw new Error('未解析到任何 KEY=value');
    const byName = new Map(items.map((e) => [e.name, e]));
    for (const item of parsed) {
      byName.set(item.name, normalizeEntry(item));
    }
    items = [...byName.values()];
    renderList();
  }

  setRows([]);
  return {
    setRows,
    /** Open add dialog (or merge named entry from templates without dialog). */
    addRow: (entry) => {
      if (entry && entry.name) {
        const n = normalizeEntry(entry);
        const exists = items.findIndex((x) => x.name === n.name);
        if (exists >= 0) {
          if (n.value && !items[exists].value) items[exists] = { ...items[exists], value: n.value, has_value: true };
        } else {
          items.push(n);
        }
        renderList();
        return;
      }
      openEnvDialog(null, -1);
    },
    collect,
    exportText,
    importText,
    el: container,
  };
}

const taskEnvUI = createEnvEditor(taskEnvEditor);
const globalEnvUI = createEnvEditor(globalEnvEditor);

function entriesFromParamsObject(params = {}) {
  return Object.entries(params || {})
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([name, value]) => ({
      name,
      value: typeof value === 'string' ? value : JSON.stringify(value),
      is_secret: looksLikeSecretName(name) ? 1 : 0,
      has_value: true,
    }));
}

function readUseGlobalTelegramFlag(paramsOrEnv) {
  let raw;
  if (Array.isArray(paramsOrEnv)) {
    const hit = paramsOrEnv.find((e) => String(e?.name || '').toUpperCase() === 'USE_GLOBAL_TELEGRAM');
    raw = hit ? hit.value : undefined;
  } else if (paramsOrEnv && typeof paramsOrEnv === 'object') {
    raw = paramsOrEnv.USE_GLOBAL_TELEGRAM ?? paramsOrEnv.use_global_telegram;
  }
  if (raw === undefined || raw === null || String(raw).trim() === '') return true;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function syncTaskParamsUI(scriptPath, paramsOrEnv = {}) {
  if (!taskParamsBlock) return;
  taskParamsBlock.hidden = false;
  const isHost2 = isHost2PlayScript(scriptPath);
  if (taskEnvTemplateHost2playBtn) taskEnvTemplateHost2playBtn.hidden = !isHost2;
  if (taskParamsHint) {
    taskParamsHint.textContent = isHost2
      ? 'Host2Play：常用 RENEW_URLS / MAX_RETRIES 等，可点模板预填'
      : '键值注入脚本 env；Secret 勾选后掩码保存';
  }

  // Dedicated controls own browser/profile settings and internal switches.
  if (Array.isArray(paramsOrEnv)) {
    taskEnvUI.setRows(filterManagedEnvRows(paramsOrEnv));
  } else {
    taskEnvUI.setRows(entriesFromParamsObject(filterManagedEnvObject(paramsOrEnv)));
  }

  if (taskUseGlobalTelegram) {
    taskUseGlobalTelegram.checked = readUseGlobalTelegramFlag(paramsOrEnv);
  }

  if (isHost2 && form.elements.timeout_sec && Number(form.elements.timeout_sec.value || 0) < 600) {
    form.elements.timeout_sec.value = '900';
  }
}

function collectTaskEnvFromForm() {
  // Always return full rows including is_secret + has_value (see createEnvEditor.collect)
  return taskEnvUI.collect();
}

function collectTaskParamsFromForm() {
  // Backward-compatible flat object (also used for USE_TEMP_PROFILE side effects)
  // NOTE: secret values are intentionally empty in the UI — do NOT use this object
  // to re-seed the env editor (empty secrets get filtered out and disappear).
  const env = collectTaskEnvFromForm();
  const params = {};
  for (const item of env) {
    if (!item.name) continue;
    // Preserve secret keys even when value is blank so callers that iterate keys still see them
    if (item.is_secret && !item.value && item.has_value) {
      params[item.name] = item.value; // still '' — presence matters for some call sites
      continue;
    }
    params[item.name] = item.value;
  }
  return params;
}

/** Full env rows for re-rendering the editor without dropping masked secrets. */
function collectSafeCurrentEnvRows() {
  try {
    return collectTaskEnvFromForm();
  } catch {
    return [];
  }
}

function applyHost2PlayTemplate() {
  const current = collectTaskEnvFromForm();
  const byName = new Map(current.map((e) => [e.name, { ...e }]));
  const defaults = [
    { name: 'RENEW_URLS', value: '', is_secret: 0, has_value: false },
    { name: 'VISION_CALL_BUDGET', value: '200', is_secret: 0, has_value: true },
    { name: 'MAX_RETRIES', value: '8', is_secret: 0, has_value: true },
    { name: 'MAX_RENEW_RETRIES_PER_URL', value: '8', is_secret: 0, has_value: true },
    { name: 'VISION_DEBUG', value: '0', is_secret: 0, has_value: true },
  ];
  for (const item of defaults) {
    if (!byName.has(item.name)) byName.set(item.name, item);
  }
  taskEnvUI.setRows([...byName.values()]);
  if (form.elements.timeout_sec && Number(form.elements.timeout_sec.value || 0) < 600) {
    form.elements.timeout_sec.value = '900';
  }
  toast('已填入 Host2Play 常用变量（点编辑可改 RENEW_URLS）', 'success');
}

async function loadGlobalEnvSettings() {
  if (!globalEnvEditor) return;
  try {
    const res = await fetchJson('/api/env?scope=global');
    globalEnvUI.setRows(res.data || []);
    if (githubCompatEnabled) {
      githubCompatEnabled.checked = res.githubCompat !== false;
    }
  } catch (error) {
    console.warn('load global env failed', error);
  }
}

function makeVisionChannelCard(channel = {}, index = 0) {
  const isPrimary = index === 0;
  const card = document.createElement('div');
  card.className = 'vision-channel-card' + (isPrimary ? ' is-primary' : '');
  card.dataset.visionChannel = '1';
  card.dataset.channelId = channel.id || '';

  const masked = channel.apiKeyMasked || '';
  const keyPlaceholder = masked ? `已保存 ${masked}` : 'API Key';
  const label = isPrimary ? '主' : String(index);

  // 记录初始值，用于判断卡片是否干净（未编辑）
  card.dataset.initialBase = channel.baseUrl || '';
  card.dataset.initialModel = channel.model || '';
  card.dataset.initialHasKey = channel.hasKey ? '1' : '0';

  card.innerHTML = `
    <div class="vision-channel-row">
      <span class="vision-channel-badge">${label}</span>
      <input type="text" class="vision-ch-base" placeholder="Base URL" value="${(channel.baseUrl || '').replace(/"/g, '&quot;')}" />
      <input type="password" class="vision-ch-key" placeholder="${keyPlaceholder.replace(/"/g, '&quot;')}" autocomplete="new-password" />
      <div class="vision-model-input-group">
        <input type="text" class="vision-ch-model" placeholder="Model" value="${(channel.model || '').replace(/"/g, '&quot;')}" />
        <button type="button" class="icon-btn vision-ch-model-toggle" title="选择模型">
          <i data-lucide="chevron-down" class="icon-sm"></i>
        </button>
      </div>
      <div class="vision-channel-actions">
        <button type="button" class="alt btn-with-icon vision-channel-test" title="测试此通道">
          <i data-lucide="radar" class="icon-sm"></i> 测试
        </button>
        <button type="button" class="alt btn-with-icon vision-channel-make-primary" title="设为主通道" ${isPrimary ? 'disabled' : ''}>
          <i data-lucide="star" class="icon-sm"></i> 主通道
        </button>
        <button type="button" class="icon-btn vision-channel-remove" title="删除" ${isPrimary ? 'disabled' : ''}>
          <i data-lucide="trash-2" class="icon-sm"></i>
        </button>
      </div>
    </div>
  `;

  const removeBtn = card.querySelector('.vision-channel-remove');
  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      const cards = visionChannelsList
        ? visionChannelsList.querySelectorAll('[data-vision-channel]')
        : [];
      if (cards.length <= 1) {
        toast('至少保留一个通道', 'warn');
        return;
      }
      card.remove();
      renumberVisionChannels();
    });
  }

  const primaryBtn = card.querySelector('.vision-channel-make-primary');
  if (primaryBtn) {
    primaryBtn.addEventListener('click', () => {
      promoteVisionChannelCard(card);
    });
  }

  const testBtn = card.querySelector('.vision-channel-test');
  if (testBtn) {
    testBtn.addEventListener('click', () => {
      openVisionTestModalForCard(card);
    });
  }

  const modelToggle = card.querySelector('.vision-ch-model-toggle');
  if (modelToggle) {
    modelToggle.addEventListener('click', () => {
      openModelDropdown(card);
    });
  }

  return card;
}

function renumberVisionChannels() {
  if (!visionChannelsList) return;
  const cards = visionChannelsList.querySelectorAll('[data-vision-channel]');
  cards.forEach((card, i) => {
    const isPrimary = i === 0;
    card.classList.toggle('is-primary', isPrimary);
    const badge = card.querySelector('.vision-channel-badge');
    if (badge) badge.textContent = isPrimary ? '主' : String(i);
    const removeBtn = card.querySelector('.vision-channel-remove');
    if (removeBtn) {
      removeBtn.disabled = isPrimary;
      removeBtn.style.visibility = isPrimary ? 'hidden' : 'visible';
    }
    const primaryBtn = card.querySelector('.vision-channel-make-primary');
    if (primaryBtn) {
      primaryBtn.disabled = isPrimary;
      primaryBtn.title = isPrimary ? '当前已是主通道' : '设为主通道';
    }
  });
}

/** Move a channel card to index 0 (primary). Order is what save/failover uses. */
function promoteVisionChannelCard(card) {
  if (!visionChannelsList || !card) return;
  const first = visionChannelsList.querySelector('[data-vision-channel]');
  if (!first || first === card) {
    toast('已是主通道', 'success');
    return;
  }
  visionChannelsList.insertBefore(card, first);
  renumberVisionChannels();
  if (window.lucide) window.lucide.createIcons({ root: visionChannelsList });
  toast('已设为主通道（记得保存）', 'success');
}

function readVisionChannelFromCard(card) {
  if (!card) return null;
  return {
    id: card.dataset.channelId || '',
    baseUrl: card.querySelector('.vision-ch-base')?.value?.trim() || '',
    apiKey: card.querySelector('.vision-ch-key')?.value?.trim() || '',
    model: card.querySelector('.vision-ch-model')?.value?.trim() || '',
    card,
  };
}

// 模型列表缓存：key = 规范化 baseUrl，value = string[]。首次拉取后再开秒出，
// 底部「⟳ 刷新」强制重拉（换了供应商 / 新上了模型时用）。
const visionModelCache = new Map();
let visionDropdownOutsideHandler = null;
let visionDropdownKeyHandler = null;

function visionCacheKey(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '').toLowerCase();
}

function updateVisionStatusText(data = {}) {
  if (!visionStatusText) return;
  const count = Number(data.channelCount || 0);
  const base = data.configured ? 'Status: configured' : 'Status: not configured';
  visionStatusText.textContent = count > 1 ? `${base} · ${count} 通道` : base;
  visionStatusText.style.color = data.configured ? '#86efac' : '#94a3b8';
}

/**
 * 卡片是否「干净」——除 model 外没有未保存的改动。
 * model 自己不算脏：切模型就是要覆盖它。
 * 顺序只检查「主通道是否还在第 1 位」；ch1/ch2 互换不算脏，因为按 id 落库不会写错通道，
 * 那个待保存的顺序改动会原样留在表单里。
 */
function isVisionCardClean(card) {
  if (!card || !card.dataset.channelId) return false; // 新增通道：还没有身份，必须走保存
  if (card.dataset.initialHasKey !== '1') return false; // 库里没 key，改 model 也存不下去
  if (card.querySelector('.vision-ch-key')?.value) return false; // 填了新 key
  const base = card.querySelector('.vision-ch-base')?.value?.trim() || '';
  if (base !== (card.dataset.initialBase || '')) return false;
  const cards = visionChannelsList
    ? Array.from(visionChannelsList.querySelectorAll('[data-vision-channel]'))
    : [];
  const at = cards.indexOf(card);
  const isPrimaryId = card.dataset.channelId === 'primary';
  if (isPrimaryId !== (at === 0)) return false; // 有待保存的「设为主通道」
  return true;
}

function closeVisionModelDropdown() {
  document.querySelectorAll('.vision-model-dropdown').forEach((el) => el.remove());
  document.querySelectorAll('.vision-model-input-group.is-open')
    .forEach((el) => el.classList.remove('is-open'));
  if (visionDropdownOutsideHandler) {
    document.removeEventListener('mousedown', visionDropdownOutsideHandler, true);
    visionDropdownOutsideHandler = null;
  }
  if (visionDropdownKeyHandler) {
    document.removeEventListener('keydown', visionDropdownKeyHandler, true);
    visionDropdownKeyHandler = null;
  }
}

function renderVisionChannels(list) {
  if (!visionChannelsList) return;
  closeVisionModelDropdown();
  visionChannelsList.innerHTML = '';
  const channels = Array.isArray(list) && list.length ? list : [{}];
  channels.forEach((ch, i) => visionChannelsList.appendChild(makeVisionChannelCard(ch, i)));
  renumberVisionChannels();
  if (window.lucide) window.lucide.createIcons();
}

function collectVisionChannels() {
  if (!visionChannelsList) return [];
  const cards = visionChannelsList.querySelectorAll('[data-vision-channel]');
  const out = [];
  cards.forEach((card) => {
    const id = card.dataset.channelId || '';
    const baseUrl = card.querySelector('.vision-ch-base')?.value?.trim() || '';
    const apiKey = card.querySelector('.vision-ch-key')?.value?.trim() || '';
    const model = card.querySelector('.vision-ch-model')?.value?.trim() || '';
    if (!baseUrl && !apiKey && !model) return;
    out.push({ id, baseUrl, apiKey, model });
  });
  return out;
}

async function loadVisionSettings() {
  if (!visionForm) return;
  try {
    const res = await fetchJson('/api/settings/vision');
    const data = res.data || {};
    renderVisionChannels(data.channelList);
    updateVisionStatusText(data);
  } catch (error) {
    if (visionStatusText) {
      visionStatusText.textContent = 'Status: load failed';
      visionStatusText.style.color = '#ef4444';
    }
    console.error('Failed to load vision settings:', error);
  }
}

/**
 * 模型下拉：拉列表 → 搜索过滤 → 点选切换。
 * 卡片干净时点选直接落库（只改 model，不碰 key）；卡片脏时只填输入框并提示去保存，
 * 避免把用户还在编辑、并不想提交的字段一并写进去。
 */
async function openModelDropdown(card) {
  if (!card) return;
  const group = card.querySelector('.vision-model-input-group');
  const modelInput = card.querySelector('.vision-ch-model');
  if (!group || !modelInput) return;

  // 再点一次 = 关闭
  if (group.classList.contains('is-open')) {
    closeVisionModelDropdown();
    return;
  }
  closeVisionModelDropdown();

  const baseUrl = card.querySelector('.vision-ch-base')?.value?.trim() || '';
  if (!baseUrl) {
    toast('请先填写该通道 Base URL', 'warn');
    return;
  }

  group.classList.add('is-open');
  const panel = document.createElement('div');
  panel.className = 'vision-model-dropdown';
  panel.innerHTML = ''
    + '<input type="text" class="vision-model-search" placeholder="搜索模型…" autocomplete="off" />'
    + '<div class="vision-model-list" data-model-list><div class="vision-model-empty">加载中…</div></div>'
    + '<div class="vision-model-dropdown-foot">'
    + '  <span data-model-count class="muted"></span>'
    + '  <button type="button" class="vision-model-refresh" data-model-refresh>⟳ 刷新</button>'
    + '</div>';
  group.appendChild(panel);

  const searchEl = panel.querySelector('.vision-model-search');
  const listEl = panel.querySelector('[data-model-list]');
  const countEl = panel.querySelector('[data-model-count]');
  const refreshBtn = panel.querySelector('[data-model-refresh]');

  visionDropdownOutsideHandler = (e) => {
    if (!panel.contains(e.target) && !group.contains(e.target)) closeVisionModelDropdown();
  };
  visionDropdownKeyHandler = (e) => {
    if (e.key === 'Escape') {
      closeVisionModelDropdown();
      modelInput.focus();
    }
  };
  document.addEventListener('mousedown', visionDropdownOutsideHandler, true);
  document.addEventListener('keydown', visionDropdownKeyHandler, true);

  let allIds = [];
  let visibleIds = [];

  const applyModel = async (id) => {
    const channelId = card.dataset.channelId || '';
    const clean = isVisionCardClean(card);
    modelInput.value = id;
    closeVisionModelDropdown();
    if (!clean) {
      toast(`已填入 ${id} · 该通道有未保存的改动，请点「保存」生效`, 'warn');
      return;
    }
    try {
      const res = await fetchJson('/api/settings/vision/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: channelId, model: id }),
      });
      card.dataset.initialModel = id;
      updateVisionStatusText(res.data || {});
      toast(`已切换到 ${id}`, 'success');
    } catch (error) {
      modelInput.value = card.dataset.initialModel || '';
      toast(error.message || '切换模型失败', 'error');
    }
  };

  const renderList = () => {
    const q = (searchEl?.value || '').trim().toLowerCase();
    const current = modelInput.value.trim();
    const shown = q ? allIds.filter((id) => id.toLowerCase().includes(q)) : allIds;
    visibleIds = shown;
    if (countEl) {
      countEl.textContent = q
        ? `${shown.length} / ${allIds.length}`
        : `${allIds.length} 个模型`;
    }
    if (!shown.length) {
      listEl.innerHTML = `<div class="vision-model-empty">${allIds.length ? '没有匹配的模型' : '未读到模型列表'}</div>`;
      return;
    }
    listEl.innerHTML = shown.map((id) => {
      const selected = id === current ? ' is-selected' : '';
      return `<button type="button" class="vision-model-option${selected}" data-model-id="${escapeHtml(id)}">${escapeHtml(id)}</button>`;
    }).join('');
    listEl.querySelectorAll('[data-model-id]').forEach((btn) => {
      btn.addEventListener('click', () => applyModel(btn.getAttribute('data-model-id') || ''));
    });
  };

  const load = async (force) => {
    const cacheKey = visionCacheKey(baseUrl);
    if (!force && visionModelCache.has(cacheKey)) {
      allIds = visionModelCache.get(cacheKey);
      renderList();
      return;
    }
    listEl.innerHTML = '<div class="vision-model-empty">加载中…</div>';
    if (refreshBtn) refreshBtn.disabled = true;
    try {
      const res = await fetchJson('/api/settings/vision/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: card.dataset.channelId || '',
          baseUrl,
          apiKey: card.querySelector('.vision-ch-key')?.value?.trim() || '',
          model: modelInput.value.trim(),
          fetchModels: true,
          testImage: false, // 只要列表，不跑识图探测
        }),
      });
      const ids = (res.data && res.data.models && res.data.models.ids) || [];
      allIds = Array.isArray(ids) ? ids : [];
      visionModelCache.set(cacheKey, allIds);
      renderList();
    } catch (error) {
      listEl.innerHTML = `<div class="vision-model-empty is-bad">${escapeHtml(error.message || '拉取模型失败')}</div>`;
      if (countEl) countEl.textContent = '';
    } finally {
      if (refreshBtn) refreshBtn.disabled = false;
    }
  };

  if (searchEl) {
    searchEl.addEventListener('input', renderList);
    // 搜索框在 <form id="vision-form"> 里，回车会误触发整表保存 —— 拦下来，
    // 顺手让回车 = 选中唯一/第一个匹配项。
    searchEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      if (visibleIds.length) applyModel(visibleIds[0]);
    });
  }
  if (refreshBtn) refreshBtn.addEventListener('click', () => load(true));
  await load(false);
  if (searchEl) searchEl.focus();
}

function resetTaskForm() {
  form.reset();
  editingId = null;
  selectedScriptPath = '';
  saveBtn.textContent = '保存任务';
  formTitle.textContent = '任务信息';
  formHint.textContent = '只填任务名和定时规则。';
  form.elements.name.value = '';
  form.elements.type.value = 'javascript';
  form.elements.script_path.value = '';
  form.elements.timeout_sec.value = '300';
  if (form.elements.browser_profile_id) form.elements.browser_profile_id.value = '';
  if (taskUsePersistentInput) taskUsePersistentInput.value = '0';
  setTaskBrowserProxyInput('');
  setTaskProfileMode('temp');
  if (taskProfileSelect) renderProfileOptions(taskProfileSelect, '');
  // form.reset() 会退回带 selected 的那个 option，也就是上次编辑的分组，
  // 所以这里必须重画一遍，让新任务默认落在"未分组"。
  renderTaskGroupOptions(document.getElementById('task-group-select'), '');
  form.elements.enabled.checked = false;
  scheduleModeSelect.value = 'fixed';
  fixedDaysEl.value = '0';
  fixedHoursEl.value = '4';
  fixedMinutesEl.value = '0';
  intervalMinEl.value = '5';
  intervalMaxEl.value = '10';
  intervalUnitEl.value = 'minutes';
  if (dailyTimeStartEl) dailyTimeStartEl.value = '08:00';
  if (dailyTimeEndEl) dailyTimeEndEl.value = '12:00';
  if (dailyDayMinEl) dailyDayMinEl.value = '1';
  if (dailyDayMaxEl) dailyDayMaxEl.value = '1';
  updateScheduleModeUI();
  resetConditionForm();
  syncTaskParamsUI('', {});
}

function resetScriptEditor() {
  modalImportForm.reset();
  modalImportForm.elements.type.value = 'javascript';
}

function slugifyName(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function getScriptLabel(scriptPath) {
  const value = String(scriptPath || '').trim();
  if (!value) return '未绑定脚本';
  const parts = value.split('/');
  return parts[parts.length - 1] || value;
}

function resetAllModalState() {
  resetTaskForm();
  resetScriptEditor();
}

function groupLastRuns(runs) {
  lastRunsByTask = new Map();
  for (const run of runs) if (!lastRunsByTask.has(run.task_id)) lastRunsByTask.set(run.task_id, run);
}


function classifyShotKind(name) {
  const lower = String(name || '').toLowerCase().replace(/\\/g, '/');
  if (lower.includes('yolo_hard/miss/') || /(^|\/)miss\//.test(lower)) return '漏选/未认出';
  if (lower.includes('yolo_hard/wrong/') || /(^|\/)wrong\//.test(lower)) return '认错类';
  if (lower.includes('yolo_hard/grids/')) return '难例整表';
  if (lower.includes('yolo_hard/')) return '难例';
  if (lower.includes('yolo_tile')) return '格子(全量)';
  if (lower.startsWith('instr_')) return '题目';
  if (lower.includes('_grid.png') || lower.includes('yolo_grid')) return '整表';
  if (lower.startsWith('table_')) return '题图';
  if (lower.includes('success') || lower.includes('fail') || lower.includes('host2play')) return '结果';
  return '截图';
}

function formatBytes(size) {
  const n = Number(size) || 0;
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
  return (n / (1024 * 1024)).toFixed(1) + 'MB';
}

async function openRunScreenshots(runId) {
  const data = await fetchJson('/api/runs/' + runId + '/screenshots');
  const payload = data.data || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) {
    toast('这次运行没有可查看的截图', 'warn');
    return;
  }

  let activeIndex = 0;
  const mask = document.createElement('div');
  mask.className = 'modal-mask open';
  mask.style.zIndex = '10020';

  const dialog = document.createElement('section');
  dialog.className = 'modal modal-wide open shots-modal';
  dialog.style.zIndex = '10030';
  dialog.setAttribute('aria-hidden', 'false');

  // Build shell once — full innerHTML on every thumb click reset the left list scroll to top.
  const thumbsHtml = items.map((item, idx) => {
    return '<button type="button" class="shot-thumb" data-shot-index="' + idx + '">'
      + '<img src="' + escapeHtml(item.url) + '" alt="' + escapeHtml(item.name) + '" loading="lazy" />'
      + '<span>' + escapeHtml(classifyShotKind(item.name)) + '</span>'
      + '</button>';
  }).join('');

  dialog.innerHTML = ''
    + '<div class="modal-header">'
    + '  <div>'
    + '    <h2>运行截图</h2>'
    + '    <p class="muted">Run #' + payload.runId + ' · 共 ' + items.length + ' 张</p>'
    + '  </div>'
    + '  <button class="icon-btn" type="button" aria-label="关闭" data-close-shots-modal>'
    + '    <i data-lucide="x" class="icon-md"></i>'
    + '  </button>'
    + '</div>'
    + '<div class="modal-body shots-modal-body">'
    + '  <div class="shots-layout">'
    + '    <div class="shots-thumbs" data-shots-thumbs>' + thumbsHtml + '</div>'
    + '    <div class="shots-preview">'
    + '      <div class="shots-preview-meta">'
    + '        <strong data-shot-name></strong>'
    + '        <span class="muted" data-shot-meta></span>'
    + '      </div>'
    + '      <div class="shots-preview-frame">'
    + '        <img data-shot-preview alt="" />'
    + '      </div>'
    + '      <div class="row shots-preview-actions">'
    + '        <a data-shot-open href="#" target="_blank" rel="noopener">新窗口打开</a>'
    + '        <span class="muted" data-shot-pos></span>'
    + '      </div>'
    + '    </div>'
    + '  </div>'
    + '</div>';

  const thumbsEl = dialog.querySelector('[data-shots-thumbs]');
  const nameEl = dialog.querySelector('[data-shot-name]');
  const metaEl = dialog.querySelector('[data-shot-meta]');
  const imgEl = dialog.querySelector('[data-shot-preview]');
  const openEl = dialog.querySelector('[data-shot-open]');
  const posEl = dialog.querySelector('[data-shot-pos]');
  const thumbButtons = Array.from(dialog.querySelectorAll('[data-shot-index]'));

  const showActive = (idx, { scrollThumb = false } = {}) => {
    activeIndex = Math.max(0, Math.min(items.length - 1, Number(idx) || 0));
    const active = items[activeIndex] || items[0];
    if (!active) return;

    // Keep left list scroll position — do not rebuild thumbs DOM.
    const prevScroll = thumbsEl ? thumbsEl.scrollTop : 0;

    nameEl.textContent = active.name || '';
    metaEl.textContent = classifyShotKind(active.name) + ' · ' + formatBytes(active.size);
    if (imgEl.getAttribute('src') !== active.url) {
      imgEl.setAttribute('src', active.url);
    }
    imgEl.setAttribute('alt', active.name || '');
    openEl.setAttribute('href', active.url);
    posEl.textContent = (activeIndex + 1) + ' / ' + items.length;

    thumbButtons.forEach((btn, i) => {
      btn.classList.toggle('is-active', i === activeIndex);
    });

    if (thumbsEl) {
      if (scrollThumb) {
        const btn = thumbButtons[activeIndex];
        if (btn && typeof btn.scrollIntoView === 'function') {
          btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      } else {
        thumbsEl.scrollTop = prevScroll;
      }
    }
  };

  const close = () => {
    mask.remove();
    dialog.remove();
    document.removeEventListener('keydown', onKey);
  };

  const onKey = (ev) => {
    if (ev.key === 'Escape') {
      close();
      return;
    }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') {
      ev.preventDefault();
      showActive(activeIndex + 1, { scrollThumb: true });
    } else if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') {
      ev.preventDefault();
      showActive(activeIndex - 1, { scrollThumb: true });
    }
  };

  dialog.querySelector('[data-close-shots-modal]').addEventListener('click', close);
  thumbButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.getAttribute('data-shot-index')) || 0;
      // Keep scroll where user was; only move selection + preview.
      showActive(idx, { scrollThumb: false });
    });
  });

  document.body.appendChild(mask);
  document.body.appendChild(dialog);
  mask.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  if (window.lucide) window.lucide.createIcons({ root: dialog });
  showActive(0, { scrollThumb: false });
}

function runCard(run) {
  const screenshotHref = run.screenshot_path ? `/${run.screenshot_path.replace(/^.*?(screenshots\/)/, '$1')}` : '';
  return `
    <div class="run-card run-card-history ${run.status === 'failed' ? 'run-failed' : 'run-success'}">
      <div class="run-head">
        <strong>\u4efb\u52a1 #${run.task_id}</strong>
        <span class="run-status ${run.status}">${escapeHtml(prettyStatus(run.status))}</span>
      </div>
      <div class="run-grid compact">
        <div><span class="label">\u5f00\u59cb</span><span>${escapeHtml(shortTime(run.started_at))}</span></div>
        <div><span class="label">\u7ed3\u675f</span><span>${escapeHtml(shortTime(run.ended_at))}</span></div>
        <div><span class="label">\u9000\u51fa\u7801</span><span>${run.exit_code ?? '-'}</span></div>
        <div><span class="label">\u9519\u8bef\u7c7b\u578b</span><span>${escapeHtml(prettyErrorCode(run.error_code) || '-')}</span></div>
      </div>
      <div class="row">
        <button type="button" class="linkish" data-open-run-log="${run.id}">\u67e5\u770b\u65e5\u5fd7</button>
        ${screenshotHref ? `<a href="${screenshotHref}" target="_blank">\u67e5\u770b\u622a\u56fe</a>` : ''}
        <button type="button" class="linkish" data-open-run-shots="${run.id}">\u67e5\u770b\u622a\u56fe\u96c6</button>
      </div>
      ${run.error_text ? `<pre>${escapeHtml(run.error_text)}</pre>` : ''}
    </div>`;
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function logLineClass(line) {
  if (/(ERROR|FAIL|\u5931\u8d25|\u5f02\u5e38)/i.test(line)) return 'is-error';
  if (/(WARN|\u8b66\u544a)/i.test(line)) return 'is-warn';
  if (/(SUCCESS|\u6210\u529f|\u5b8c\u6210)/i.test(line)) return 'is-success';
  return '';
}

async function openRunLog(runId) {
  const mask = document.createElement('div');
  mask.className = 'log-drawer-mask';
  const drawer = document.createElement('section');
  drawer.className = 'log-drawer open';
  drawer.setAttribute('aria-label', `运行日志 #${runId}`);
  drawer.setAttribute('aria-busy', 'true');
  drawer.innerHTML = `
    <div class="log-drawer-header">
      <div><h2>运行日志 #${runId}</h2><p class="muted">正在读取日志，任务停止期间仍可能追加收尾日志…</p></div>
      <button class="icon-btn" type="button" aria-label="关闭" data-close-log><i data-lucide="x" class="icon-md"></i></button>
    </div>
    <div class="log-drawer-loading muted">正在加载日志…</div>
  `;
  let closed = false;
  let eventSource = null;
  const loadController = new AbortController();
  const close = () => {
    if (closed) return;
    closed = true;
    loadController.abort();
    if (eventSource) eventSource.close();
    document.removeEventListener('keydown', onKey);
    drawer.classList.remove('open'); mask.classList.remove('open');
    setTimeout(() => { drawer.remove(); mask.remove(); }, 260);
  };
  const onKey = (event) => { if (event.key === 'Escape') close(); };
  document.body.appendChild(mask);
  document.body.appendChild(drawer);
  mask.addEventListener('click', close);
  drawer.querySelector('[data-close-log]').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  requestAnimationFrame(() => { mask.classList.add('open'); });
  if (window.lucide) window.lucide.createIcons({ root: drawer });

  let res;
  try {
    res = await fetchJson(
      `/api/runs/${runId}/log?offset=0&limit=${256 * 1024}`,
      { signal: loadController.signal }
    );
  } catch (error) {
    if (closed || error.name === 'AbortError') return;
    drawer.setAttribute('aria-busy', 'false');
    const loading = drawer.querySelector('.log-drawer-loading');
    if (loading) loading.textContent = `日志加载失败：${error.message || '未知错误'}`;
    throw error;
  }
  if (closed) return;
  const data = res.data || {};
  drawer.setAttribute('aria-busy', 'false');
  drawer.innerHTML = `
    <div class="log-drawer-header">
      <div><h2>运行日志 #${runId}</h2><p class="muted" data-log-meta></p></div>
      <button class="icon-btn" type="button" aria-label="关闭" data-close-log><i data-lucide="x" class="icon-md"></i></button>
    </div>
    <div class="log-drawer-toolbar">
      <div class="log-tools">
        <input type="search" placeholder="搜索日志…" data-log-search />
        <span class="muted log-match-count" data-log-match-count></span>
        <label class="log-auto-scroll"><input type="checkbox" data-log-auto checked /> 自动滚动</label>
        <button type="button" class="alt" data-copy-log><i data-lucide="copy" class="icon-sm"></i>复制</button>
        <a class="alt btn-with-icon" href="/api/runs/${runId}/log/download" download><i data-lucide="download" class="icon-sm"></i>下载</a>
      </div>
    </div>
    <div class="log-progress muted" data-log-progress></div>
    <div class="log-terminal" data-log-terminal></div>
  `;

  const terminal = drawer.querySelector('[data-log-terminal]');
  const meta = drawer.querySelector('[data-log-meta]');
  const progress = drawer.querySelector('[data-log-progress]');
  const search = drawer.querySelector('[data-log-search]');
  const matchCount = drawer.querySelector('[data-log-match-count]');
  const autoScroll = drawer.querySelector('[data-log-auto]');

  let logText = data.content || '';
  let cursor = Number(data.nextOffset) || 0;
  let targetSize = Math.max(Number(data.size) || 0, cursor);
  let draining = false;
  let drainPromise = null;
  let finalizing = false;
  let currentStatus = data.status || '-';
  let totalLines = 0;
  let unseenOutput = false;
  let programmaticScroll = false;

  const nearBottom = () => terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 40;
  const countLines = (text) => text ? text.replace(/\n$/, '').split(/\r?\n/).length : 0;

  function updateMeta(status = currentStatus) {
    currentStatus = status || currentStatus;
    totalLines = countLines(logText);
    meta.textContent = `任务 #${data.taskId || '-'} · ${prettyStatus(currentStatus || '-')} · ${totalLines} 行`;
  }

  function updateProgress(message = '') {
    if (message) {
      progress.textContent = message;
      return;
    }
    if (unseenOutput && !autoScroll.checked) {
      progress.textContent = '有新日志 · 勾选自动滚动或滚到底部查看';
      return;
    }
    progress.textContent = draining ? `正在同步日志… ${formatBytes(cursor)} / ${formatBytes(targetSize)}` : '';
  }

  function render({ forceFollow = false } = {}) {
    if (closed) return;
    const shouldFollow = forceFollow || (autoScroll.checked && nearBottom());
    const query = search.value.trim().toLowerCase();
    const visible = logText.replace(/\n$/, '');
    const lines = visible ? visible.split('\n') : [''];
    let matches = 0;
    terminal.innerHTML = lines.map((line, index) => {
      const match = query && line.toLowerCase().includes(query);
      if (match) matches += 1;
      return `<div class="log-line ${logLineClass(line)}${match ? ' is-match' : ''}"><span class="log-line-no">${index + 1}</span><span class="log-line-text">${escapeHtml(line) || ' '}</span></div>`;
    }).join('');
    matchCount.textContent = query ? `${matches} 个匹配` : '';
    updateMeta();
    if (shouldFollow) {
      programmaticScroll = true;
      terminal.scrollTop = terminal.scrollHeight;
      requestAnimationFrame(() => { programmaticScroll = false; });
      unseenOutput = false;
    }
    updateProgress();
  }

  function appendLog(text) {
    if (!text) return;
    unseenOutput = !autoScroll.checked || !nearBottom();
    logText += text;
    render();
  }

  async function drainToTarget() {
    if (closed) return;
    if (drainPromise) return drainPromise;
    draining = true;
    drainPromise = (async () => {
      updateProgress();
      try {
        while (!closed && cursor < targetSize) {
          const requestedTarget = targetSize;
          const chunkRes = await fetchJson(`/api/runs/${runId}/log?offset=${cursor}&limit=${256 * 1024}`);
          if (closed) return;
          const chunk = chunkRes.data || {};
          const nextOffset = Number(chunk.nextOffset);
          if (!Number.isFinite(nextOffset) || nextOffset <= cursor) {
            targetSize = Math.min(targetSize, Number(chunk.size) || requestedTarget);
            break;
          }
          appendLog(chunk.content || '');
          cursor = nextOffset;
          targetSize = Math.max(targetSize, Number(chunk.size) || cursor);
          updateProgress();
        }
      } catch (error) {
        if (!closed) progress.textContent = error.message || '日志同步失败，等待重连';
      } finally {
        draining = false;
        drainPromise = null;
        updateProgress();
      }
    })();
    return drainPromise;
  }

  function requestCatchUp(size) {
    const nextSize = Number(size);
    if (Number.isFinite(nextSize) && nextSize > targetSize) targetSize = nextSize;
    if (cursor < targetSize) return drainToTarget();
    return Promise.resolve();
  }

  async function finalize(payload = {}) {
    if (finalizing || closed) return;
    finalizing = true;
    try {
      const finalSize = Number(payload.size);
      if (Number.isFinite(finalSize)) targetSize = Math.max(targetSize, finalSize);
      await drainToTarget();
      const finalRes = await fetchJson(`/api/runs/${runId}/log?tail=20`);
      if (closed) return;
      const finalData = finalRes.data || {};
      const reconciledSize = Number(finalData.size);
      if (Number.isFinite(reconciledSize) && reconciledSize > targetSize) {
        targetSize = reconciledSize;
        await drainToTarget();
      }
      currentStatus = payload.status || finalData.status || currentStatus;
      updateMeta();
      render();
      if (eventSource) eventSource.close();
    } catch (error) {
      if (!closed) progress.textContent = error.message || '最终日志同步失败，可关闭后重新打开';
    } finally {
      finalizing = false;
    }
  }

  drawer.querySelector('[data-close-log]').addEventListener('click', close);
  search.addEventListener('input', () => render());
  drawer.querySelector('[data-copy-log]').addEventListener('click', async () => {
    try { await copyText(logText); toast('日志已复制', 'success'); }
    catch { toast('复制失败，请手动选择日志', 'error'); }
  });
  autoScroll.addEventListener('change', () => {
    if (autoScroll.checked) {
      unseenOutput = false;
      render({ forceFollow: true });
    } else {
      updateProgress();
    }
  });
  terminal.addEventListener('scroll', () => {
    const atBottom = nearBottom();
    if (!programmaticScroll && !atBottom) autoScroll.checked = false;
    if (atBottom) {
      autoScroll.checked = true;
      unseenOutput = false;
      updateProgress();
    }
  });

  eventSource = new EventSource(`/api/runs/${runId}/log/stream?offset=${cursor}`);
  eventSource.addEventListener('ready', (event) => {
    const payload = JSON.parse(event.data || '{}');
    requestCatchUp(payload.size);
  });
  eventSource.addEventListener('log', (event) => {
    const payload = JSON.parse(event.data || '{}');
    requestCatchUp(payload.size);
  });
  eventSource.addEventListener('end', (event) => {
    const payload = JSON.parse(event.data || '{}');
    finalize(payload);
  });

  render({ forceFollow: true });
  requestCatchUp(targetSize);
  if (window.lucide) window.lucide.createIcons({ root: drawer });
}
function openTaskRunsLoadingModal(id) {
  const task = tasksCache.find(item => Number(item.id) === Number(id));
  const mask = document.createElement('div');
  mask.className = 'modal-mask open';
  mask.style.zIndex = '9999';

  const dialog = document.createElement('section');
  dialog.className = 'modal modal-wide open runs-modal';
  dialog.style.zIndex = '10000';
  dialog.setAttribute('aria-hidden', 'false');
  dialog.setAttribute('aria-busy', 'true');
  dialog.innerHTML = `
    <div class="modal-header">
      <div>
        <h2>运行记录</h2>
        <p class="muted">任务 #${id}${task?.name ? ` · ${escapeHtml(task.name)}` : ''}</p>
      </div>
      <button class="icon-btn" type="button" aria-label="关闭" data-close-runs-modal>
        <i data-lucide="x" class="icon-md"></i>
      </button>
    </div>
    <div class="modal-body runs-modal-body">
      <p class="muted">正在加载运行记录…</p>
    </div>
  `;

  let closed = false;
  const controller = new AbortController();
  const close = () => {
    if (closed) return;
    closed = true;
    controller.abort();
    mask.remove();
    dialog.remove();
  };
  document.body.appendChild(mask);
  document.body.appendChild(dialog);
  mask.addEventListener('click', close);
  dialog.querySelector('[data-close-runs-modal]').addEventListener('click', close);
  if (window.lucide) window.lucide.createIcons({ root: dialog });
  return { controller, isClosed: () => closed, close };
}

async function showTaskRuns(id) {
  const loadingModal = openTaskRunsLoadingModal(id);
  try {
    const data = await fetchJson(`/api/tasks/${id}/runs`, { signal: loadingModal.controller.signal });
    if (loadingModal.isClosed()) return;
    loadingModal.close();
    openTaskRunsModal(id, data.data || []);
  } catch (error) {
    if (loadingModal.isClosed() || error.name === 'AbortError') return;
    loadingModal.close();
    toast(error.message || '加载运行记录失败', 'error');
  }
}

function openTaskRunsModal(id, runs) {
  const task = tasksCache.find(item => Number(item.id) === Number(id));
  const mask = document.createElement('div');
  mask.className = 'modal-mask open';
  mask.style.zIndex = '9999';

  const dialog = document.createElement('section');
  dialog.className = 'modal modal-wide open runs-modal';
  dialog.style.zIndex = '10000';
  dialog.setAttribute('aria-hidden', 'false');

  const bodyHtml = runs.length
    ? runs.map(runCard).join('')
    : '<p class="empty">\u8fd9\u4e2a\u4efb\u52a1\u8fd8\u6ca1\u6709\u8fd0\u884c\u8bb0\u5f55\u3002</p>';

  dialog.innerHTML = `
    <div class="modal-header">
      <div>
        <h2>\u8fd0\u884c\u8bb0\u5f55</h2>
        <p class="muted">\u4efb\u52a1 #${id}${task?.name ? ` · ${escapeHtml(task.name)}` : ''}</p>
      </div>
      <button class="icon-btn" type="button" aria-label="\u5173\u95ed" data-close-runs-modal>
        <i data-lucide="x" class="icon-md"></i>
      </button>
    </div>
    <div class="modal-body runs-modal-body">
      <div class="runs-modal-list">${bodyHtml}</div>
    </div>
  `;

  const close = () => {
    mask.remove();
    dialog.remove();
  };

  document.body.appendChild(mask);
  document.body.appendChild(dialog);
  mask.addEventListener('click', close);
  dialog.querySelector('[data-close-runs-modal]').addEventListener('click', close);
  dialog.querySelectorAll('[data-open-run-shots]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const runId = Number(btn.getAttribute('data-open-run-shots'));
      try {
        await openRunScreenshots(runId);
      } catch (error) {
        toast(error.message || '加载截图失败', 'error');
      }
    });
  });
  dialog.querySelectorAll('[data-open-run-log]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      const runId = Number(btn.getAttribute('data-open-run-log'));
      btn.disabled = true;
      try {
        await openRunLog(runId);
      } catch (error) {
        toast(error.message || '加载日志失败', 'error');
      } finally {
        btn.disabled = false;
      }
    });
  });
  if (window.lucide) window.lucide.createIcons({ root: dialog });
}

// task.latest_run 是服务端按任务单独查出来的，跨度多久都在；lastRunsByTask 只是
// /api/runs 最近 100 条的兜底，低频任务会被别的任务挤出这个窗口。
function latestRunSummary(taskId, task = null) {
  const run = (task && task.latest_run) || lastRunsByTask.get(taskId);
  if (!run) return { status: '未运行', detail: '还没有运行记录', className: 'idle' };
  return {
    status: prettyStatus(run.status),
    detail: run.error_code ? prettyErrorCode(run.error_code) : `最近：${shortTime(run.started_at)}`,
    className: run.status === 'success' ? 'success' : run.status === 'failed' ? 'failed' : 'idle',
  };
}

function taskCard(task, groupName = '') {
  const isRunning = taskIsRunning(task);
  const latest = latestRunSummary(task.id, task);
  const isPersistent = Boolean(Number(task.use_persistent));
  const profileName = (() => {
    if (!task.browser_profile_id) return isPersistent ? '默认配置' : '每次全新';
    const p = profilesCache.find((x) => Number(x.id) === Number(task.browser_profile_id));
    return p ? p.name : `#${task.browser_profile_id}`;
  })();
  const profileMode = isPersistent ? '持久' : '临时';
  const profileTitle = isPersistent
    ? `持久浏览器配置 · ${profileName}`
    : `临时（跑完删除）· ${profileName}`;
  const scheduleOn = Boolean(Number(task.enabled));
  const conditionOn = Boolean(Number(task.condition_enabled));
  const scheduleModeLabel = task.schedule_mode === 'daily_window'
    ? '每天时段'
    : (task.schedule_mode === 'interval' ? '随机区间' : '固定周期');
  // Schedule / HTTP / remaining-callback are treated as one "trigger" slot (mutually exclusive UI).
  // Prefer condition when enabled; otherwise show schedule. Never side-by-side.
  let triggerMetric = '';
  if (conditionOn) {
    triggerMetric = `<div class="metric-card metric-condition" title="${escapeHtml(describeConditionValueFull(task) || describeCondition(task) || '')}">
          <span class="metric-label">条件</span>
          <div class="status-indicator">
            <span class="dot ${conditionStatusClass(task)}"></span>
            <span>${escapeHtml(describeCondition(task) || '已启用')}</span>
          </div>
          <span class="metric-value">${escapeHtml(describeConditionValue(task))}</span>
        </div>`;
  } else if (scheduleOn) {
    triggerMetric = `<div class="metric-card metric-schedule" title="${escapeHtml(describeNextRun(task) || '')}">
          <span class="metric-label">定时</span>
          <div class="status-indicator">
            <span class="dot active"></span>
            <span>${escapeHtml(scheduleModeLabel)}</span>
          </div>
          <span class="metric-value">${escapeHtml(describeNextRun(task))}</span>
        </div>`;
  }
  const backupSelected = selectedBackupTaskIds.has(Number(task.id));
  const backupClass = backupSelectionMode
    ? ` backup-selectable${backupSelected ? ' backup-selected' : ''}`
    : '';
  return `
    <article class="task-card ${isRunning ? 'task-running' : ''}${backupClass}" data-testid="task-card" data-task-id="${task.id}" ${backupSelectionMode ? `onclick="toggleBackupTask(${task.id}, event)"` : ''}>
      ${backupSelectionMode ? `<input class="backup-task-check" type="checkbox" ${backupSelected ? 'checked' : ''} aria-label="选择任务 ${escapeHtml(task.name)}" />` : ''}
      <div class="task-card-top">
        <div class="task-card-head-main">
          <div class="task-title-row">
            <h3 title="${escapeHtml(task.name)}">${escapeHtml(task.name)}</h3>
            <span class="pill pill-type">${escapeHtml(task.type)}</span>
            ${isRunning ? '<span class="pill pill-running">运行中</span>' : ''}
          </div>
          <div class="task-profile-slot" title="${escapeHtml(profileTitle)}">
            <span class="pill ${isPersistent ? 'pill-persistent' : 'pill-temp'} task-profile-pill">
              ${escapeHtml(profileMode)} · ${escapeHtml(profileName)}
            </span>
            ${groupName ? `<span class="pill pill-group task-group-pill" title="分组：${escapeHtml(groupName)}">${escapeHtml(groupName)}</span>` : ''}
          </div>
        </div>
        <div class="task-overflow" data-task-action-area>
          <button type="button" class="icon-btn task-overflow-trigger" data-task-overflow-trigger aria-expanded="false" aria-controls="task-overflow-${task.id}" aria-label="打开 ${escapeHtml(task.name)} 的更多操作" ${backupSelectionMode ? 'disabled' : ''}>
            <i data-lucide="ellipsis" class="icon-sm"></i>
          </button>
          <div id="task-overflow-${task.id}" class="task-overflow-panel" data-task-overflow-panel hidden>
            <button type="button" class="task-overflow-item" onclick="editTask(${task.id})" ${isRunning ? 'disabled' : ''} data-testid="edit-task-btn">
              <i data-lucide="pencil" class="icon-sm"></i> 编辑
            </button>
            <button type="button" class="task-overflow-item" onclick="showTaskRuns(${task.id})">
              <i data-lucide="history" class="icon-sm"></i> 记录
            </button>
            <button type="button" class="task-overflow-item task-overflow-danger" onclick="deleteTask(${task.id})" ${isRunning ? 'disabled' : ''} data-testid="delete-task-btn">
              <i data-lucide="trash-2" class="icon-sm"></i> 删除
            </button>
          </div>
        </div>
      </div>
      <div class="task-metrics">
        <div class="metric-card ${latest.className}" title="${escapeHtml(latest.detail || '')}">
          <span class="metric-label">最新结果</span>
          <div class="status-indicator">
            <span class="dot ${latest.className}"></span>
            <span data-testid="task-status">${escapeHtml(latest.status)}</span>
          </div>
          <span class="metric-value">${escapeHtml(latest.detail)}</span>
        </div>
        ${triggerMetric}
      </div>
      <div class="task-actions" data-task-action-area>
        ${isRunning
          ? `<button class="task-primary-action task-stop-action" onclick="stopTask(${task.id})" ${backupSelectionMode ? 'disabled' : ''} data-testid="stop-task-btn"><i data-lucide="square" class="icon-sm"></i> 停止</button>`
          : `<button class="task-primary-action" onclick="runTask(${task.id})" ${backupSelectionMode ? 'disabled' : ''} data-testid="run-task-btn"><i data-lucide="play" class="icon-sm"></i> 启动</button>`}
      </div>
    </article>`;
}

function setBackupSelectionMode(enabled) {
  backupSelectionMode = Boolean(enabled);
  if (!backupSelectionMode) selectedBackupTaskIds.clear();
  if (backupSelectionBar) backupSelectionBar.hidden = !backupSelectionMode;
  if (backupSelectBtn) backupSelectBtn.innerHTML = backupSelectionMode
    ? '<i data-lucide="x" class="icon-sm"></i> 退出选择'
    : '<i data-lucide="archive" class="icon-sm"></i> 备份';
  updateBackupSelectionUi();
  lastTasksHtml = null;
  renderTasks();
  if (window.lucide) window.lucide.createIcons();
}

function updateBackupSelectionUi() {
  const available = tasksCache.length;
  const count = selectedBackupTaskIds.size;
  if (backupSelectionCount) backupSelectionCount.textContent = `已选择 ${count} 个任务`;
  if (backupExportBtn) backupExportBtn.disabled = count === 0;
  if (backupSelectAll) {
    backupSelectAll.checked = available > 0 && count === available;
    backupSelectAll.indeterminate = count > 0 && count < available;
  }
}

window.toggleBackupTask = function toggleBackupTask(id, event) {
  if (!backupSelectionMode) return;
  if (event && event.target && event.target.closest('[data-task-action-area]')) return;
  const taskId = Number(id);
  if (selectedBackupTaskIds.has(taskId)) selectedBackupTaskIds.delete(taskId);
  else selectedBackupTaskIds.add(taskId);
  updateBackupSelectionUi();
  lastTasksHtml = null;
  renderTasks();
}

function closeBackupAssetsModal() {
  const modal = document.getElementById('backup-assets-modal');
  const mask = document.getElementById('backup-assets-mask');
  if (modal) { modal.classList.remove('open'); modal.hidden = true; modal.innerHTML = ''; }
  if (mask) mask.hidden = true;
}

/**
 * 导出前的附加模块确认。扫描是预填，勾选才算数 —— 脚本自己改 sys.path 再 import
 * 的写法静态分析看不见，得让用户有机会看一眼再决定带什么。
 */
function showBackupAssetsModal(rows, onConfirm) {
  const modal = document.getElementById('backup-assets-modal');
  const mask = document.getElementById('backup-assets-mask');
  if (!modal) { onConfirm(null); return; }

  const state = rows.map((row) => ({
    ...row,
    checked: new Set(row.paths),
  }));

  const render = () => {
    const total = state.reduce((sum, row) => sum + row.checked.size, 0);
    modal.innerHTML = `
      <div class="modal-panel backup-assets-panel">
        <div class="modal-header" style="padding:18px 22px;">
          <div>
            <h2 style="margin:0;">附加模块</h2>
            <p class="muted" style="margin:3px 0 0;">勾选的目录会跟主脚本一起打包。只影响这次备份，不影响运行。</p>
          </div>
          <button type="button" class="icon-btn" data-assets-close aria-label="关闭">关闭</button>
        </div>
        <div class="modal-body" style="padding:22px;">
          ${state.map((row, ri) => `
            <div class="backup-assets-task">
              <div class="backup-assets-task-head">
                <strong>${escapeHtml(row.name)}</strong>
                <code class="muted">${escapeHtml(row.script_path || '')}</code>
              </div>
              ${row.error ? `<p class="muted" style="margin:4px 0 0;font-size:12px;">扫描失败：${escapeHtml(row.error)}</p>` : ''}
              ${row.paths.length ? `
                <div class="backup-assets-list">
                  ${row.paths.map((p, pi) => `
                    <label class="inline-check">
                      <input type="checkbox" data-assets-row="${ri}" data-assets-path="${pi}" ${row.checked.has(p) ? 'checked' : ''} />
                      <code>${escapeHtml(p)}</code>
                      ${row.declared.includes(p) ? '<span class="muted" style="font-size:11px;">已声明</span>' : '<span class="muted" style="font-size:11px;">扫描发现</span>'}
                    </label>`).join('')}
                </div>` : '<p class="muted" style="margin:4px 0 0;font-size:12px;">没扫到 tasks/ 下的本地模块，只带主脚本。</p>'}
            </div>`).join('')}
          <div class="backup-import-actions">
            <span class="muted" style="margin-right:auto;">共选中 ${total} 项</span>
            <button type="button" class="alt" data-assets-close>取消</button>
            <button type="button" data-assets-confirm><i data-lucide="download" class="icon-sm"></i>确认并导出</button>
          </div>
        </div>
      </div>`;

    modal.querySelectorAll('[data-assets-row]').forEach((box) => {
      box.addEventListener('change', () => {
        const row = state[Number(box.dataset.assetsRow)];
        const p = row.paths[Number(box.dataset.assetsPath)];
        if (box.checked) row.checked.add(p);
        else row.checked.delete(p);
        render();
      });
    });
    modal.querySelectorAll('[data-assets-close]').forEach((btn) => {
      btn.addEventListener('click', () => closeBackupAssetsModal());
    });
    const confirmBtn = modal.querySelector('[data-assets-confirm]');
    if (confirmBtn) confirmBtn.addEventListener('click', () => {
      const selection = state.map((row) => ({ id: row.id, paths: [...row.checked].sort() }));
      closeBackupAssetsModal();
      onConfirm(selection);
    });
    if (window.lucide) window.lucide.createIcons({ root: modal });
  };

  render();
  modal.hidden = false;
  modal.classList.add('open');
  if (mask) mask.hidden = false;
}

// 把确认后的勾选写回任务，下次导出就是默认值，不用重复勾。
// 走独立接口而不是 PUT /api/tasks/:id —— 后者是整行替换，只发一个字段会把
// 任务名、定时、浏览器配置全写成默认值。
async function persistExtraPaths(selection) {
  const tasks = (selection || [])
    .map((row) => ({ id: Number(row.id), paths: row.paths }))
    .filter((row) => Number.isInteger(row.id) && row.id > 0);
  if (!tasks.length) return;
  try {
    await fetchJson('/api/backup/save-assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks }),
    });
  } catch (error) {
    toast(`附加模块保存失败：${error.message || ''}（本次导出仍会带上勾选内容）`, 'warn');
  }
}

async function startBackupExport(ids, passphrase) {
  let rows = null;
  try {
    const data = await fetchJson('/api/backup/scan-assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_ids: ids }),
    });
    rows = Array.isArray(data.data) ? data.data : [];
  } catch (error) {
    // 扫描挂了不该挡住导出 —— 退回到按已声明内容打包。
    toast(`依赖扫描失败：${error.message || ''}，按已声明的模块导出`, 'warn');
    await downloadBackup(ids, passphrase);
    return;
  }

  // 没有任何模块可选就别弹窗打扰，直接导。
  if (!rows.some((row) => row.paths.length)) {
    await downloadBackup(ids, passphrase);
    return;
  }

  showBackupAssetsModal(rows, async (selection) => {
    if (!selection) return;
    await persistExtraPaths(selection);
    await loadTasks();
    await downloadBackup(ids, passphrase);
  });
}

async function downloadBackup(taskIds, passphrase) {
  try {
    const body = {};
    if (taskIds && taskIds.length) body.task_ids = taskIds.join(',');
    if (passphrase) body.passphrase = passphrase;

    const res = await fetch('/api/backup/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401) { goLogin(); return; }
    if (!res.ok) {
      let message = '导出失败';
      try {
        const err = JSON.parse(await res.text());
        message = err.message || message;
      } catch {}
      throw new Error(message);
    }
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const utf8Match = disposition.match(/filename\*=UTF-8''([^;\n]+)/i);
    const basicMatch = disposition.match(/filename="?([^";\n]+)"?/i);
    let filename = passphrase ? 'backup.bpenc' : 'backup.json';
    if (utf8Match) {
      try {
        filename = decodeURIComponent(utf8Match[1]);
      } catch {
        filename = basicMatch ? basicMatch[1] : filename;
      }
    } else if (basicMatch) {
      filename = basicMatch[1];
    }

    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);

    // 退出选择模式
    setBackupSelectionMode(false);
  } catch (error) {
    toast(error.message || '导出备份失败', 'error');
  }
}

function closeBackupImportModal() {
  if (!backupImportModal) return;
  backupImportModal.classList.remove('open');
  backupImportModal.hidden = true;
  if (backupImportMask) backupImportMask.hidden = true;
  backupImportModal.innerHTML = '';
  pendingBackupPayload = null;
}

function showBackupImportModal(plan) {
  if (!backupImportModal) return;
  const conflicts = [
    ...plan.scripts.filter((item) => ['overwrite', 'rename', 'skip'].includes(item.action)).map((item) => `脚本 ${item.path}：${item.action}`),
    ...plan.tasks.filter((item) => ['overwrite', 'rename', 'skip'].includes(item.action)).map((item) => `任务「${item.name}」：${item.action}`),
  ];
  const warningList = [
    ...(plan.warnings || []),
    ...(plan.names_only ? ['此备份只包含变量名，导入后需要手动补填所有变量值'] : []),
  ];
  backupImportModal.innerHTML = `
    <div class="modal-panel backup-import-panel">
      <div class="modal-header" style="padding:18px 22px;">
        <div><h2 style="margin:0;">恢复任务备份</h2><p class="muted" style="margin:3px 0 0;">导入后任务默认停用，请确认冲突处理方式。</p></div>
        <button type="button" class="icon-btn" data-backup-close aria-label="关闭">关闭</button>
      </div>
      <div class="modal-body" style="padding:22px;">
        <div class="backup-import-summary">
          <div class="backup-summary-card"><strong>${plan.tasks.length}</strong><span class="muted">任务</span></div>
          <div class="backup-summary-card"><strong>${plan.scripts.length}</strong><span class="muted">脚本</span></div>
          <div class="backup-summary-card"><strong>${plan.profiles.length}</strong><span class="muted">浏览器配置</span></div>
        </div>
        <div class="two-col-modal" style="grid-template-columns:1fr 1fr;">
          <label>任务重名处理<select id="backup-task-strategy"><option value="rename">重命名导入</option><option value="overwrite">覆盖已有任务</option><option value="skip">跳过重名任务</option></select></label>
          <label>脚本冲突处理<select id="backup-script-strategy"><option value="skip">跳过已有脚本</option><option value="overwrite">覆盖已有脚本</option><option value="rename">重命名脚本</option></select></label>
        </div>
        ${conflicts.length ? `<h4>冲突摘要</h4><ul class="backup-conflict-list">${conflicts.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '<p class="muted">没有发现文件或任务冲突。</p>'}
        ${warningList.length ? `<h4 class="backup-warning">导入提示</h4><ul class="backup-conflict-list backup-warning">${warningList.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
        <div class="backup-import-actions"><button type="button" class="alt" data-backup-close>取消</button><button type="button" data-backup-confirm><i data-lucide="upload" class="icon-sm"></i>确认导入</button></div>
      </div>
    </div>`;
  backupImportModal.hidden = false;
  if (backupImportMask) backupImportMask.hidden = false;
  backupImportModal.classList.add('open');
  backupImportModal.querySelectorAll('[data-backup-close]').forEach((button) => button.addEventListener('click', closeBackupImportModal));
  backupImportModal.querySelector('[data-backup-confirm]').addEventListener('click', importPendingBackup);
  if (window.lucide) window.lucide.createIcons({ root: backupImportModal });
}

async function previewBackupPayload(backup, passphrase = null) {
  const data = await fetchJson('/api/backup/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backup, passphrase }),
  });
  pendingBackupPayload = { backup, passphrase };
  showBackupImportModal(data.data);
}

async function previewBackupFile(file) {
  const text = await file.text();
  if (!text.trim()) throw new Error('备份文件为空');

  if (text.trimStart().startsWith('bp-enc$')) {
    dialogPassphraseOnce('这是加密备份，请输入导出时设置的密码。', async (passphrase) => {
      try {
        await previewBackupPayload(text.trim(), passphrase);
      } catch (error) {
        toast(error.message || '解析加密备份失败', 'error');
      }
    });
    return;
  }

  let backup;
  try { backup = JSON.parse(text); } catch { throw new Error('备份文件不是合法 JSON 或加密备份'); }
  await previewBackupPayload(backup);
}

async function importPendingBackup() {
  if (!pendingBackupPayload) return;
  const taskStrategy = backupImportModal.querySelector('#backup-task-strategy').value;
  const scriptStrategy = backupImportModal.querySelector('#backup-script-strategy').value;
  const confirmButton = backupImportModal.querySelector('[data-backup-confirm]');
  confirmButton.disabled = true;
  try {
    const data = await fetchJson('/api/backup/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        backup: pendingBackupPayload.backup,
        passphrase: pendingBackupPayload.passphrase,
        task_strategy: taskStrategy,
        script_strategy: scriptStrategy,
      }),
    });
    closeBackupImportModal();
    toast(`备份已导入：新增 ${data.data.created.length} 个任务`, 'success');
    await refreshAll();
  } catch (error) {
    confirmButton.disabled = false;
    toast(error.message || '导入备份失败', 'error');
  }
}

function renderScripts() {
  if (!scriptSelectEl) return;
  const options = ['<option value="">请选择脚本</option>'];
  for (const script of scriptsCache) {
    const selected = selectedScriptPath === script.path ? ' selected' : '';
    options.push(`<option value="${escapeHtml(script.path)}" data-type="${escapeHtml(script.type)}"${selected}>${escapeHtml(script.name)} (${escapeHtml(script.type)})</option>`);
  }
  scriptSelectEl.innerHTML = options.join('');
}

async function loadScripts() {
  const data = await fetchJson('/api/scripts');
  scriptsCache = data.data;
  renderScripts();
}

let taskGroupsCache = [];
const TASK_GROUP_FILTER_KEY = 'browser-panel.task-group-filter';
// 只保存"当前看哪一组"，是纯浏览器偏好，坏了就退回"全部"，不影响任务本身。
let taskGroupFilter = loadTaskGroupFilter();

function loadTaskGroupFilter() {
  try {
    const value = localStorage.getItem(TASK_GROUP_FILTER_KEY);
    return typeof value === 'string' && value ? value : 'all';
  } catch { return 'all'; }
}

function saveTaskGroupFilter(key) {
  try { localStorage.setItem(TASK_GROUP_FILTER_KEY, key); } catch {}
}

function renderTaskGroupOptions(select, selected = '') {
  if (!select) return;
  select.innerHTML = '<option value="">未分组</option>' + taskGroupsCache
    .map((group) => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`).join('');
  select.value = selected == null ? '' : String(selected);
}

async function loadTaskGroups() {
  const data = await fetchJson('/api/task-groups');
  taskGroupsCache = Array.isArray(data.data) ? data.data : [];
  renderTaskGroupOptions(document.getElementById('task-group-select'), document.getElementById('task-group-select')?.value || '');
}

function taskIsRunning(task) {
  return !stoppingTaskIds.has(task.id) && (runningTaskIds.has(task.id) || Boolean(task.is_running));
}

window.selectTaskGroup = function selectTaskGroup(key) {
  taskGroupFilter = key;
  saveTaskGroupFilter(key);
  lastTasksHtml = null;
  renderTasks();
};

function openTaskGroupsModal() {
  const modalEl = document.getElementById('task-groups-modal');
  const mask = document.getElementById('task-groups-mask');
  if (!modalEl) return;
  modalEl.hidden = false; modalEl.classList.add('open'); modalEl.setAttribute('aria-hidden', 'false');
  if (mask) mask.hidden = false;
  renderTaskGroupsManager();
}

function closeTaskGroupsModal() {
  const modalEl = document.getElementById('task-groups-modal');
  const mask = document.getElementById('task-groups-mask');
  if (!modalEl) return;
  modalEl.classList.remove('open'); modalEl.hidden = true; modalEl.setAttribute('aria-hidden', 'true');
  if (mask) mask.hidden = true;
}

function renderTaskGroupsManager() {
  const list = document.getElementById('task-groups-list');
  if (!list) return;
  list.innerHTML = taskGroupsCache.map((group, index) => `<div class="task-group-manage-row">
    <input value="${escapeHtml(group.name)}" data-group-name="${group.id}" maxlength="60" />
    <button type="button" class="alt" data-group-save="${group.id}">保存</button>
    <button type="button" class="icon-btn" data-group-up="${group.id}" aria-label="上移" ${index === 0 ? 'disabled' : ''}>↑</button>
    <button type="button" class="icon-btn" data-group-down="${group.id}" aria-label="下移" ${index === taskGroupsCache.length - 1 ? 'disabled' : ''}>↓</button>
    <button type="button" class="icon-btn danger" data-group-delete="${group.id}" aria-label="删除">×</button>
  </div>`).join('') || '<p class="empty">还没有自定义分组。</p>';
}

async function saveTaskGroupOrder(ids) {
  await fetchJson('/api/task-groups/order', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ ids }) });
  await loadTaskGroups(); renderTaskGroupsManager(); renderTasks();
}

document.getElementById('manage-groups-btn')?.addEventListener('click', openTaskGroupsModal);
document.getElementById('task-groups-close')?.addEventListener('click', closeTaskGroupsModal);
document.getElementById('task-groups-mask')?.addEventListener('click', closeTaskGroupsModal);
document.getElementById('task-group-create-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  try { await fetchJson('/api/task-groups', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name: event.target.name.value }) }); event.target.reset(); await loadTaskGroups(); renderTaskGroupsManager(); renderTasks(); } catch (error) { toast(error.message, 'error'); }
});
document.getElementById('task-groups-list')?.addEventListener('click', async (event) => {
  const button = event.target.closest('button'); if (!button) return;
  const id = Number(button.dataset.groupSave || button.dataset.groupUp || button.dataset.groupDown || button.dataset.groupDelete);
  if (!id) return;
  try {
    if (button.dataset.groupSave) await fetchJson(`/api/task-groups/${id}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name: document.querySelector(`[data-group-name="${id}"]`).value }) });
    else if (button.dataset.groupDelete) { if (!window.confirm('删除分组后，其中的任务会移动到“未分组”，不会删除任务。')) return; await fetchJson(`/api/task-groups/${id}`, { method:'DELETE' }); }
    else { const ids = taskGroupsCache.map((g) => Number(g.id)); const index = ids.indexOf(id); const target = button.dataset.groupUp ? index - 1 : index + 1; [ids[index], ids[target]] = [ids[target], ids[index]]; await saveTaskGroupOrder(ids); return; }
    await loadTaskGroups(); renderTaskGroupsManager(); renderTasks();
  } catch (error) { toast(error.message, 'error'); }
});

// 分组只当作筛选维度，不再每组一块独立网格：
// 分组多的时候纵向堆叠会把整屏占满，而且每块网格按自己的宽度算列数，
// 任务少的组会把卡片拉宽变形。这里统一成"一条筛选栏 + 一张网格"。
function renderTaskGroups() {
  const groupOf = new Map();
  for (const group of taskGroupsCache) groupOf.set(Number(group.id), group);
  // 分组被删掉（或分组还没加载完）时旧的筛选键会失效，本次渲染按"全部"处理。
  // 只算局部值、不回写 taskGroupFilter：加载时序导致的空缓存不应该抹掉用户的选择。
  let active = taskGroupFilter;
  if (active !== 'all' && active !== 'ungrouped'
    && !groupOf.has(Number(String(active).replace('group:', '')))) {
    active = 'all';
  }
  const ungrouped = tasksCache.filter((task) => !task.group_id);
  const chips = [`<button type="button" class="task-group-chip${active === 'all' ? ' is-active' : ''}" onclick="selectTaskGroup('all')" aria-pressed="${active === 'all'}">全部 <span>${tasksCache.length}</span></button>`];
  for (const group of taskGroupsCache) {
    const key = `group:${group.id}`;
    const tasks = tasksCache.filter((task) => Number(task.group_id) === Number(group.id));
    const running = tasks.filter(taskIsRunning).length;
    chips.push(`<button type="button" class="task-group-chip${active === key ? ' is-active' : ''}" onclick="selectTaskGroup('${key}')" aria-pressed="${active === key}" title="${escapeHtml(group.name)}：${tasks.length} 个任务，运行 ${running}">${escapeHtml(group.name)} <span>${tasks.length}</span>${running ? '<span class="task-group-dot"></span>' : ''}</button>`);
  }
  if (ungrouped.length) {
    chips.push(`<button type="button" class="task-group-chip${active === 'ungrouped' ? ' is-active' : ''}" onclick="selectTaskGroup('ungrouped')" aria-pressed="${active === 'ungrouped'}">未分组 <span>${ungrouped.length}</span></button>`);
  }
  let visible = tasksCache;
  if (active === 'ungrouped') visible = ungrouped;
  else if (active !== 'all') {
    const id = Number(String(active).replace('group:', ''));
    visible = tasksCache.filter((task) => Number(task.group_id) === id);
  }
  // 只有存在用户分组时才占用筛选栏那一行高度。
  const bar = taskGroupsCache.length
    ? `<div class="task-group-bar" role="group" aria-label="任务分组筛选">${chips.join('')}</div>`
    : '';
  // "全部"视图下给卡片补一个所属分组角标，否则混在一起看不出归属。
  const showBadge = active === 'all' && taskGroupsCache.length > 0;
  const cards = visible.map((task) => {
    const group = showBadge ? groupOf.get(Number(task.group_id)) : null;
    return taskCard(task, group ? group.name : '');
  }).join('');
  const empty = active === 'all'
    ? '<p class="empty">当前还没有任务。</p>'
    : '<p class="empty">当前分组没有任务。</p>';
  return `${bar}<div class="task-grid">${cards || empty}</div>`;
}

let lastTasksHtml = null;
let openTaskOverflowTrigger = null;

function closeTaskOverflow({ restoreFocus = false } = {}) {
  if (!openTaskOverflowTrigger) return;
  const trigger = openTaskOverflowTrigger;
  const panelId = trigger.getAttribute('aria-controls');
  const panel = panelId ? document.getElementById(panelId) : null;
  trigger.setAttribute('aria-expanded', 'false');
  if (panel) panel.hidden = true;
  openTaskOverflowTrigger = null;
  if (restoreFocus && trigger.isConnected) trigger.focus();
}

function openTaskOverflow(trigger) {
  if (openTaskOverflowTrigger === trigger) {
    closeTaskOverflow({ restoreFocus: true });
    return;
  }
  closeTaskOverflow();
  const panelId = trigger.getAttribute('aria-controls');
  const panel = panelId ? document.getElementById(panelId) : null;
  if (!panel) return;
  trigger.setAttribute('aria-expanded', 'true');
  panel.hidden = false;
  openTaskOverflowTrigger = trigger;
  requestAnimationFrame(() => panel.querySelector('button:not(:disabled)')?.focus());
}

tasksEl?.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-task-overflow-trigger]');
  if (trigger) {
    event.stopPropagation();
    openTaskOverflow(trigger);
    return;
  }
  if (event.target.closest('[data-task-overflow-panel]')) closeTaskOverflow();
});

document.addEventListener('click', (event) => {
  if (openTaskOverflowTrigger && !event.target.closest('.task-overflow')) closeTaskOverflow();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && openTaskOverflowTrigger) {
    event.preventDefault();
    closeTaskOverflow({ restoreFocus: true });
  }
});

// 从 tasksCache 同步重渲染，不发请求。
// 本地状态（stoppingTaskIds / runningTaskIds）变化后调它，点击就能立刻见效。
//
// 必须和 loadTasks 走同一个出口：下面那个 html === lastTasksHtml 的短路依赖缓存
// 和 DOM 始终同步，绕过它直接改 DOM 会让缓存对不上，下一轮刷新生成同样的 HTML
// 就被跳过，本地改动永久卡住。
function renderTasks() {
  const html = renderTaskGroups();
  // 内容没变就不动 DOM。整块 innerHTML 覆盖会把列表上的焦点、悬停和滚动位置一起
  // 冲掉，而状态刷新很频繁，绝大多数轮次内容是完全一样的。
  //
  // 比的是自己上次生成的字符串，不是 tasksEl.innerHTML —— 后者被浏览器重新序列化过
  // （自闭合标签展开、实体归一化），跟原始字符串永远不相等，这个判断就会永远不生效。
  if (html === lastTasksHtml) return;
  closeTaskOverflow();
  lastTasksHtml = html;
  tasksEl.innerHTML = html;
  if (window.lucide) window.lucide.createIcons({ root: tasksEl });
}

async function loadTasks() {
  const data = await fetchJson('/api/tasks');
  tasksCache = data.data;
  // 服务端已经确认不在跑了，本地的"停止中"覆盖就该退场，交回服务端状态。
  // 放在渲染前统一清，避免 taskCard 边遍历边改集合。
  for (const task of data.data) {
    if (!task.is_running) clearStopping(task.id);
  }
  renderTasks();
}

async function loadRuns() {
  const data = await fetchJson('/api/runs');
  runsCache = data.data;
  groupLastRuns(runsCache);
}

async function loadTelegramSettings() {
  try {
    const res = await fetchJson('/api/settings/telegram');
    const {
      configured,
      chatId,
      botTokenMasked,
      proxy,
      webhookUrl,
      webhookStatus,
      webhookError,
    } = res.data;
    
    const webhookRegistered = webhookStatus === 'registered';
    if (!configured) {
      tgStatusText.textContent = '状态：未配置';
      tgStatusText.style.color = '#94a3b8';
    } else if (webhookRegistered) {
      tgStatusText.textContent = '状态：已配置，Webhook 已注册';
      tgStatusText.style.color = '#86efac';
    } else {
      tgStatusText.textContent = '状态：已配置，Webhook 未就绪';
      tgStatusText.style.color = '#fbbf24';
    }
    
    tgChatId.value = chatId || '';
    if (tgProxy) tgProxy.value = proxy || '';
    if (tgWebhookUrl) {
      const suggestedOrigin = window.location.protocol === 'https:' ? window.location.origin : '';
      tgWebhookUrl.value = webhookUrl || suggestedOrigin;
    }
    tgBotToken.value = '';
    tgBotToken.setAttribute('aria-describedby', 'tg-token-help');
    
    if (botTokenMasked) {
      tgTokenHelp.textContent = `当前 Token: ${botTokenMasked}`;
    } else {
      tgTokenHelp.textContent = '未设置 Token';
    }

    if (tgWebhookHelp) {
      if (webhookRegistered) {
        tgWebhookHelp.textContent = '已向 Telegram 注册。更换域名、Tunnel 或 Token 后请重新保存。';
      } else if (webhookError) {
        tgWebhookHelp.textContent = `Webhook 未就绪：${webhookError}`;
      } else {
        tgWebhookHelp.textContent = '保存后自动注册 Telegram 重试按钮的回调地址。';
      }
    }
  } catch (error) {
    tgStatusText.textContent = '状态：加载失败';
    console.error('Failed to load Telegram settings:', error);
  }
}

function normalizePluginPackagesForUi(value) {
  return String(value || '')
    .split(/[\r\n,;]+/g)
    .map(item => item.trim())
    .filter(Boolean)
    .join(', ');
}

function setSchedulerStatus(text, color) {
  if (!schedulerStatusText) return;
  schedulerStatusText.textContent = text;
  if (color) schedulerStatusText.style.color = color;
}

async function loadSchedulerSettings() {
  if (!schedulerForm) return;
  try {
    const res = await fetchJson('/api/settings/scheduler');
    const data = res.data || {};
    if (schedulerAllowParallel) {
      schedulerAllowParallel.checked = Boolean(data.allowParallel);
    }
    const mode = data.allowParallel ? '浏览器任务并行' : '浏览器任务串行（默认）';
    const running = Array.isArray(data.runningTaskIds) ? data.runningTaskIds : [];
    const runningText = running.length ? `，当前运行：#${running.join(', #')}` : '，当前空闲';
    setSchedulerStatus(`状态：${mode}${runningText}`, '#94a3b8');
  } catch (error) {
    setSchedulerStatus('状态：加载失败', '#ef4444');
    console.error('Failed to load scheduler settings:', error);
  }
}

async function saveSchedulerSettings() {
  const allowParallel = Boolean(schedulerAllowParallel && schedulerAllowParallel.checked);
  await fetchJson('/api/settings/scheduler', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowParallel }),
  });
  await loadSchedulerSettings();
}

/* ---------- 云端备份 ---------- */

let pendingCloudRestoreKey = null;

function setCloudBackupStatus(text, color) {
  if (!cloudBackupStatusText) return;
  cloudBackupStatusText.textContent = text;
  if (color) cloudBackupStatusText.style.color = color;
}

function updateCloudBackupTimeFields() {
  if (!cloudBackupTimeFields) return;
  const show = cloudBackupSchedule && cloudBackupSchedule.value !== 'off';
  cloudBackupTimeFields.style.display = show ? 'grid' : 'none';
}

function formatCloudBackupTime(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString();
  } catch { return String(iso); }
}

async function loadCloudBackupSettings() {
  if (!cloudBackupForm) return;
  setCloudBackupStatus('状态：加载中...', '#94a3b8');
  try {
    const res = await fetchJson('/api/cloud-backup/settings');
    const data = res.data || {};
    if (cloudBackupEnabled) cloudBackupEnabled.checked = Boolean(data.enabled);
    if (cloudBackupEndpoint) cloudBackupEndpoint.value = data.endpoint || '';
    if (cloudBackupRegion) cloudBackupRegion.value = data.region || '';
    if (cloudBackupBucket) cloudBackupBucket.value = data.bucket || '';
    if (cloudBackupAccessKey) {
      cloudBackupAccessKey.value = '';
      cloudBackupAccessKey.placeholder = data.hasAccessKey ? `已设置 ${data.accessKeyMasked}（留空不修改）` : 'AKIA...';
    }
    if (cloudBackupSecretKey) {
      cloudBackupSecretKey.value = '';
      cloudBackupSecretKey.placeholder = data.hasSecretKey ? `已设置 ${data.secretKeyMasked}（留空不修改）` : '未设置';
    }
    if (cloudBackupToken) {
      cloudBackupToken.value = '';
      cloudBackupToken.placeholder = data.hasToken ? `已设置 ${data.tokenMasked}（留空不修改）` : '临时凭据专用，留空不修改';
    }
    if (cloudBackupProxy) cloudBackupProxy.value = data.proxy || '';
    if (cloudBackupPathStyle) cloudBackupPathStyle.checked = Boolean(data.pathStyle);
    if (cloudBackupPrefix) cloudBackupPrefix.value = data.prefix || '';
    if (cloudBackupRetention) cloudBackupRetention.value = data.retention ?? 7;
    if (cloudBackupSchedule) cloudBackupSchedule.value = data.schedule || 'off';
    if (cloudBackupHour) cloudBackupHour.value = data.hour ?? 3;
    if (cloudBackupMinute) cloudBackupMinute.value = data.minute ?? 0;
    if (cloudBackupPassphrase) {
      cloudBackupPassphrase.value = '';
      cloudBackupPassphrase.placeholder = data.hasPassphrase ? '已设置备份密码（留空不修改）' : '未设置，请填写并离线保存';
    }
    if (cloudBackupPassphraseConfirm) cloudBackupPassphraseConfirm.checked = false;
    updateCloudBackupTimeFields();
    const enabledText = data.enabled ? '已启用' : '未启用';
    const scheduleText = { off: '仅手动', hourly: '每小时', daily: '每天' }[data.schedule] || '仅手动';
    setCloudBackupStatus(`状态：${enabledText} · ${scheduleText}`, '#94a3b8');
    if (cloudBackupNextText) {
      if (data.nextAt) {
        try {
          cloudBackupNextText.textContent = `下一次自动备份：${new Date(data.nextAt).toLocaleString()}`;
        } catch {
          cloudBackupNextText.textContent = '下一次自动备份：未排期';
        }
      } else {
        cloudBackupNextText.textContent = '下一次自动备份：未排期';
      }
    }
  } catch (error) {
    setCloudBackupStatus('状态：加载失败', '#ef4444');
    console.error('Failed to load cloud backup settings:', error);
  }
}

async function saveCloudBackupSettings() {
  if (!cloudBackupForm) return;
  const passphrase = cloudBackupPassphrase ? cloudBackupPassphrase.value : '';
  if (passphrase && (!cloudBackupPassphraseConfirm || !cloudBackupPassphraseConfirm.checked)) {
    toast('设置新密码前请先勾选「我已把备份密码离线保存」', 'warn');
    return;
  }
  if (cloudBackupSaveBtn) cloudBackupSaveBtn.disabled = true;
  try {
    await fetchJson('/api/cloud-backup/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: Boolean(cloudBackupEnabled && cloudBackupEnabled.checked),
        endpoint: cloudBackupEndpoint?.value || '',
        region: cloudBackupRegion?.value || '',
        bucket: cloudBackupBucket?.value || '',
        accessKey: cloudBackupAccessKey?.value || '',
        secretKey: cloudBackupSecretKey?.value || '',
        token: cloudBackupToken?.value || '',
        proxy: cloudBackupProxy?.value || '',
        pathStyle: Boolean(cloudBackupPathStyle && cloudBackupPathStyle.checked),
        prefix: cloudBackupPrefix?.value || '',
        retention: Number(cloudBackupRetention?.value || 7),
        schedule: cloudBackupSchedule?.value || 'off',
        hour: Number(cloudBackupHour?.value || 3),
        minute: Number(cloudBackupMinute?.value || 0),
        passphrase,
      }),
    });
    toast('云端备份设置已保存', 'success');
    await loadCloudBackupSettings();
  } catch (error) {
    toast(error.message || '保存云端备份设置失败', 'error');
  } finally {
    if (cloudBackupSaveBtn) cloudBackupSaveBtn.disabled = false;
  }
}

async function testCloudBackupConnection() {
  if (!cloudBackupTestBtn) return;
  cloudBackupTestBtn.disabled = true;
  cloudBackupTestBtn.textContent = '测试中...';
  try {
    await fetchJson('/api/cloud-backup/test', { method: 'POST' });
    toast('连接成功：已写入并删除探针对象', 'success');
  } catch (error) {
    toast(error.message || '测试连接失败', 'error');
  } finally {
    cloudBackupTestBtn.disabled = false;
    cloudBackupTestBtn.innerHTML = '<i data-lucide="plug-zap" class="icon-sm"></i> 测试连接';
    if (window.lucide) window.lucide.createIcons();
  }
}

async function runCloudBackupNow() {
  if (!cloudBackupRunBtn) return;
  const label = cloudBackupLabel ? cloudBackupLabel.value.trim() : '';
  cloudBackupRunBtn.disabled = true;
  cloudBackupRunBtn.textContent = '备份中...';
  try {
    const res = await fetchJson('/api/cloud-backup/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    });
    const data = res.data || {};
    const warnings = Array.isArray(data.warnings) ? data.warnings : [];
    const suffix = warnings.length ? `（${warnings.length} 条提示，见控制台）` : '';
    toast(`备份完成：${data.name || data.key || ''}${suffix}`, 'success');
    warnings.forEach((w) => console.warn('[cloud-backup]', w));
    if (cloudBackupLabel) cloudBackupLabel.value = '';
    await loadCloudBackupSettings();
    await loadCloudBackupList();
  } catch (error) {
    toast(error.message || '备份失败', 'error');
  } finally {
    cloudBackupRunBtn.disabled = false;
    cloudBackupRunBtn.innerHTML = '<i data-lucide="cloud-upload" class="icon-sm"></i> 立即备份';
    if (window.lucide) window.lucide.createIcons();
  }
}

async function loadCloudBackupList() {
  if (!cloudBackupList) return;
  cloudBackupList.innerHTML = '<p class="muted" style="margin:0;">加载中...</p>';
  try {
    const res = await fetchJson('/api/cloud-backup/list');
    const items = Array.isArray(res.data) ? res.data : [];
    if (!items.length) {
      cloudBackupList.innerHTML = '<p class="muted" style="margin:0;">还没有远端备份。点「立即备份」上传第一份。</p>';
      return;
    }
    cloudBackupList._items = items;
    cloudBackupList.innerHTML = items.map((item, index) => {
      const when = formatCloudBackupTime(item.lastModified);
      return `
        <div class="backup-summary-card" style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
          <div style="min-width:0;">
            <strong style="display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(item.name)}</strong>
            <span class="muted">${when} · ${formatBytes(item.size)}</span>
          </div>
          <div class="row" style="gap:6px; flex-wrap:nowrap;">
            <button type="button" class="alt btn-with-icon" data-cloud-preview="${index}"><i data-lucide="eye" class="icon-sm"></i> 预览</button>
            <button type="button" class="btn-primary btn-with-icon" data-cloud-restore="${index}"><i data-lucide="download-cloud" class="icon-sm"></i> 恢复</button>
          </div>
        </div>`;
    }).join('');
    if (window.lucide) window.lucide.createIcons({ root: cloudBackupList });
  } catch (error) {
    cloudBackupList.innerHTML = `<p class="muted" style="margin:0;color:#ef4444;">加载失败：${escapeHtml(error.message)}</p>`;
  }
}

function closeCloudRestoreModal() {
  if (!cloudRestoreModal) return;
  cloudRestoreModal.classList.remove('open');
  cloudRestoreModal.hidden = true;
  if (cloudRestoreMask) cloudRestoreMask.hidden = true;
  cloudRestoreModal.innerHTML = '';
  pendingCloudRestoreKey = null;
}

/** 预览某份远端快照。预览和「恢复」按钮共用这条路径：先看清单，再在弹窗里确认还原。 */
async function previewCloudBackup(key) {
  if (!cloudRestoreModal) return;
  try {
    const res = await fetchJson('/api/cloud-backup/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    const data = res.data || {};
    const manifest = data.manifest || {};
    const counts = manifest.counts || {};
    pendingCloudRestoreKey = key;
    const created = manifest.created_at ? new Date(manifest.created_at).toLocaleString() : '-';
    cloudRestoreModal.innerHTML = `
      <div class="modal-panel backup-import-panel">
        <div class="modal-header" style="padding:18px 22px;">
          <div><h2 style="margin:0;">还原远端快照</h2><p class="muted" style="margin:3px 0 0;">${escapeHtml(data.name || key)}</p></div>
          <button type="button" class="icon-btn" data-cloud-restore-close aria-label="关闭"><i data-lucide="x" class="icon-md"></i></button>
        </div>
        <div class="modal-body" style="padding:22px;">
          <div class="backup-import-summary">
            <div class="backup-summary-card"><strong>${counts.tasks ?? '-'}</strong><span class="muted">任务</span></div>
            <div class="backup-summary-card"><strong>${counts.profiles ?? '-'}</strong><span class="muted">浏览器配置</span></div>
            <div class="backup-summary-card"><strong>${counts.users ?? '-'}</strong><span class="muted">面板账号</span></div>
            <div class="backup-summary-card"><strong>${counts.envEntries ?? '-'}</strong><span class="muted">环境变量</span></div>
          </div>
          <ul class="backup-conflict-list backup-warning">
            <li>创建时间：${created}</li>
            <li>面板版本：${escapeHtml(manifest.panel_version || '-')}</li>
            <li>包含内容：${escapeHtml((manifest.includes || []).join('、'))}</li>
          </ul>
          <p class="schedule-note" style="margin-bottom:12px;">
            还原会<b>覆盖当前全部任务与配置</b>，原数据挪到 <code>data/pre-restore-&lt;时间戳&gt;/</code> 留作回滚，不会删除。
            已配置 systemd（bp.sh）时面板将自动重启生效，否则需手动重启。
          </p>
          <div class="backup-import-actions">
            <button type="button" class="alt" data-cloud-restore-close>取消</button>
            <button type="button" data-cloud-restore-confirm class="btn-primary btn-with-icon"><i data-lucide="download-cloud" class="icon-sm"></i>确认还原</button>
          </div>
        </div>
      </div>`;
    cloudRestoreModal.hidden = false;
    if (cloudRestoreMask) cloudRestoreMask.hidden = false;
    cloudRestoreModal.classList.add('open');
    cloudRestoreModal.querySelectorAll('[data-cloud-restore-close]').forEach((button) => button.addEventListener('click', closeCloudRestoreModal));
    cloudRestoreModal.querySelector('[data-cloud-restore-confirm]').addEventListener('click', confirmCloudRestore);
    if (window.lucide) window.lucide.createIcons({ root: cloudRestoreModal });
  } catch (error) {
    toast(error.message || '预览备份失败', 'error');
  }
}

async function confirmCloudRestore() {
  if (!pendingCloudRestoreKey) return;
  if (!window.confirm('确认还原该快照？当前任务与配置将被覆盖（原数据保留在 pre-restore 目录），面板可能自动重启。')) return;
  const confirmButton = cloudRestoreModal.querySelector('[data-cloud-restore-confirm]');
  if (confirmButton) confirmButton.disabled = true;
  try {
    const res = await fetchJson('/api/cloud-backup/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: pendingCloudRestoreKey }),
    });
    const data = res.data || {};
    toast(data.message || '还原完成，请稍候面板重启', 'success');
    closeCloudRestoreModal();
  } catch (error) {
    // 还原成功后面板会立刻重启，响应可能被掐断 —— 网络错误按「已触发重启」处理
    const msg = String(error && error.message || '');
    if (/fetch failed|failed to fetch|networkerror|ecoonreset|sock/i.test(msg)) {
      toast('还原已触发，面板正在重启，请稍后刷新页面确认结果', 'warn');
      closeCloudRestoreModal();
      return;
    }
    toast(error.message || '恢复失败', 'error');
    if (confirmButton) confirmButton.disabled = false;
  }
}

/**
 * 手动上传 .bpsnap 快照还原（不经 S3）。选文件 → 现场输入该快照的备份密码 →
 * 以 octet-stream 上传，密码走请求头。成功后面板重启，网络错误按「已触发重启」处理。
 */
async function uploadCloudBackupRestore() {
  if (!cloudBackupUploadBtn || !cloudBackupUploadInput) return;
  const file = cloudBackupUploadInput.files && cloudBackupUploadInput.files[0];
  if (!file) { toast('请先选择 .bpsnap 快照文件', 'warn'); return; }
  cloudBackupUploadInput.value = '';

  dialogPassphraseOnce('请输入这份快照的备份密码（备份时设置的口令，不是云端设置里的那个）。', async (passphrase) => {
    cloudBackupUploadBtn.disabled = true;
    cloudBackupUploadBtn.textContent = '上传中...';
    try {
      await fetchJson('/api/cloud-backup/restore-upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-backup-passphrase': passphrase,
        },
        body: file,
      });
      toast('还原已触发，面板正在重启，请稍后刷新页面确认结果', 'warn');
    } catch (error) {
      const msg = String(error && error.message || '');
      if (/fetch failed|failed to fetch|networkerror|ecoonreset|sock/i.test(msg)) {
        toast('还原已触发，面板正在重启，请稍后刷新页面确认结果', 'warn');
        return;
      }
      toast(error.message || '上传还原失败', 'error');
    } finally {
      cloudBackupUploadBtn.disabled = false;
      cloudBackupUploadBtn.innerHTML = '<i data-lucide="upload" class="icon-sm"></i> 上传并还原';
      if (window.lucide) window.lucide.createIcons();
    }
  });
}

function setSuccessHeuristicsStatus(text, color) {
  if (!successHeuristicsStatus) return;
  successHeuristicsStatus.textContent = text;
  if (color) successHeuristicsStatus.style.color = color;
}

async function loadSuccessHeuristicsSettings() {
  if (!successHeuristicsForm) return;
  try {
    const res = await fetchJson('/api/settings/success-heuristics');
    const data = res.data || {};
    if (shEnabled) shEnabled.checked = data.enabled !== false;
    if (shGraceSec) shGraceSec.value = data.graceSec ?? 45;
    if (shSuccessPatterns) shSuccessPatterns.value = data.successPatternsText || '';
    if (shFailurePatterns) shFailurePatterns.value = data.failurePatternsText || '';
    const mode = data.enabled === false ? '已关闭' : '已启用';
    setSuccessHeuristicsStatus(`状态：${mode} · grace ${data.graceSec ?? 45}s`, '#94a3b8');
  } catch (error) {
    setSuccessHeuristicsStatus('状态：加载失败', '#ef4444');
    console.error('Failed to load success heuristics:', error);
  }
}

async function saveSuccessHeuristicsSettings() {
  await fetchJson('/api/settings/success-heuristics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: Boolean(shEnabled && shEnabled.checked),
      graceSec: Number(shGraceSec?.value || 45),
      successPatternsText: shSuccessPatterns?.value || '',
      failurePatternsText: shFailurePatterns?.value || '',
    }),
  });
  await loadSuccessHeuristicsSettings();
}

function setBrowserRuntimeStatus(text, color) {
  if (!browserRuntimeStatus) return;
  browserRuntimeStatus.textContent = text;
  if (color) browserRuntimeStatus.style.color = color;
}

const warpSummaryStatus = document.getElementById('warp-summary-status');
const warpPhase = document.getElementById('warp-phase');
const warpHttpAddress = document.getElementById('warp-http-address');
const warpActiveSessions = document.getElementById('warp-active-sessions');
const warpJob = document.getElementById('warp-job');
const warpJobTitle = document.getElementById('warp-job-title');
const warpJobProgress = document.getElementById('warp-job-progress');
const warpJobMeter = document.getElementById('warp-job-meter');
const warpJobError = document.getElementById('warp-job-error');
const warpLastError = document.getElementById('warp-last-error');
const warpEnableBtn = document.getElementById('warp-enable-btn');
const warpDisableBtn = document.getElementById('warp-disable-btn');
const warpProbeBtn = document.getElementById('warp-probe-btn');
const warpReconnectBtn = document.getElementById('warp-reconnect-btn');
const warpRotateBtn = document.getElementById('warp-rotate-btn');
const warpButtons = [warpEnableBtn, warpDisableBtn, warpProbeBtn, warpReconnectBtn, warpRotateBtn].filter(Boolean);
let warpJobTimer = null;
let warpPollingJobId = null;

const WARP_PHASE_LABELS = {
  disabled: '未启用',
  needs_install: '等待安装',
  installing: '安装组件',
  registering: '注册身份',
  starting: '正在启动',
  healthy: '运行正常',
  degraded: '单栈可用',
  reconnecting: '正在重连',
  rotating: '正在换 IP',
  rolling_back: '正在回滚',
  stopping: '正在停用',
  error: '运行异常',
};

function renderWarpFamily(family, data) {
  const stateEl = document.getElementById(`warp-${family}-state`);
  const addressEl = document.getElementById(`warp-${family}-address`);
  const traceEl = document.getElementById(`warp-${family}-trace`);
  const metaEl = document.getElementById(`warp-${family}-meta`);
  const errorEl = document.getElementById(`warp-${family}-error`);
  if (!stateEl) return;
  stateEl.textContent = data ? (data.available ? '可用' : '不可用') : '未检测';
  addressEl.textContent = data?.address || '—';
  traceEl.textContent = data ? `${data.warp || '—'} / ${data.colo || '—'}` : '—';
  const checkedAt = data?.checkedAt ? new Date(data.checkedAt).toLocaleString() : '';
  metaEl.textContent = data ? `${Number.isFinite(data.latencyMs) ? `${data.latencyMs} ms` : '—'}${checkedAt ? ` / ${checkedAt}` : ''}` : '—';
  errorEl.textContent = data?.error || '';
  errorEl.hidden = !data?.error;
}

function renderWarpJob(job) {
  if (!warpJob) return;
  warpJob.hidden = !job;
  if (!job) return;
  const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
  warpJobTitle.textContent = `${job.type || 'WARP'}：${job.step || job.status || '处理中'}`;
  warpJobProgress.textContent = `${progress}%`;
  warpJobMeter.value = progress;
  warpJobError.textContent = job.error_text || '';
  warpJobError.hidden = !job.error_text;
}

function renderWarpStatus(data = {}) {
  const phaseLabel = WARP_PHASE_LABELS[data.phase] || data.phase || '未知';
  if (warpSummaryStatus) warpSummaryStatus.textContent = `状态：${phaseLabel}`;
  if (warpPhase) warpPhase.textContent = phaseLabel;
  if (warpHttpAddress) warpHttpAddress.textContent = data.httpAddress || '未运行';
  if (warpActiveSessions) warpActiveSessions.textContent = String(data.activeSessions || 0);
  renderWarpFamily('ipv4', data.probe?.ipv4);
  renderWarpFamily('ipv6', data.probe?.ipv6);
  renderWarpJob(data.currentJob || null);
  if (warpLastError) {
    warpLastError.textContent = data.lastError?.message || '';
    warpLastError.hidden = !data.lastError?.message;
  }
  const busy = Boolean(data.currentJob);
  warpButtons.forEach((button) => { button.disabled = busy; });
  if (warpEnableBtn) warpEnableBtn.disabled = busy || Boolean(data.desiredEnabled);
  if (warpDisableBtn) warpDisableBtn.disabled = busy || !data.desiredEnabled;
  if (warpProbeBtn) warpProbeBtn.disabled = busy || !data.process?.running;
  if (warpReconnectBtn) warpReconnectBtn.disabled = busy || !data.desiredEnabled || Number(data.activeSessions || 0) > 0;
  if (warpRotateBtn) warpRotateBtn.disabled = busy || !data.desiredEnabled || Number(data.activeSessions || 0) > 0;
}

async function loadWarpStatus() {
  if (!warpPhase) return null;
  try {
    const res = await fetchJson('/api/warp/status');
    renderWarpStatus(res.data || {});
    return res.data || {};
  } catch (error) {
    if (warpSummaryStatus) warpSummaryStatus.textContent = '状态：加载失败';
    if (warpLastError) {
      warpLastError.textContent = error.message || 'WARP 状态加载失败';
      warpLastError.hidden = false;
    }
    return null;
  }
}

function stopWarpJobPolling() {
  if (warpJobTimer) clearTimeout(warpJobTimer);
  warpJobTimer = null;
  warpPollingJobId = null;
}

async function pollWarpJob(jobId) {
  if (!jobId || warpPollingJobId !== jobId) return;
  try {
    const res = await fetchJson(`/api/warp/jobs/${jobId}`);
    const job = res.data || {};
    renderWarpJob(job);
    if (['succeeded', 'failed', 'interrupted'].includes(job.status)) {
      stopWarpJobPolling();
      await loadWarpStatus();
      if (job.status === 'succeeded') {
        const comparison = job.result?.comparison;
        const rebuiltWithoutChange = ['reconnect', 'rotate'].includes(job.type) && comparison?.changed === false;
        toast(rebuiltWithoutChange ? '连接已重建但出口 IP 未变化' : 'WARP 操作已完成', 'success');
      } else {
        toast(job.error_text || 'WARP 操作失败', 'error');
      }
      return;
    }
  } catch (error) {
    stopWarpJobPolling();
    toast(error.message || 'WARP 任务状态读取失败', 'error');
    return;
  }
  warpJobTimer = setTimeout(() => pollWarpJob(jobId), 1000);
}

async function startWarpOperation(action) {
  warpButtons.forEach((button) => { button.disabled = true; });
  try {
    const res = await fetchJson(`/api/warp/${action}`, { method: 'POST' });
    const job = res.data || {};
    renderWarpJob(job);
    warpPollingJobId = Number(res.jobId || job.id);
    await loadWarpStatus();
    pollWarpJob(warpPollingJobId);
  } catch (error) {
    toast(error.message || 'WARP 操作失败', 'error');
    await loadWarpStatus();
  }
}

warpEnableBtn?.addEventListener('click', () => startWarpOperation('enable'));
warpDisableBtn?.addEventListener('click', () => startWarpOperation('disable'));
warpProbeBtn?.addEventListener('click', () => startWarpOperation('probe'));
warpReconnectBtn?.addEventListener('click', () => startWarpOperation('reconnect'));
warpRotateBtn?.addEventListener('click', () => startWarpOperation('rotate'));

const brChromePath = document.getElementById('br-chrome-path');
const brRuyiPath = document.getElementById('br-ruyi-path');
const brProxyMode = document.getElementById('br-proxy-mode');
const brProxyValue = document.getElementById('br-proxy-value');
const brProxyValueField = document.getElementById('br-proxy-value-field');

function updateProxyModeUI(modeEl, valueEl, fieldEl) {
  const mode = String(modeEl?.value || 'direct');
  const acceptsValue = mode === 'launch';
  if (!acceptsValue && valueEl) valueEl.value = '';
  if (fieldEl) fieldEl.hidden = !acceptsValue;
  if (valueEl) valueEl.disabled = !acceptsValue;
}

function collectBrowserRuntimeFormPayload() {
  const proxyMode = brProxyMode?.value || 'direct';
  return {
    runtimeStack: brRuntimeStack?.value || 'playwright',
    usePlaywrightExtra: Boolean(brUsePlaywrightExtra?.checked),
    pluginPackages: normalizePluginPackagesForUi(brPluginPackages?.value),
    chromePath: String(brChromePath?.value || '').trim(),
    ruyiPath: String(brRuyiPath?.value || '').trim(),
    proxyMode,
    proxyValue: proxyMode === 'launch' ? String(brProxyValue?.value || '').trim() : '',
    extensionDirs: String(brExtensionDirs?.value || '').trim(),
  };
}

async function loadBrowserRuntimeSettings() {
  if (!browserRuntimeForm) return;
  try {
    const res = await fetchJson('/api/settings/browser-runtime');
    const data = res.data || {};
    if (brRuntimeStack) brRuntimeStack.value = data.runtimeStack || 'playwright';
    if (brUsePlaywrightExtra) brUsePlaywrightExtra.checked = Boolean(data.usePlaywrightExtra);
    if (brPluginPackages) brPluginPackages.value = normalizePluginPackagesForUi(data.pluginPackages);
    if (brChromePath) brChromePath.value = data.chromePath || '';
    if (brRuyiPath) brRuyiPath.value = data.ruyiPath || '';
    if (brProxyMode) brProxyMode.value = data.proxyMode || 'direct';
    if (brProxyValue) brProxyValue.value = data.proxyValue || '';
    updateProxyModeUI(brProxyMode, brProxyValue, brProxyValueField);
    if (brExtensionDirs) brExtensionDirs.value = data.extensionDirs || '';
    const packageCount = normalizePluginPackagesForUi(data.pluginPackages).split(',').map(s => s.trim()).filter(Boolean).length;
    const runtimeStack = data.runtimeStack || 'playwright';
    const stackLabel = runtimeStack === 'seleniumbase'
      ? 'SeleniumBase + ChromeDriver'
      : (runtimeStack === 'ruyipage' ? 'RuyiPage + Firefox' : 'Playwright');
    const pluginStatus = runtimeStack !== 'playwright'
      ? 'Playwright 插件配置已保留'
      : (data.usePlaywrightExtra ? '已启用 playwright-extra' : '使用原生 playwright');
    const chromeLabel = data.chromePath
      ? `Chrome: ${data.chromePath}${data.chromePathSource === 'panel' ? '（面板）' : '（默认）'}`
      : 'Chrome: 未设置';
    const extensionCount = String(data.extensionDirs || '').split(/[|;]/).map(s => s.trim()).filter(Boolean).length;
    setBrowserRuntimeStatus(`状态：${stackLabel}，${pluginStatus}，插件包：${packageCount}，浏览器扩展：${extensionCount}，${chromeLabel}`, '#94a3b8');
  } catch (error) {
    setBrowserRuntimeStatus('状态：加载失败', '#ef4444');
    console.error('Failed to load browser runtime settings:', error);
  }
}

async function saveBrowserRuntimeSettings() {
  const payload = collectBrowserRuntimeFormPayload();
  await fetchJson('/api/settings/browser-runtime', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  await loadBrowserRuntimeSettings();
}

async function installBrowserRuntimePackages() {
  const payload = collectBrowserRuntimeFormPayload();
  const res = await fetchJson('/api/settings/browser-runtime/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  await loadBrowserRuntimeSettings();
  return res.data || {};
}

async function installBrowserRuntimeEnvironment() {
  const payload = collectBrowserRuntimeFormPayload();
  const res = await fetchJson('/api/settings/browser-runtime/install-browser', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  await loadBrowserRuntimeSettings();
  return res.data || {};
}

function renderProfileOptions(selectEl, selectedId) {
  if (!selectEl) return;
  const prev = selectedId !== undefined ? String(selectedId) : selectEl.value;
  const emptyLabel = selectEl === taskProfileSelect && isTaskTempProfileMode()
    ? '\u4e0d\u7ed1\u5b9a\u914d\u7f6e\uff08\u4ec5\u7cfb\u7edf\u9ed8\u8ba4\u4ee3\u7406\uff09'
    : '\u9ed8\u8ba4\u914d\u7f6e';
  selectEl.innerHTML = `<option value="">${emptyLabel}</option>` +
    profilesCache.map((p) => {
      const stack = String(p.runtime_stack || '').trim();
      const stackText = stack ? ` [${stack}]` : '';
      return `<option value="${p.id}" ${String(p.id) === prev ? 'selected' : ''}>${escapeHtml(`${p.name}${stackText}`)}</option>`;
    }).join('');
}

function isTaskTempProfileMode() {
  if (!taskProfileModeSelect) return true;
  return String(taskProfileModeSelect.value || 'temp') !== 'persistent';
}

function updateTaskProfileModeUI() {
  const temp = isTaskTempProfileMode();
  if (taskUsePersistentInput) taskUsePersistentInput.value = temp ? '0' : '1';
  if (taskProfileModeHint) {
    taskProfileModeHint.textContent = temp
      ? '\u4e34\u65f6\u6a21\u5f0f\uff1a\u6bcf\u6b21\u72ec\u7acb user-data-dir\uff0c\u8dd1\u5b8c\u5220\u9664\u3002\u53ef\u501f\u7528\u6240\u9009\u914d\u7f6e\u7684\u8bed\u8a00\u3001\u65f6\u533a\u3001\u4ee3\u7406\u4e0e\u914d\u7f6e\u7ea7\u53d8\u91cf\uff0c\u4f46\u4e0d\u4f1a\u5199\u5165\u5176\u6570\u636e\u76ee\u5f55\u3002'
      : '\u6301\u4e45\u6a21\u5f0f\uff1a\u4f7f\u7528\u4e0b\u65b9\u6d4f\u89c8\u5668\u914d\u7f6e\u7684 user-data-dir\uff1b\u4ee3\u7406\u53ef\u8986\u76d6\u8be5\u914d\u7f6e\u7684\u4ee3\u7406\u3002';
  }
  if (taskProfilePersistentFields) {
    const label = taskProfilePersistentFields.querySelector('.field-label');
    if (label) {
      label.textContent = temp
        ? '\u53ef\u9009\uff1a\u501f\u7528\u914d\u7f6e\u7ea7\u53d8\u91cf\uff08\u4e0d\u5199\u5176\u6570\u636e\u76ee\u5f55\uff09'
        : '\u6d4f\u89c8\u5668\u914d\u7f6e\uff08\u5199\u5165\u5176\u6570\u636e\u76ee\u5f55\uff09';
    }
  }
  if (taskProxyHint) {
    taskProxyHint.textContent = temp
      ? '\u4e34\u65f6\u6a21\u5f0f\u53ef\u5355\u72ec\u8bbe\u4ee3\u7406\u3002\u7559\u7a7a\uff1a\u82e5\u9009\u4e86\u914d\u7f6e\u5219\u7528\u914d\u7f6e\u4ee3\u7406\uff0c\u5426\u5219\u7528\u7cfb\u7edf\u9ed8\u8ba4\u3002'
      : '\u53ef\u8986\u76d6\u6240\u9009\u914d\u7f6e\u7684\u4ee3\u7406\u3002\u7559\u7a7a\u5219\u7528\u914d\u7f6e\u4ee3\u7406 / \u7cfb\u7edf\u9ed8\u8ba4\u3002';
  }
  if (taskProxyFromProfileBtn) {
    taskProxyFromProfileBtn.hidden = !(taskProfileSelect && taskProfileSelect.value);
  }
  // refresh empty option label
  if (taskProfileSelect) {
    renderProfileOptions(taskProfileSelect, taskProfileSelect.value);
  }
}

function setTaskProfileMode(mode) {
  const next = mode === 'persistent' ? 'persistent' : 'temp';
  if (taskProfileModeSelect) taskProfileModeSelect.value = next;
  updateTaskProfileModeUI();
}

function getTaskBrowserProxyFromForm() {
  const mode = taskProxyMode?.value || 'inherit';
  return {
    runtimeStack: taskBrowserType?.value || '',
    mode,
    value: mode === 'launch' ? String(taskProxyInput?.value || '').trim() : '',
  };
}

function setTaskBrowserProxyInput(value, runtimeStack = '', mode = 'inherit') {
  const normalizedMode = ['inherit', 'direct', 'launch', 'warp'].includes(mode) ? mode : 'inherit';
  if (taskProxyMode) taskProxyMode.value = normalizedMode;
  if (taskProxyInput) taskProxyInput.value = normalizedMode === 'launch' ? String(value || '').trim() : '';
  updateProxyModeUI(taskProxyMode, taskProxyInput, taskProxyValueField);
  if (taskBrowserType) {
    const stack = String(runtimeStack || '').trim().toLowerCase();
    taskBrowserType.value = stack === 'ruyipage' ? 'ruyipage' : (stack ? 'playwright' : '');
  }
}

function fillTaskProxyFromSelectedProfile() {
  const id = taskProfileSelect?.value;
  if (!id) {
    toast('\u8bf7\u5148\u9009\u62e9\u4e00\u4e2a\u6d4f\u89c8\u5668\u914d\u7f6e', 'warn');
    return;
  }
  const p = profilesCache.find((x) => String(x.id) === String(id));
  if (!p) {
    toast('\u672a\u627e\u5230\u8be5\u914d\u7f6e', 'error');
    return;
  }
  const value = p.proxy_value || p.proxy;
  setTaskBrowserProxyInput(value, p.runtime_stack || '', p.proxy_mode || 'inherit');
  toast('\u5df2\u586b\u5165\u914d\u7f6e\u7684\u6d4f\u89c8\u5668\u548c\u4ee3\u7406\uff08\u4ecd\u4f7f\u7528\u4e34\u65f6\u6570\u636e\u76ee\u5f55\uff09', 'success');
}

function renderProfiles() {
  renderProfileOptions(browserProfileSelect);
  renderProfileOptions(taskProfileSelect);
  if (!profilesList) return;
  if (profilesCache.length === 0) {
    profilesList.innerHTML = '<p class="muted" style="padding:8px 0;">\u6682\u65e0\u914d\u7f6e\uff0c\u70b9\u51fb\u4e0a\u65b9\u201c\u65b0\u5efa\u914d\u7f6e\u201d\u6dfb\u52a0</p>';
    return;
  }
  profilesList.innerHTML = profilesCache.map(p => `
    <article class="profile-card">
      <div class="profile-card-head">
        <div>
          <strong class="profile-card-name">${escapeHtml(p.name)}</strong>
          <div class="profile-card-id">#${p.id}</div>
        </div>
        <div class="row profile-card-actions" style="gap:8px;">
          <button class="alt btn-with-icon" onclick="editProfile(${p.id})"><i data-lucide="pencil" class="icon-sm"></i> \u7f16\u8f91</button>
          <button class="alt btn-with-icon profile-btn-danger" onclick="deleteProfile(${p.id})"><i data-lucide="trash-2" class="icon-sm"></i> \u5220\u9664</button>
        </div>
      </div>
      <div class="profile-kv-grid">
        <div class="profile-kv">
          <span class="profile-kv-label">\u6d4f\u89c8\u5668</span>
          <span class="profile-kv-value">${escapeHtml((p.runtime_stack || '') === 'ruyipage' ? 'Firefox' : ((p.runtime_stack || '') ? 'Chrome' : '\u7ee7\u627f\u5168\u5c40'))}</span>
        </div>
        <div class="profile-kv">
          <span class="profile-kv-label">\u4ee3\u7406</span>
          <span class="profile-kv-value">${escapeHtml(({ inherit: '\u7ee7\u627f\u5168\u5c40', direct: '\u4e0d\u4f7f\u7528\u4ee3\u7406', launch: '\u624b\u52a8\u4ee3\u7406', warp: 'Cloudflare WARP' })[p.proxy_mode || ((p.proxy_value || p.proxy) ? 'launch' : 'inherit')] || '\u7ee7\u627f\u5168\u5c40')}</span>
        </div>
        <div class="profile-kv">
          <span class="profile-kv-label">Locale</span>
          <span class="profile-kv-value">${escapeHtml(p.locale || 'default')}</span>
        </div>
        <div class="profile-kv">
          <span class="profile-kv-label">Timezone</span>
          <span class="profile-kv-value">${escapeHtml(p.timezone_id || 'default')}</span>
        </div>
      </div>
      <div class="profile-path-block">
        <span class="profile-kv-label">\u76ee\u5f55</span>
        <code class="profile-path-value">${escapeHtml(p.user_data_dir || '\u672a\u8bbe\u7f6e')}</code>
      </div>
    </article>
  `).join('');
  if (window.lucide) window.lucide.createIcons({ root: profilesList });
}

async function loadProfiles() {
  const res = await fetchJson('/api/browser-profiles');
  profilesCache = res.data || [];
  renderProfiles();
}

async function openProfileModal(profile) {
  const isEdit = Boolean(profile);
  let profileEnv = [];
  if (isEdit && profile?.id) {
    try {
      const res = await fetchJson(`/api/browser-profiles/${profile.id}/env`);
      profileEnv = res.data || [];
    } catch {
      profileEnv = [];
    }
  }
  const mask = document.createElement('div');
  mask.className = 'modal-mask open';
  mask.style.zIndex = '9999';
  const dialog = document.createElement('div');
  dialog.className = 'modal open';
  dialog.style.cssText = 'align-items:center;justify-content:center;z-index:10000;';
  dialog.innerHTML = `
    <div class="modal-panel" style="max-width:560px;width:100%;padding:24px;max-height:90vh;overflow:auto;">
      <div class="section-header compact" style="margin-bottom:16px;">
        <h3>${isEdit ? '\u7f16\u8f91\u914d\u7f6e' : '\u65b0\u5efa\u6d4f\u89c8\u5668\u914d\u7f6e'}</h3>
        <button class="icon-btn" id="pmodal-close"><i data-lucide="x" class="icon-md"></i></button>
      </div>
      <form id="profile-form" class="stack-form">
        <div>
          <label class="field-label">\u914d\u7f6e\u540d\u79f0</label>
          <input name="name" placeholder="\u4f8b\u5982\uff1a\u8d26\u53f7A" required value="${escapeHtml(profile?.name || '')}" />
        </div>
        <div>
          <label class="field-label">USER_DATA_DIR \u76ee\u5f55</label>
          <input name="user_data_dir" placeholder="/home/browser/browser-work/profiles/account-a" value="${escapeHtml(profile?.user_data_dir || '')}" />
        </div>
        <div>
          <label class="field-label">\u6d4f\u89c8\u5668</label>
          <select name="runtime_stack">
            <option value="" ${(profile?.runtime_stack || '') === '' ? 'selected' : ''}>\u7ee7\u627f\u5168\u5c40</option>
            <option value="playwright" ${(profile?.runtime_stack || '') !== '' && (profile?.runtime_stack || '') !== 'ruyipage' ? 'selected' : ''}>Chrome</option>
            <option value="ruyipage" ${(profile?.runtime_stack || '') === 'ruyipage' ? 'selected' : ''}>Firefox</option>
          </select>
        </div>
        <div>
          <label class="field-label">\u4ee3\u7406\u6a21\u5f0f</label>
          <select name="proxy_mode" id="profile-proxy-mode">
            <option value="inherit" ${(profile?.proxy_mode || ((profile?.proxy_value || profile?.proxy) ? 'launch' : 'inherit')) === 'inherit' ? 'selected' : ''}>\u7ee7\u627f\u5168\u5c40</option>
            <option value="direct" ${profile?.proxy_mode === 'direct' ? 'selected' : ''}>\u4e0d\u4f7f\u7528\u4ee3\u7406</option>
            <option value="launch" ${(profile?.proxy_mode || ((profile?.proxy_value || profile?.proxy) ? 'launch' : 'inherit')) === 'launch' ? 'selected' : ''}>\u624b\u52a8 SOCKS / HTTP \u4ee3\u7406</option>
            <option value="warp" ${profile?.proxy_mode === 'warp' ? 'selected' : ''}>Cloudflare WARP</option>
          </select>
        </div>
        <div id="profile-proxy-value-field">
          <label class="field-label">\u4ee3\u7406\u5730\u5740</label>
          <input name="proxy_value" placeholder="socks5://127.0.0.1:7891" value="${escapeHtml(profile?.proxy_value || profile?.proxy || '')}" />
        </div>
        <div class="locale-setting-grid">
          <div class="locale-setting-control">
            <label class="field-label" for="profile-locale-select">Locale</label>
            <select id="profile-locale-select" class="locale-preset-select">
              <option value="">跟随全局默认</option>
              ${LOCALE_PRESETS.map((value) => `<option value="${value}">${value}</option>`).join('')}
              <option value="__custom__">自定义…</option>
            </select>
            <input id="profile-locale-custom" class="locale-custom-input" type="text" placeholder="例如 fr-FR" autocomplete="off" hidden disabled />
          </div>
          <div class="locale-setting-control">
            <label class="field-label" for="profile-timezone-select">Timezone</label>
            <select id="profile-timezone-select" class="locale-preset-select">
              <option value="">跟随全局默认</option>
              ${TIMEZONE_PRESETS.map((value) => `<option value="${value}">${value}</option>`).join('')}
              <option value="__custom__">自定义…</option>
            </select>
            <input id="profile-timezone-custom" class="locale-custom-input" type="text" placeholder="例如 Europe/Paris" autocomplete="off" hidden disabled />
          </div>
        </div>
        <div class="config-block" style="margin-top:8px;">
          <div class="section-header compact">
            <div>
              <h4>\u914d\u7f6e\u7ea7\u53d8\u91cf</h4>
              <p class="muted">\u7ed1\u5b9a\u6b64\u6d4f\u89c8\u5668\u914d\u7f6e\u7684\u8d26\u53f7/\u5bc6\u94a5\uff0c\u4efb\u52a1\u9009\u7528\u8be5\u914d\u7f6e\u65f6\u6ce8\u5165</p>
            </div>
            <button type="button" class="alt btn-with-icon" id="profile-env-add" style="padding:4px 10px;">
              <i data-lucide="plus" class="icon-sm"></i> \u6dfb\u52a0
            </button>
          </div>
          <div id="profile-env-editor" class="env-editor"></div>
        </div>
        <div class="row" style="margin-top:8px;">
          <button type="submit" class="btn-primary">${isEdit ? '\u4fdd\u5b58' : '\u521b\u5efa'}</button>
          <button type="button" class="alt" id="pmodal-cancel">\u53d6\u6d88</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(mask);
  document.body.appendChild(dialog);
  const profileLocaleSelect = dialog.querySelector('#profile-locale-select');
  const profileLocaleCustom = dialog.querySelector('#profile-locale-custom');
  const profileTimezoneSelect = dialog.querySelector('#profile-timezone-select');
  const profileTimezoneCustom = dialog.querySelector('#profile-timezone-custom');
  const profileProxyMode = dialog.querySelector('#profile-proxy-mode');
  const profileProxyValue = dialog.querySelector('[name="proxy_value"]');
  const profileProxyValueField = dialog.querySelector('#profile-proxy-value-field');
  const updateProfileProxyUI = () => updateProxyModeUI(profileProxyMode, profileProxyValue, profileProxyValueField);
  profileProxyMode?.addEventListener('change', updateProfileProxyUI);
  updateProfileProxyUI();
  setupPresetCustomControl(profileLocaleSelect, profileLocaleCustom, profile?.locale || '');
  setupPresetCustomControl(profileTimezoneSelect, profileTimezoneCustom, profile?.timezone_id || '');
  const profileEnvUI = createEnvEditor(dialog.querySelector('#profile-env-editor'));
  profileEnvUI.setRows(filterManagedEnvRows(profileEnv, PROFILE_MANAGED_ENV_KEYS));
  dialog.querySelector('#profile-env-add')?.addEventListener('click', () => profileEnvUI.addRow());
  if (window.lucide) window.lucide.createIcons({ root: dialog });
  const close = () => { mask.remove(); dialog.remove(); };
  dialog.querySelector('#pmodal-close').addEventListener('click', close);
  dialog.querySelector('#pmodal-cancel').addEventListener('click', close);
  mask.addEventListener('click', close);
  dialog.querySelector('#profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    let env;
    try {
      env = profileEnvUI.collect();
    } catch (err) {
      toast(err.message || '\u53d8\u91cf\u65e0\u6548', 'error');
      return;
    }
    const proxyMode = fd.get('proxy_mode') || 'inherit';
    const proxyValue = proxyMode === 'launch' ? String(fd.get('proxy_value') || '').trim() : '';
    const body = {
      name: fd.get('name'),
      user_data_dir: fd.get('user_data_dir'),
      proxy_mode: proxyMode,
      proxy: proxyValue,
      proxy_value: proxyValue,
      runtime_stack: fd.get('runtime_stack'),
      locale: getPresetCustomValue(profileLocaleSelect, profileLocaleCustom),
      timezone_id: getPresetCustomValue(profileTimezoneSelect, profileTimezoneCustom),
    };
    try {
      let profileId = profile?.id;
      if (isEdit) {
        await fetchJson(`/api/browser-profiles/${profile.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        toast('\u914d\u7f6e\u5df2\u66f4\u65b0', 'success');
      } else {
        const created = await fetchJson('/api/browser-profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        profileId = created?.data?.id;
        toast('\u914d\u7f6e\u5df2\u521b\u5efa', 'success');
      }
      if (profileId) {
        await fetchJson(`/api/browser-profiles/${profileId}/env`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ env }),
        });
      }
      close();
      await loadProfiles();
    } catch (err) {
      toast(err.message || '\u4fdd\u5b58\u5931\u8d25', 'error');
    }
  });
}

function editProfile(id) {
  const p = profilesCache.find(x => x.id === id);
  if (p) openProfileModal(p);
}

function deleteProfile(id) {
  const p = profilesCache.find(x => x.id === id);
  dialogConfirm(`\u786e\u5b9a\u8981\u5220\u9664\u914d\u7f6e\u300c${p?.name || id}\u300d\u5417\uff1f`, async () => {
    try {
      await fetchJson(`/api/browser-profiles/${id}`, { method: 'DELETE' });
      toast('\u914d\u7f6e\u5df2\u5220\u9664', 'success');
      await loadProfiles();
    } catch (err) {
      toast(err.message || '\u5220\u9664\u5931\u8d25', 'error');
    }
  });
}
async function refreshAll() {
  await Promise.all([
    loadScripts(),
    loadRuns(),
    loadBrowserStatus(),
    loadProfiles(),
    loadTaskGroups(),
  ]);
  await loadTasks();
}

// ---------------------------------------------------------------------------
// 状态推送（SSE）
// ---------------------------------------------------------------------------
// 面板原先只在用户操作后刷新，所以服务端侧的状态变化（任务在后台跑完、定时任务
// 自己触发、浏览器被手动关掉或崩了）前端一律不知道，只能手动刷页面。
//
// 服务端在真正发生状态翻转时推一条事件过来，这里收到后拉一次状态接口。事件本身
// 不带状态，只是"变了，自己去拉"的信号 —— 拉取走 fetchJson，会话过期时能正常
// 走 401 跳登录页那条路。
//
// 刻意不刷 refreshAll()：状态推送只需拉运行记录、浏览器状态与任务，
// 避免额外刷新脚本选择项和浏览器配置，更不能覆盖用户正在编辑的设置表单。
const SSE_URL = '/api/events';
// 事件到刷新之间的合并窗口。一个任务结束会连着触发 task + 后续状态变化，
// 200ms 内的多条事件合并成一次拉取。
const REFRESH_DEBOUNCE_MS = 200;
// 降级轮询间隔。只在 SSE 没连上时才跑 —— 有的中间层会掐掉长连接或不支持
// text/event-stream，那种环境下总不能完全不刷新。
const FALLBACK_POLL_MS = 15000;

let eventSource = null;
let refreshTimer = null;
let refreshInFlight = false;
let refreshQueued = false;
let fallbackTimer = null;

async function refreshStatus() {
  if (redirectingToLogin) return;
  // 上一轮还没回来：记一笔，等它结束后补一次，别让请求堆叠。
  // 直接 return 会丢事件 —— 任务结束的那条正好撞上一轮慢请求就永远不刷了。
  if (refreshInFlight) {
    refreshQueued = true;
    return;
  }
  refreshInFlight = true;
  try {
    // loadRuns 要排在 loadTasks 前面：任务卡片上的"最近一次运行"读的是 runsCache
    await Promise.all([loadRuns(), loadBrowserStatus()]);
    await loadTasks();
  } catch {
    // 拉取失败不弹 toast —— 网络抖动会把屏幕刷满。
    // 真正的会话失效由 fetchJson 里的 401 分支处理，会直接跳登录页。
  } finally {
    refreshInFlight = false;
    if (refreshQueued) {
      refreshQueued = false;
      scheduleRefresh();
    }
  }
}

function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshStatus();
  }, REFRESH_DEBOUNCE_MS);
}

// SSE 断了才轮询，连上就停。两者不会同时跑。
function startFallbackPolling() {
  if (fallbackTimer) return;
  fallbackTimer = setInterval(() => {
    if (document.hidden || redirectingToLogin) return;
    refreshStatus();
  }, FALLBACK_POLL_MS);
}

function stopFallbackPolling() {
  if (!fallbackTimer) return;
  clearInterval(fallbackTimer);
  fallbackTimer = null;
}

let streamStarted = false;

function startStatusStream() {
  // 只允许启动一次。onerror 里会把 eventSource 置空（浏览器放弃重连时），
  // 不能拿它当"启没启动过"的判据，否则会重复注册 visibilitychange 监听。
  if (streamStarted) return;
  streamStarted = true;

  // 切回前台补一次：SSE 理论上不会漏，但标签页在后台被浏览器冻结时连接可能被掐，
  // 这一下能盖住"切回来发现状态是旧的"。注册一次，与连接生命周期无关。
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleRefresh();
  });

  if (typeof EventSource === 'undefined') {
    // 浏览器太老没有 EventSource：直接降级轮询
    startFallbackPolling();
    return;
  }

  eventSource = new EventSource(SSE_URL);

  // 连上了（含浏览器自动重连成功）。断线期间的变化没收到，所以补一次拉取。
  eventSource.onopen = () => {
    stopFallbackPolling();
    scheduleRefresh();
  };

  const onStateEvent = () => scheduleRefresh();
  eventSource.addEventListener('state', onStateEvent);
  eventSource.addEventListener('task', onStateEvent);
  eventSource.addEventListener('browser', onStateEvent);
  eventSource.addEventListener('warp', () => {
    if (!document.getElementById('warp-tab')?.hidden) loadWarpStatus();
  });

  eventSource.onerror = () => {
    // EventSource 自带重连，不用手动重建，这里只负责断开期间兜底轮询，
    // 等 onopen 再把轮询停掉。
    //
    // 会话失效时连接会以 401 失败落到这里。不在这里判断状态码 —— EventSource
    // 拿不到 —— 而是靠随后的降级轮询走 fetchJson，由它的 401 分支跳登录页。
    if (eventSource && eventSource.readyState === EventSource.CLOSED) {
      // CLOSED = 浏览器已放弃重连，之后只能靠轮询。显式 close 一下，避免留个
      // 半死的对象。
      eventSource.close();
      eventSource = null;
    }
    startFallbackPolling();
  };
}

async function runTask(id) {
  try {
    // 停止后立刻再启动：那条"停止中"覆盖还没被服务端确认清掉，它的优先级高于
    // runningTaskIds，不清掉的话下面的乐观点亮会被压住，按钮不变灰。
    clearStopping(id);
    runningTaskIds.add(id);
    await loadTasks();
    const task = tasksCache.find(item => item.id === id);
    const profileId = task && task.browser_profile_id
      ? Number(task.browser_profile_id)
      : null;
    await fetchJson(`/api/tasks/${id}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_id: profileId || null }),
    });
    toast(`任务 #${id} 已触发运行`, 'success');
  } catch (error) {
    toast(error.message || '启动失败', 'error');
  } finally {
    runningTaskIds.delete(id);
    await refreshAll();
  }
}

async function stopTask(id) {
  // 乐观更新：点击立刻恢复可点，不等任何网络往返。
  //
  // 原来是先 await fetchJson 再 refreshAll()，按钮要等一个完整往返加 7 个请求
  // 才变回来 —— 这就是"从灰色变回来比较慢"。启动方向本来就有这个优化
  // （runTask 先 add 再渲染），停止方向漏了。
  //
  // 用 stoppingTaskIds 而不是 runningTaskIds.delete()：isRunning 里两者是 OR，
  // 删掉只是不强制点亮，服务端此刻仍报 is_running=true，按钮还是灰的。
  markStopping(id);
  runningTaskIds.delete(id);
  renderTasks();
  try {
    await fetchJson(`/api/tasks/${id}/stop`, { method: 'POST' });
    toast(`停止指令已发送至任务 #${id}`, 'success');
  } catch (error) {
    // 失败：撤销乐观更新，按钮变回运行中
    clearStopping(id);
    renderTasks();
    toast(error.message || '停止失败', 'error');
  } finally {
    await refreshAll();
  }
}

function deleteTask(id) {
  dialogConfirm('确定要删除这个任务及其所有运行记录吗？', async () => {
    try {
      await fetchJson(`/api/tasks/${id}`, { method: 'DELETE' });
      toast('任务已删除', 'success');
      if (editingId === id) {
        resetAllModalState();
        closeModal();
      }
      await refreshAll();
    } catch (e) {
      toast(e.message || '删除失败', 'error');
    }
  });
}

function fillTaskForm(task) {
  form.name.value = task.name;
  form.type.value = String(task.script_path || '').toLowerCase().endsWith('.py') ? 'python' : task.type;
  form.script_path.value = task.script_path;
  form.timeout_sec.value = task.timeout_sec;
  // host2play 默认至少 900；已保存的更大值（如 1200）原样保留
  if (isHost2PlayScript(task.script_path) && Number(form.timeout_sec.value || 0) < 600) {
    form.timeout_sec.value = '900';
  }
  const schedule = parseTaskSchedule(task);
  form.elements.enabled.checked = schedule.enabled;
  scheduleModeSelect.value = schedule.mode;
  fixedDaysEl.value = schedule.fixedDays;
  fixedHoursEl.value = schedule.fixedHours;
  fixedMinutesEl.value = schedule.fixedMinutes;
  intervalMinEl.value = schedule.intervalMin;
  intervalMaxEl.value = schedule.intervalMax;
  intervalUnitEl.value = schedule.intervalUnit;
  if (dailyTimeStartEl) dailyTimeStartEl.value = schedule.dailyTimeStart;
  if (dailyTimeEndEl) dailyTimeEndEl.value = schedule.dailyTimeEnd;
  if (dailyDayMinEl) dailyDayMinEl.value = schedule.dailyDayMin;
  if (dailyDayMaxEl) dailyDayMaxEl.value = schedule.dailyDayMax;
  updateScheduleModeUI();
  fillConditionForm(task);
  // use_persistent=1 → 持久；否则默认临时（含历史任务字段缺失）
  setTaskProfileMode(Number(task.use_persistent) ? 'persistent' : 'temp');
  if (taskProfileSelect) {
    renderProfileOptions(taskProfileSelect, task.browser_profile_id || '');
  }
  if (form.elements.browser_profile_id) form.elements.browser_profile_id.value = task.browser_profile_id || '';
  renderTaskGroupOptions(document.getElementById('task-group-select'), task.group_id || '');
  let proxyValue = '';
  let proxyMode = 'inherit';
  let runtimeStack = '';
  if (Array.isArray(task.env) && task.env.length) {
    proxyValue = findManagedEnvValue(task.env, 'BROWSER_PROXY_VALUE') || findManagedEnvValue(task.env, 'BROWSER_PROXY');
    proxyMode = findManagedEnvValue(task.env, 'BROWSER_PROXY_MODE') || (proxyValue ? 'launch' : 'inherit');
    runtimeStack = findManagedEnvValue(task.env, 'BROWSER_RUNTIME_STACK');
    // Keep managed values available to dedicated controls; the editor itself
    // filters them from the ordinary variable list.
    syncTaskParamsUI(task.script_path, task.env);
  } else {
    const params = task.params || parseParamsJson(task.params_json);
    proxyValue = findManagedParamValue(params, 'BROWSER_PROXY_VALUE') || findManagedParamValue(params, 'BROWSER_PROXY');
    proxyMode = findManagedParamValue(params, 'BROWSER_PROXY_MODE') || (proxyValue ? 'launch' : 'inherit');
    runtimeStack = findManagedParamValue(params, 'BROWSER_RUNTIME_STACK');
    // Keep managed values available to dedicated controls; the editor itself
    // filters them from the ordinary variable list.
    syncTaskParamsUI(task.script_path, params);
  }
  setTaskBrowserProxyInput(proxyValue, runtimeStack, proxyMode);
  updateTaskProfileModeUI();
}

async function editTask(id) {
  const task = tasksCache.find(item => item.id === id);
  if (!task) return;
  editingId = id;
  fillTaskForm(task);
  selectedScriptPath = task.script_path;
  saveBtn.textContent = `保存修改 #${id}`;
  formTitle.textContent = `正在编辑任务 #${id}`;
  formHint.textContent = task.script_path ? `任务脚本：${getScriptLabel(task.script_path)}` : '只填任务名和定时规则。';
  renderScripts();
  openModal('edit');

  if (task.script_path) {
    try {
      await loadScriptIntoEditor(task.script_path, { preserveHint: true, reopenModal: false });
    } catch (error) {
      toast(error.message || '脚本读取失败', 'error');
    }
  }
}

function useScript(scriptPath, type) {
  selectedScriptPath = scriptPath;
  form.script_path.value = scriptPath;
  const resolvedType = String(scriptPath || '').toLowerCase().endsWith('.py') ? 'python' : type;
  form.type.value = resolvedType;
  if (isHost2PlayScript(scriptPath) && Number(form.elements.timeout_sec?.value || 0) < 600) {
    form.elements.timeout_sec.value = '900';
  }
  if (!form.name.value.trim()) form.name.value = scriptPath.split('/').pop().replace(/\.(js|py)$/i, '');
  formHint.textContent = `已选脚本：${getScriptLabel(scriptPath)}`;
  // Must pass full env rows (array), not flat params — secrets have empty value in UI
  syncTaskParamsUI(scriptPath, collectSafeCurrentEnvRows());
  renderScripts();
  updateTaskFormSummary();
  openModal(editingId ? 'edit' : 'create');
}

function collectSafeCurrentParams() {
  try {
    return collectTaskParamsFromForm();
  } catch {
    return {};
  }
}

function getSelectedScript() {
  const scriptPath = scriptSelectEl?.value || '';
  if (!scriptPath) {
    toast('操作前请先在列表中选中一个脚本', 'warn');
    return null;
  }
  return scriptsCache.find(item => item.path === scriptPath) || null;
}

async function loadScriptIntoEditor(scriptPath, options = {}) {
  const { preserveHint = false, reopenModal = true } = options;
  const script = scriptsCache.find(item => item.path === scriptPath);
  if (!script) return;
  const response = await fetch(`/${scriptPath.replace(/^\/+/, '')}`);
  if (!response.ok) throw new Error('脚本读取失败');
  const content = await response.text();
  selectedScriptPath = scriptPath;
  form.script_path.value = scriptPath;
  form.type.value = script.type;
  modalImportForm.elements.type.value = script.type;
  modalImportForm.elements.content.value = content;
  if (!preserveHint) formHint.textContent = `正在编辑脚本：${getScriptLabel(scriptPath)}`;
  renderScripts();
  updateTaskFormSummary();
  if (reopenModal) openModal(editingId ? 'edit' : 'create');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.elements.script_path.value) {
    toast('请先在下方选择或导入要运行的脚本文件', 'warn');
    return;
  }
  let env;
  let params;
  try {
    env = collectTaskEnvFromForm();
    params = collectTaskParamsFromForm();
  } catch (error) {
    toast(error.message || 'Invalid task env', 'error');
    return;
  }

  const schedule = buildSchedulePayloadFromForm();
  let conditionPayload;
  try {
    conditionPayload = buildConditionPayloadFromForm();
  } catch (error) {
    toast(error.message || '条件配置无效', 'error');
    return;
  }
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());
  Object.assign(payload, schedule, conditionPayload);
  // FormData may stringify checkboxes; force boolean flags from builders
  payload.enabled = Boolean(schedule.enabled);
  payload.condition_enabled = Boolean(conditionPayload.condition_enabled);
  if (String(payload.script_path || '').toLowerCase().endsWith('.py')) {
    payload.type = 'python';
  }
  payload.use_browser = true;
  // 默认临时；仅当用户明确选「持久配置」才写 use_persistent=1
  const wantPersistent = !isTaskTempProfileMode();
  payload.use_persistent = wantPersistent;
  payload.timeout_sec = Number(payload.timeout_sec || 300);
  if (isHost2PlayScript(payload.script_path) && payload.timeout_sec < 600) {
    payload.timeout_sec = 900;
  }
  payload.browser_profile_id = taskProfileSelect && taskProfileSelect.value ? Number(taskProfileSelect.value) : null;
  payload.group_id = payload.group_id ? Number(payload.group_id) : null;
  // 临时/持久只走 use_persistent 字段，不再写入可见 env 列表
  const envByName = new Map(env.map((e) => [e.name, e]));
  deleteManagedMapKeys(envByName, [
    'USE_TEMP_PROFILE',
    'BROWSER_PROXY',
    'BROWSER_RUNTIME_STACK',
    'BROWSER_PROXY_MODE',
    'BROWSER_PROXY_VALUE',
    'BROWSER_RUYI_FPFILE',
    ...PROXY_ENV_ALIAS_KEYS,
    'BROWSER_LOCALE',
    'BROWSER_TIMEZONE',
  ]);

  // 全局 Telegram 开关：只存内部键，列表展示时会过滤掉
  const useGlobalTg = taskUseGlobalTelegram ? taskUseGlobalTelegram.checked : true;
  envByName.set('USE_GLOBAL_TELEGRAM', {
    name: 'USE_GLOBAL_TELEGRAM',
    value: useGlobalTg ? '1' : '0',
    is_secret: 0,
  });
  if (useGlobalTg) {
    for (const k of ['TG_TOKEN', 'TG_BOT_TOKEN', 'TG_CHAT_ID', 'CHAT_ID', 'TG_PROXY', 'TG_PROXY_URL']) {
      const cur = envByName.get(k);
      if (cur && !String(cur.value || '').trim()) envByName.delete(k);
    }
  }

  // Dedicated browser controls are stored as canonical, non-secret env entries.
  const taskBrowserProxy = getTaskBrowserProxyFromForm();
  for (const [name, value] of [
    ['BROWSER_RUNTIME_STACK', taskBrowserProxy.runtimeStack],
    ['BROWSER_PROXY_MODE', taskBrowserProxy.mode],
    ['BROWSER_PROXY_VALUE', taskBrowserProxy.value],
  ]) {
    if (value) {
      envByName.set(name, { name, value, is_secret: 0 });
    }
  }

  payload.env = [...envByName.values()].filter((e) => {
    const n = String(e.name || '').toUpperCase();
    return n !== 'USE_TEMP_PROFILE';
  });
  payload.params = {
    ...params,
    USE_GLOBAL_TELEGRAM: useGlobalTg ? '1' : '0',
  };
  deleteManagedObjectKeys(payload.params, [
    'USE_TEMP_PROFILE',
    'BROWSER_PROXY',
    'BROWSER_RUNTIME_STACK',
    'BROWSER_PROXY_MODE',
    'BROWSER_PROXY_VALUE',
    'BROWSER_RUYI_FPFILE',
    'BROWSER_LOCALE',
    'BROWSER_TIMEZONE',
  ]);
  if (taskBrowserProxy.runtimeStack) payload.params.BROWSER_RUNTIME_STACK = taskBrowserProxy.runtimeStack;
  if (taskBrowserProxy.mode) payload.params.BROWSER_PROXY_MODE = taskBrowserProxy.mode;
  if (taskBrowserProxy.value) payload.params.BROWSER_PROXY_VALUE = taskBrowserProxy.value;
  const url = editingId ? `/api/tasks/${editingId}` : '/api/tasks';
  const method = editingId ? 'PUT' : 'POST';
  await fetchJson(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  toast(editingId ? '任务已更新' : '任务已成功添加', 'success');
  resetAllModalState();
  closeModal();
  await refreshAll();
});

async function saveScriptFromForm(sourceForm) {
  const formData = new FormData(sourceForm);
  const type = String(formData.get('type') || 'javascript');
  const content = String(formData.get('content') || '');
  // Prefer currently selected/bound script name so re-import overwrites the same file
  const currentBound = String(form.elements.script_path?.value || selectedScriptPath || '').replace(/\\/g, '/');
  let name = '';
  if (currentBound.startsWith('tasks/')) {
    name = pathBasename(currentBound);
  }
  if (!name) {
    const taskName = String(form.elements.name.value || '').trim();
    if (!taskName) throw new Error('请先填写任务名，或先选中要覆盖的脚本');
    const baseName = slugifyName(taskName);
    name = baseName;
    if (type === 'python' && !name.endsWith('.py')) name += '.py';
    if (type === 'javascript' && !name.endsWith('.js')) name += '.js';
  }
  // Force extension to match type if user switched type
  if (type === 'python' && !name.endsWith('.py')) name = name.replace(/\.(js)?$/i, '') + '.py';
  if (type === 'javascript' && !name.endsWith('.js')) name = name.replace(/\.(py)?$/i, '') + '.js';
  return fetchJson('/api/scripts/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, content, overwrite: true }),
  });
}

function pathBasename(p) {
  const s = String(p || '').replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

async function deleteSelectedScript() {
  const script = getSelectedScript();
  if (!script) return;
  dialogConfirm(`确定删除脚本「${script.name}」？\n（有任务绑定该脚本时会拒绝删除）`, async () => {
    try {
      await fetchJson('/api/scripts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: script.path }),
      });
      if (selectedScriptPath === script.path) {
        selectedScriptPath = '';
        if (form.elements.script_path) form.elements.script_path.value = '';
      }
      await loadScripts();
      toast('脚本已删除', 'success');
    } catch (error) {
      toast(error.message || '删除失败', 'error');
    }
  });
}

modalImportForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (modalImportBtn) {
    modalImportBtn.disabled = true;
    modalImportBtn.textContent = '保存中...';
  }

  try {
    const result = await saveScriptFromForm(modalImportForm);
    selectedScriptPath = result.data.path;
    form.script_path.value = result.data.path;
    form.type.value = result.data.type;
    // BUGFIX: previously used collectSafeCurrentParams() (flat object). Secret values are
    // always '' in the UI, so entriesFromParamsObject dropped PASSWORD_* etc. Then Save
    // called replaceEnvEntries and deleted those keys from DB. Keep full env rows instead.
    syncTaskParamsUI(result.data.path, collectSafeCurrentEnvRows());
    if (!form.name.value.trim()) form.name.value = result.data.name.replace(/\.(js|py)$/i, '');
    updateTaskFormSummary();
    openModal(editingId ? 'edit' : 'create');
    formHint.textContent = result.data.overwritten
      ? `已覆盖脚本：${getScriptLabel(result.data.path)}`
      : `已保存脚本：${getScriptLabel(result.data.path)}`;
    try {
      await loadScripts();
    } catch (error) {
      scriptsCache = [
        ...scriptsCache.filter(item => item.path !== result.data.path),
        { name: result.data.name, path: result.data.path, type: result.data.type },
      ];
    }
    renderScripts();
    toast(result.data.overwritten ? '脚本已覆盖保存' : '脚本已导入', 'success');
  } catch (error) {
    toast(error.message || '脚本保存失败', 'error');
  } finally {
    if (modalImportBtn) {
      modalImportBtn.disabled = false;
      modalImportBtn.textContent = '导入脚本';
    }
  }
});

resetBtn.addEventListener('click', () => { resetAllModalState(); closeModal(); });
modalCloseBtn.addEventListener('click', closeModal);
modalMask.addEventListener('click', closeModal);
refreshScriptsModalBtn.addEventListener('click', loadScripts);
addTaskBtn.addEventListener('click', () => { resetAllModalState(); renderScripts(); openModal('create'); });
openBrowserBtn.addEventListener('click', openBrowserSession);
if (addProfileBtn) addProfileBtn.addEventListener('click', () => openProfileModal(null));
closeBrowserBtn.addEventListener('click', closeBrowserSession);
useScriptBtn.addEventListener('click', () => {
  const script = getSelectedScript();
  if (!script) return;
  useScript(script.path, script.type);
});
editScriptBtn.addEventListener('click', async () => {
  const script = getSelectedScript();
  if (!script) return;
  try {
    await loadScriptIntoEditor(script.path);
  } catch (error) {
    toast(error.message || '脚本读取失败', 'error');
  }
});
const deleteScriptBtn = document.getElementById('delete-script-btn');
if (deleteScriptBtn) {
  deleteScriptBtn.addEventListener('click', () => {
    deleteSelectedScript();
  });
}
scheduleModeSelect.addEventListener('change', () => {
  updateScheduleModeUI();
  updateTaskFormSummary();
});

const scheduleEnabledEl = form?.elements?.enabled || document.getElementById('schedule-enabled');
if (scheduleEnabledEl) {
  scheduleEnabledEl.addEventListener('change', updateScheduleDetailsUI);
}

if (conditionEnabledEl) {
  conditionEnabledEl.addEventListener('change', updateConditionFieldsUI);
}
if (conditionTypeEl) {
  conditionTypeEl.addEventListener('change', updateConditionFieldsUI);
}
[
  conditionWindowValueEl,
  conditionWindowUnitEl,
  conditionJitterMinEl,
  conditionJitterMaxEl,
  conditionJitterUnitEl,
].forEach((el) => {
  if (!el) return;
  el.addEventListener('input', updateRemainingThresholdPreview);
  el.addEventListener('change', updateRemainingThresholdPreview);
});

// Keep footer summary in sync with common fields
['name', 'timeout_sec'].forEach((name) => {
  const el = form?.elements?.[name];
  if (el) el.addEventListener('input', updateTaskFormSummary);
});

if (conditionTestBtn) {
  conditionTestBtn.addEventListener('click', async () => {
    try {
      let conditionPayload;
      try {
        // Force enabled for test payload construction
        const was = conditionEnabledEl ? conditionEnabledEl.checked : true;
        if (conditionEnabledEl) conditionEnabledEl.checked = true;
        try {
          conditionPayload = buildConditionPayloadFromForm();
        } finally {
          if (conditionEnabledEl) conditionEnabledEl.checked = was;
        }
      } catch (err) {
        // allow test with URL even if checkbox off (http only)
        if (getConditionType() === 'remaining_callback') throw err;
        const url = String(conditionUrlEl?.value || '').trim();
        if (!url) throw err;
        conditionPayload = {
          condition_enabled: true,
          condition: {
            type: 'http_check',
            check_interval_sec: unitValueToSec(conditionCheckIntervalEl?.value || 5, conditionCheckUnitEl?.value || 'minutes', 30),
            cooldown_sec: unitValueToSec(conditionCooldownEl?.value || 10, conditionCooldownUnitEl?.value || 'minutes', 0),
            config: {
              url,
              method: conditionMethodEl?.value || 'GET',
              timeout_ms: Math.min(60000, Math.max(1000, (Number(conditionTimeoutEl?.value) || 10) * 1000)),
              success_statuses: String(conditionSuccessStatusesEl?.value || '200-399').trim() || '200-399',
              expect_body_includes: String(conditionExpectBodyEl?.value || '').trim(),
              proxy: String(conditionProxyEl?.value || '').trim(),
            },
          },
        };
      }
      if (!conditionPayload.condition) {
        toast(getConditionType() === 'remaining_callback' ? '请先配置剩余时间回调' : '请先填写检测 URL', 'warn');
        return;
      }
      conditionTestBtn.disabled = true;
      conditionTestBtn.textContent = '检测中...';
      const body = { condition: conditionPayload.condition };
      let result;
      if (editingId) {
        const res = await fetchJson(`/api/tasks/${editingId}/condition/test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        result = res.data;
      } else {
        // create mode: temporary evaluate via a lightweight path — call types not available;
        // reuse test endpoint requires id; fall back to fetch probe message
        toast('请先保存任务后再测试，或保存后编辑里点测试', 'warn');
        return;
      }
      const triggerHint = result.shouldTrigger ? '（将触发任务）' : '（不触发）';
      toast(`${result.status}: ${result.detail || ''} ${triggerHint}`, result.shouldTrigger ? 'warn' : 'success');
      if (conditionLastStatusText) {
        conditionLastStatusText.textContent = `最近：${result.status}${result.detail ? ` · ${result.detail}` : ''}`;
      }
    } catch (error) {
      toast(error.message || '检测失败', 'error');
    } finally {
      if (conditionTestBtn) {
        conditionTestBtn.disabled = false;
        conditionTestBtn.innerHTML = '<i data-lucide="radar" class="icon-sm"></i> 测试检测';
        if (window.lucide) window.lucide.createIcons();
      }
    }
  });
}
fixedDaysEl.addEventListener('input', updateFixedSummary);
fixedHoursEl.addEventListener('input', updateFixedSummary);
fixedMinutesEl.addEventListener('input', updateFixedSummary);
intervalMinEl.addEventListener('input', updateIntervalSummary);
intervalMaxEl.addEventListener('input', updateIntervalSummary);
intervalUnitEl.addEventListener('change', updateIntervalSummary);
dailyTimeStartEl?.addEventListener('input', updateDailyWindowSummary);
dailyTimeEndEl?.addEventListener('input', updateDailyWindowSummary);
dailyDayMinEl?.addEventListener('input', updateDailyWindowSummary);
dailyDayMaxEl?.addEventListener('input', updateDailyWindowSummary);

window.runTask = runTask;
window.stopTask = stopTask;
window.deleteTask = deleteTask;
window.editTask = editTask;
window.useScript = useScript;
window.loadScriptIntoEditor = loadScriptIntoEditor;
window.showTaskRuns = showTaskRuns;
window.openRunScreenshots = openRunScreenshots;

if (tgForm) {
  tgForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const botToken = tgBotToken.value.trim();
    const chatId = tgChatId.value.trim();
    const proxy = tgProxy ? tgProxy.value.trim() : '';
    const webhookUrl = tgWebhookUrl ? tgWebhookUrl.value.trim() : '';

    tgSaveBtn.disabled = true;
    tgSaveBtn.textContent = '保存中...';

    try {
      const response = await fetchJson('/api/settings/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken, chatId, proxy, webhookUrl }),
      });
      const settings = response.data || {};
      if (settings.webhookStatus === 'registered') {
        toast('Telegram \u8bbe\u7f6e\u5df2\u4fdd\u5b58\uff0cWebhook \u5df2\u6ce8\u518c', 'success');
      } else {
        toast(`Telegram \u8bbe\u7f6e\u5df2\u4fdd\u5b58\uff0cWebhook \u672a\u5c31\u7eea\uff1a${settings.webhookError || '\u8bf7\u68c0\u67e5\u516c\u7f51 HTTPS \u5730\u5740'}`, 'error');
      }
      await loadTelegramSettings();
    } catch (error) {
      toast(error.message || '\u4fdd\u5b58\u8bbe\u7f6e\u9047\u5230\u4e86\u9519\u8bef', 'error');
    } finally {
      tgSaveBtn.disabled = false;
      tgSaveBtn.textContent = '\u4fdd\u5b58\u8bbe\u7f6e';
    }
  });
}

if (tgTestBtn) {
  tgTestBtn.addEventListener('click', async () => {
    tgTestBtn.disabled = true;
    tgTestBtn.textContent = '\u53d1\u9001\u4e2d...';

    try {
      await fetchJson('/api/settings/telegram/test', { method: 'POST' });
      toast('\u4e00\u6761\u6d4b\u8bd5\u7528\u63a8\u9001\u5df2\u53d1\u5f80\u4f60\u7684 Telegram', 'success');
    } catch (error) {
      toast(error.message || '\u53d1\u9001\u63a8\u9001\u5230 Telegram \u5931\u8d25', 'error');
    } finally {
      tgTestBtn.disabled = false;
      tgTestBtn.textContent = '\u53d1\u9001\u6d4b\u8bd5\u6d88\u606f';
    }
  });
}

if (visionAddChannelBtn) {
  visionAddChannelBtn.addEventListener('click', () => {
    if (!visionChannelsList) return;
    const count = visionChannelsList.querySelectorAll('[data-vision-channel]').length;
    visionChannelsList.appendChild(makeVisionChannelCard({}, count));
    renumberVisionChannels();
    if (window.lucide) window.lucide.createIcons();
  });
}

/** Open modal: test a specific channel card (or primary if omitted). */
function openVisionTestModalForCard(cardEl) {
  const channel = readVisionChannelFromCard(cardEl) || collectVisionChannels()[0] || {};
  const targetCard = channel.card || cardEl || null;
  if (!channel.baseUrl) {
    toast('请先填写该通道 Base URL', 'warn');
    return;
  }
  if (!channel.model) {
    toast('建议填写 Model 后再测识图；仍可先测连通与模型列表', 'warn');
  }

  const cards = visionChannelsList
    ? Array.from(visionChannelsList.querySelectorAll('[data-vision-channel]'))
    : [];
  const idx = targetCard ? Math.max(0, cards.indexOf(targetCard)) : 0;
  const isPrimary = idx === 0;
  const channelLabel = isPrimary ? '主通道' : `通道 ${idx}`;

  const mask = document.createElement('div');
  mask.className = 'modal-mask open';
  mask.style.zIndex = '10020';
  const dialog = document.createElement('section');
  dialog.className = 'modal modal-wide open vision-test-modal';
  dialog.style.zIndex = '10030';
  dialog.setAttribute('aria-hidden', 'false');

  dialog.innerHTML = ''
    + '<div class="modal-header">'
    + '  <div>'
    + `    <h2>测试 AI · ${escapeHtml(channelLabel)}</h2>`
    + '    <p class="muted">连通性 · 拉取模型 · 图片识别（不自动保存）</p>'
    + '  </div>'
    + '  <button class="icon-btn" type="button" aria-label="关闭" data-close-vision-test>'
    + '    <i data-lucide="x" class="icon-md"></i>'
    + '  </button>'
    + '</div>'
    + '<div class="modal-body" style="padding:16px 20px 20px;">'
    + '  <div class="schedule-note" style="margin-bottom:12px;">'
    + `    ${escapeHtml(channel.baseUrl || '')}`
    + (channel.model ? ` · 模型 ${escapeHtml(channel.model)}` : '')
    + '    · Key 留空则用已保存的 Key'
    + '  </div>'
    + '  <div class="row" style="gap:8px; flex-wrap:wrap; margin-bottom:12px;">'
    + '    <button type="button" class="btn-primary btn-with-icon" data-vision-run-test>'
    + '      <i data-lucide="radar" class="icon-sm"></i> 开始测试'
    + '    </button>'
    + '    <button type="button" class="alt btn-with-icon" data-vision-fetch-models>'
    + '      <i data-lucide="list" class="icon-sm"></i> 仅拉取模型'
    + '    </button>'
    + (isPrimary
      ? ''
      : '    <button type="button" class="alt btn-with-icon" data-vision-make-primary>'
        + '      <i data-lucide="star" class="icon-sm"></i> 设为主通道'
        + '    </button>')
    + '  </div>'
    + '  <div data-vision-test-status class="muted" style="margin-bottom:10px;">测试中…</div>'
    + '  <div data-vision-test-results class="vision-test-results" hidden></div>'
    + '  <div data-vision-model-chips class="vision-model-chips" style="margin-top:12px;" hidden></div>'
    + '</div>';

  const close = () => {
    mask.remove();
    dialog.remove();
  };

  const statusEl = dialog.querySelector('[data-vision-test-status]');
  const resultsEl = dialog.querySelector('[data-vision-test-results]');
  const chipsEl = dialog.querySelector('[data-vision-model-chips]');
  const runBtn = dialog.querySelector('[data-vision-run-test]');
  const modelsOnlyBtn = dialog.querySelector('[data-vision-fetch-models]');
  const makePrimaryBtn = dialog.querySelector('[data-vision-make-primary]');

  const mark = (ok) => (ok
    ? '<span style="color:#86efac;">✓</span>'
    : '<span style="color:#fca5a5;">✗</span>');

  const fillModelIntoThisChannel = (id) => {
    const modelInput = targetCard && targetCard.querySelector('.vision-ch-model');
    if (modelInput) {
      modelInput.value = id;
      toast(`已填入该通道模型: ${id}`, 'success');
    }
  };

  const renderResult = (data) => {
    if (!resultsEl) return;
    resultsEl.hidden = false;
    const c = data.connectivity || {};
    const m = data.models || {};
    const img = data.image || {};
    const keyHint = data.usedKeyHint
      ? `<div class="muted" style="margin-bottom:8px;font-size:12px;">实际使用 Key: ${escapeHtml(data.usedKeyHint)} · ${escapeHtml(data.usedBaseUrl || '')}</div>`
      : '';
    const imgPassed = img.supported || img.ok;
    const tried = Array.isArray(img.tried) ? img.tried : [];
    const textOnlyBlock = img.textOnly
      ? `<div style="margin-top:6px;font-size:12px;"><strong>纯文本对照</strong> ${mark(img.textOnly.ok)} `
        + `${escapeHtml(img.textOnly.detail || '')}</div>`
      : '';
    // On success the winning body shape is the actionable bit: scripts must send the
    // same shape, and "bare" vs "max_tokens=..." decides whether they will get a 400.
    const shapeBlock = (imgPassed && img.shape)
      ? `<div class="muted" style="margin-top:4px;font-size:12px;">命中请求形状: <code>${escapeHtml(img.shape)}</code></div>`
      : '';
    // Show the trace whenever something was rejected — including a success that only
    // landed on a later shape, since the earlier rejections are what scripts must avoid.
    const showTried = tried.length > 0 && (!imgPassed || tried.length > 1);
    const triedBlock = showTried
      ? '<details style="margin-top:6px;">'
        + '<summary class="muted" style="cursor:pointer;font-size:12px;">'
        + (imgPassed
          ? `前 ${tried.length - 1} 种被拒，第 ${tried.length} 种通过 · 展开看逐条结果`
          : `已试 ${tried.length} 种请求组合 · 展开看逐条结果`)
        + '</summary>'
        + '<ul style="margin:6px 0 0 18px;padding:0;font-size:12px;line-height:1.7;">'
        + tried.map((t) => '<li>'
          + `<code>${escapeHtml(t.label || '')}</code> → `
          + `<strong>${escapeHtml(String(t.status || 'ERR'))}</strong> `
          + `${escapeHtml((t.detail || '').slice(0, 160))}</li>`).join('')
        + '</ul></details>'
      : '';
    resultsEl.innerHTML = ''
      + keyHint
      + '<div class="vision-test-grid">'
      + `  <div><strong>连通性</strong> ${mark(c.ok)} `
      + (c.ok
        ? `<span style="color:#86efac;">正常</span> · ${c.ms != null ? c.ms + 'ms' : ''} `
          + (c.label ? `<span class="pill" style="margin-left:4px;">${escapeHtml(c.label)}</span>` : '')
        : `<span style="color:#fca5a5;">失败</span> · ${escapeHtml(c.detail || '')}`)
      + '  </div>'
      + `  <div><strong>模型列表</strong> ${mark(m.ok || m.count > 0)} `
      + escapeHtml(m.detail || (m.count ? `读到 ${m.count} 个` : '—'))
      + '  </div>'
      + `  <div><strong>图片识别</strong> ${mark(imgPassed)} `
      + (imgPassed
        ? `<span style="color:#86efac;">支持</span> · ${escapeHtml(data.model || '')} · ${img.ms != null ? img.ms + 'ms' : ''}`
          + (img.preview ? `<div class="muted" style="margin-top:4px;">回复: ${escapeHtml(img.preview)}</div>` : '')
          + shapeBlock
        : `<span style="color:#fca5a5;">未通过</span> · ${escapeHtml(img.detail || '未测')}`)
      + textOnlyBlock
      + triedBlock
      + '  </div>'
      + '</div>'
      + `<div class="vision-test-summary ${data.ok ? 'is-ok' : 'is-bad'}">${escapeHtml(data.summary || '')}</div>`;

    const ids = Array.isArray(m.ids) ? m.ids : [];
    if (chipsEl) {
      if (!ids.length) {
        chipsEl.hidden = true;
        chipsEl.innerHTML = '';
        return;
      }
      chipsEl.hidden = false;
      const currentModel = (
        (targetCard && targetCard.querySelector('.vision-ch-model')?.value)
        || channel.model
        || ''
      ).trim();
      chipsEl.innerHTML = ''
        + `<div class="muted" style="margin-bottom:6px;">可用模型（${ids.length}）· 点击填入<strong>此通道</strong> Model</div>`
        + '<div class="vision-chip-row">'
        + ids.slice(0, 60).map((id) => {
          const selected = id === currentModel ? ' is-selected' : '';
          return `<button type="button" class="vision-model-chip${selected}" data-model-id="${escapeHtml(id)}">${escapeHtml(id)}</button>`;
        }).join('')
        + '</div>';
      chipsEl.querySelectorAll('[data-model-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-model-id') || '';
          fillModelIntoThisChannel(id);
          chipsEl.querySelectorAll('.vision-model-chip').forEach((b) => b.classList.remove('is-selected'));
          btn.classList.add('is-selected');
        });
      });
    }
  };

  const runTest = async ({ testImage }) => {
    // Re-read form values in case user edited while modal open
    const live = readVisionChannelFromCard(targetCard) || channel;
    if (!live.baseUrl) {
      toast('该通道 Base URL 为空', 'error');
      return;
    }
    if (statusEl) statusEl.textContent = '测试中…';
    if (runBtn) runBtn.disabled = true;
    if (modelsOnlyBtn) modelsOnlyBtn.disabled = true;
    try {
      const res = await fetchJson('/api/settings/vision/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: live.id || '',
          baseUrl: live.baseUrl,
          apiKey: live.apiKey || '',
          model: live.model || '',
          fetchModels: true,
          testImage: Boolean(testImage),
        }),
      });
      const data = res.data || {};
      if (statusEl) {
        statusEl.textContent = data.ok ? '测试完成 · 可用' : '测试完成 · 存在问题';
        statusEl.style.color = data.ok ? '#86efac' : '#fcd34d';
      }
      renderResult(data);
    } catch (error) {
      if (statusEl) {
        statusEl.textContent = '测试失败';
        statusEl.style.color = '#ef4444';
      }
      if (resultsEl) {
        resultsEl.hidden = false;
        resultsEl.innerHTML = `<div class="vision-test-summary is-bad">${escapeHtml(error.message || String(error))}</div>`;
      }
      toast(error.message || 'Vision 测试失败', 'error');
    } finally {
      if (runBtn) runBtn.disabled = false;
      if (modelsOnlyBtn) modelsOnlyBtn.disabled = false;
    }
  };

  dialog.querySelector('[data-close-vision-test]').addEventListener('click', close);
  runBtn.addEventListener('click', () => runTest({ testImage: true }));
  modelsOnlyBtn.addEventListener('click', () => runTest({ testImage: false }));
  if (makePrimaryBtn && targetCard) {
    makePrimaryBtn.addEventListener('click', () => {
      promoteVisionChannelCard(targetCard);
      close();
    });
  }
  mask.addEventListener('click', close);

  document.body.appendChild(mask);
  document.body.appendChild(dialog);
  if (window.lucide) window.lucide.createIcons({ root: dialog });
  runTest({ testImage: true });
}

// Backward-compatible alias
function openVisionTestModal() {
  const first = visionChannelsList && visionChannelsList.querySelector('[data-vision-channel]');
  openVisionTestModalForCard(first);
}

if (backupSelectBtn) {
  backupSelectBtn.addEventListener('click', () => setBackupSelectionMode(!backupSelectionMode));
}
if (backupSelectCancelBtn) {
  backupSelectCancelBtn.addEventListener('click', () => setBackupSelectionMode(false));
}
if (backupSelectAll) {
  backupSelectAll.addEventListener('change', () => {
    if (backupSelectAll.checked) tasksCache.forEach((task) => selectedBackupTaskIds.add(Number(task.id)));
    else selectedBackupTaskIds.clear();
    updateBackupSelectionUi();
    lastTasksHtml = null;
    renderTasks();
  });
}
if (backupExportBtn) {
  backupExportBtn.addEventListener('click', () => {
    if (!selectedBackupTaskIds.size) return;
    const ids = [...selectedBackupTaskIds];
    if (backupIncludeSecrets && backupIncludeSecrets.checked) {
      // 带配置 ⇒ 必须加密。密码只在这一刻存在于内存里，不落库、不进 URL。
      dialogPassphrase(
        '导出文件将包含所有环境变量的值，整体加密后保存。密码不会被保存，忘记就无法恢复。',
        (passphrase) => startBackupExport(ids, passphrase),
      );
      return;
    }
    // 不带配置 ⇒ 只有变量名，可以放心分享，不需要密码。
    startBackupExport(ids, null);
  });
}
if (backupImportBtn && backupFileInput) {
  backupImportBtn.addEventListener('click', () => backupFileInput.click());
  backupFileInput.addEventListener('change', async () => {
    const file = backupFileInput.files && backupFileInput.files[0];
    backupFileInput.value = '';
    if (!file) return;
    try {
      await previewBackupFile(file);
    } catch (error) {
      toast(error.message || '读取备份文件失败', 'error');
    }
  });
}
if (backupImportMask) backupImportMask.addEventListener('click', closeBackupImportModal);

if (visionTestBtn) {
  // Legacy top-level button (if still in DOM): test primary
  visionTestBtn.addEventListener('click', () => openVisionTestModal());
}

if (visionForm) {
  visionForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const channelList = collectVisionChannels();
    if (!channelList.length) {
      toast('请至少配置一个视觉通道', 'error');
      return;
    }
    for (let i = 0; i < channelList.length; i += 1) {
      const ch = channelList[i];
      if (!ch.baseUrl || !ch.model) {
        toast(`${i === 0 ? '主通道' : `备用通道 ${i}`} 需要填写 Base URL 和 Model`, 'error');
        return;
      }
    }
    if (visionSaveBtn) {
      visionSaveBtn.disabled = true;
      visionSaveBtn.textContent = 'Saving...';
    }
    try {
      await fetchJson('/api/settings/vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelList }),
      });
      toast('Vision settings saved', 'success');
      await loadVisionSettings();
    } catch (error) {
      toast(error.message || 'Failed to save vision settings', 'error');
    } finally {
      if (visionSaveBtn) {
        visionSaveBtn.disabled = false;
        visionSaveBtn.textContent = 'Save Vision Settings';
      }
    }
  });
}

if (schedulerForm) {
  schedulerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (schedulerSaveBtn) {
      schedulerSaveBtn.disabled = true;
      schedulerSaveBtn.textContent = '保存中...';
    }
    try {
      await saveSchedulerSettings();
      toast('调度设置已保存', 'success');
    } catch (error) {
      toast(error.message || '保存调度设置失败', 'error');
    } finally {
      if (schedulerSaveBtn) {
        schedulerSaveBtn.disabled = false;
        schedulerSaveBtn.innerHTML = '<i data-lucide="save" class="icon-sm"></i> 保存调度设置';
        if (window.lucide) window.lucide.createIcons();
      }
    }
  });
}

if (cloudBackupForm) {
  cloudBackupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (cloudBackupSaveBtn) {
      cloudBackupSaveBtn.disabled = true;
      cloudBackupSaveBtn.textContent = '保存中...';
    }
    try {
      await saveCloudBackupSettings();
    } catch (error) {
      toast(error.message || '保存云端备份设置失败', 'error');
    } finally {
      if (cloudBackupSaveBtn) {
        cloudBackupSaveBtn.disabled = false;
        cloudBackupSaveBtn.innerHTML = '<i data-lucide="save" class="icon-sm"></i> 保存设置';
        if (window.lucide) window.lucide.createIcons();
      }
    }
  });
}
if (cloudBackupTestBtn) cloudBackupTestBtn.addEventListener('click', testCloudBackupConnection);
if (cloudBackupClearBtn) {
  cloudBackupClearBtn.addEventListener('click', async () => {
    if (!confirm('确定要清空云端备份的所有配置吗？已填写的密钥、密码等将全部清除。')) return;
    try {
      cloudBackupClearBtn.disabled = true;
      cloudBackupClearBtn.textContent = '清空中...';
      await fetchJson('/api/cloud-backup/settings', { method: 'DELETE' });
      toast('云端备份配置已清空', 'success');
      await loadCloudBackupSettings();
    } catch (error) {
      toast(error.message || '清空失败', 'error');
    } finally {
      cloudBackupClearBtn.disabled = false;
      cloudBackupClearBtn.innerHTML = '<i data-lucide="trash-2" class="icon-sm"></i> 清空配置';
      if (window.lucide) window.lucide.createIcons();
    }
  });
}
if (cloudBackupRunBtn) cloudBackupRunBtn.addEventListener('click', runCloudBackupNow);
if (cloudBackupRefreshBtn) cloudBackupRefreshBtn.addEventListener('click', loadCloudBackupList);
if (cloudBackupSchedule) cloudBackupSchedule.addEventListener('change', updateCloudBackupTimeFields);
if (cloudBackupList) {
  cloudBackupList.addEventListener('click', (e) => {
    const items = cloudBackupList._items || [];
    const previewBtn = e.target.closest('[data-cloud-preview]');
    if (previewBtn) {
      const item = items[Number(previewBtn.dataset.cloudPreview)];
      if (item) previewCloudBackup(item.key);
      return;
    }
    const restoreBtn = e.target.closest('[data-cloud-restore]');
    if (restoreBtn) {
      const item = items[Number(restoreBtn.dataset.cloudRestore)];
      if (item) previewCloudBackup(item.key);
    }
  });
}
if (cloudRestoreMask) cloudRestoreMask.addEventListener('click', closeCloudRestoreModal);
if (cloudBackupUploadBtn && cloudBackupUploadInput) {
  cloudBackupUploadBtn.addEventListener('click', () => {
    cloudBackupUploadInput.click();
  });
  cloudBackupUploadInput.addEventListener('change', uploadCloudBackupRestore);
}

if (successHeuristicsForm) {
  successHeuristicsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (shSaveBtn) {
      shSaveBtn.disabled = true;
      shSaveBtn.textContent = '保存中...';
    }
    try {
      await saveSuccessHeuristicsSettings();
      toast('GitHub 兼容设置已保存', 'success');
    } catch (error) {
      toast(error.message || '保存失败', 'error');
    } finally {
      if (shSaveBtn) {
        shSaveBtn.disabled = false;
        shSaveBtn.innerHTML = '<i data-lucide="save" class="icon-sm"></i> 保存兼容设置';
        if (window.lucide) window.lucide.createIcons();
      }
    }
  });
}

if (brProxyMode) {
  brProxyMode.addEventListener('change', () => updateProxyModeUI(brProxyMode, brProxyValue, brProxyValueField));
  updateProxyModeUI(brProxyMode, brProxyValue, brProxyValueField);
}

if (browserRuntimeForm) {
  browserRuntimeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (brSaveBtn) {
      brSaveBtn.disabled = true;
      brSaveBtn.textContent = '保存中...';
    }
    try {
      await saveBrowserRuntimeSettings();
      toast('浏览器运行时配置已保存', 'success');
    } catch (error) {
      toast(error.message || '保存运行时配置失败', 'error');
    } finally {
      if (brSaveBtn) {
        brSaveBtn.disabled = false;
        brSaveBtn.textContent = '保存运行时配置';
      }
    }
  });
}

if (brInstallBtn) {
  brInstallBtn.addEventListener('click', async () => {
    if (brInstallBtn.disabled) return;
    if (brRuntimeStack && brRuntimeStack.value !== 'playwright') {
      toast('当前运行栈不是 Playwright，请使用“安装浏览器环境”', 'warn');
      return;
    }
    brInstallBtn.disabled = true;
    brInstallBtn.textContent = '安装中...';
    setBrowserRuntimeStatus('状态：正在安装插件...', '#facc15');
    try {
      await installBrowserRuntimePackages();
      setBrowserRuntimeStatus('状态：插件安装完成，请重启服务生效', '#86efac');
      toast('插件已安装完成，请重启服务后生效', 'success');
    } catch (error) {
      setBrowserRuntimeStatus('状态：安装失败', '#ef4444');
      toast(error.message || '插件安装失败', 'error');
    } finally {
      brInstallBtn.disabled = false;
      brInstallBtn.textContent = '一键安装插件';
    }
  });
}

if (brInstallBrowserBtn) {
  brInstallBrowserBtn.addEventListener('click', async () => {
    if (brInstallBrowserBtn.disabled) return;
    brInstallBrowserBtn.disabled = true;
    brInstallBrowserBtn.textContent = '安装中...';
    setBrowserRuntimeStatus('状态：正在安装浏览器环境...', '#facc15');
    try {
      await installBrowserRuntimeEnvironment();
      setBrowserRuntimeStatus('状态：浏览器环境安装完成，请重启服务生效', '#86efac');
      toast('浏览器环境安装完成，请重启服务后生效', 'success');
    } catch (error) {
      setBrowserRuntimeStatus('状态：浏览器环境安装失败', '#ef4444');
      toast(error.message || '浏览器环境安装失败', 'error');
    } finally {
      brInstallBrowserBtn.disabled = false;
      brInstallBrowserBtn.textContent = '安装浏览器环境';
    }
  });
}

function getStorageCleanupPayload() {
  const retentionDays = Math.min(3650, Math.max(1, Number(storageCleanupDays?.value) || 30));
  const categories = storageCleanupCategories
    ? Array.from(storageCleanupCategories.querySelectorAll('input[type="checkbox"]:checked')).map((input) => input.value)
    : [];
  return { retentionDays, categories };
}

function renderStorageCleanupResult(data, executed = false) {
  if (!data || !storageCleanupResult) return;
  const categoryText = Object.values(data.byCategory || {})
    .filter((item) => item.count > 0)
    .map((item) => `${item.label} ${item.count} 项`)
    .join('，');
  const failureText = data.failures?.length ? `；失败 ${data.failures.length} 项` : '';
  storageCleanupResult.textContent = executed
    ? `清理完成：处理 ${data.count} 项，约 ${formatBytes(data.bytes)}，删除运行记录 ${data.removedRunRows || 0} 条${failureText}`
    : `预计 ${data.count} 项，约 ${formatBytes(data.bytes)}，运行记录 ${data.runRows || 0} 条${categoryText ? `；${categoryText}` : ''}`;
  if (storageCleanupStatus) {
    storageCleanupStatus.textContent = executed
      ? `已清理 ${data.count} 项${failureText}`
      : `预计释放 ${formatBytes(data.bytes)}`;
  }
}

async function previewStorageCleanup() {
  const payload = getStorageCleanupPayload();
  if (!payload.categories.length) {
    toast('请至少选择一个清理类别', 'warn');
    return null;
  }
  storageCleanupPreviewBtn.disabled = true;
  storageCleanupPreviewBtn.textContent = '预览中...';
  try {
    const query = new URLSearchParams({
      retentionDays: String(payload.retentionDays),
      categories: payload.categories.join(','),
    });
    const res = await fetchJson(`/api/storage/cleanup/preview?${query}`);
    storageCleanupPreview = res.data || null;
    renderStorageCleanupResult(storageCleanupPreview, false);
    if (storageCleanupRunBtn) storageCleanupRunBtn.disabled = !storageCleanupPreview?.count;
    return storageCleanupPreview;
  } catch (error) {
    storageCleanupPreview = null;
    if (storageCleanupRunBtn) storageCleanupRunBtn.disabled = true;
    toast(error.message || '生成清理预览失败', 'error');
    return null;
  } finally {
    storageCleanupPreviewBtn.disabled = false;
    storageCleanupPreviewBtn.innerHTML = '<i data-lucide="search" class="icon-sm"></i> 预览估算';
    if (window.lucide) window.lucide.createIcons({ root: storageCleanupPreviewBtn });
  }
}

if (storageCleanupCategories) {
  storageCleanupCategories.addEventListener('change', () => {
    storageCleanupPreview = null;
    if (storageCleanupRunBtn) storageCleanupRunBtn.disabled = true;
    if (storageCleanupStatus) storageCleanupStatus.textContent = '选项已改变，请重新预览';
  });
}
if (storageCleanupDays) {
  storageCleanupDays.addEventListener('input', () => {
    storageCleanupPreview = null;
    if (storageCleanupRunBtn) storageCleanupRunBtn.disabled = true;
    if (storageCleanupStatus) storageCleanupStatus.textContent = '保留天数已改变，请重新预览';
  });
}
if (storageCleanupPreviewBtn) storageCleanupPreviewBtn.addEventListener('click', previewStorageCleanup);
if (storageCleanupRunBtn) {
  storageCleanupRunBtn.addEventListener('click', async () => {
    const preview = storageCleanupPreview || await previewStorageCleanup();
    if (!preview?.count) {
      toast('没有符合条件的可清理产物', 'info');
      return;
    }
    dialogConfirm(
      `确认清理 ${preview.count} 项（约 ${formatBytes(preview.bytes)}）及 ${preview.runRows || 0} 条旧运行记录？此操作不可撤销。`,
      async () => {
        storageCleanupRunBtn.disabled = true;
        storageCleanupRunBtn.textContent = '清理中...';
        try {
          const payload = getStorageCleanupPayload();
          const res = await fetchJson('/api/storage/cleanup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          storageCleanupPreview = null;
          renderStorageCleanupResult(res.data || {}, true);
          toast(res.data?.failures?.length ? '清理完成，部分项目处理失败' : '存储清理完成', res.data?.failures?.length ? 'warn' : 'success');
          await refreshAll();
        } catch (error) {
          toast(error.message || '存储清理失败', 'error');
        } finally {
          storageCleanupRunBtn.disabled = true;
          storageCleanupRunBtn.innerHTML = '<i data-lucide="trash-2" class="icon-sm"></i> 执行清理';
          if (window.lucide) window.lucide.createIcons({ root: storageCleanupRunBtn });
        }
      }
    );
  });
}

if (taskProfileModeSelect) {
  taskProfileModeSelect.addEventListener('change', () => {
    updateTaskProfileModeUI();
    updateTaskFormSummary();
  });
  updateTaskProfileModeUI();
}
if (taskProfileSelect) {
  taskProfileSelect.addEventListener('change', () => {
    if (form.elements.browser_profile_id) {
      form.elements.browser_profile_id.value = taskProfileSelect.value || '';
    }
    updateTaskProfileModeUI();
    updateTaskFormSummary();
  });
}
if (taskProxyMode) {
  taskProxyMode.addEventListener('change', () => {
    updateProxyModeUI(taskProxyMode, taskProxyInput, taskProxyValueField);
    updateTaskFormSummary();
  });
  updateProxyModeUI(taskProxyMode, taskProxyInput, taskProxyValueField);
}
if (taskProxyFromProfileBtn) {
  taskProxyFromProfileBtn.addEventListener('click', () => fillTaskProxyFromSelectedProfile());
}
if (taskEnvAddRowBtn) {
  taskEnvAddRowBtn.addEventListener('click', () => taskEnvUI.addRow({}));
}
if (taskEnvTemplateHost2playBtn) {
  taskEnvTemplateHost2playBtn.addEventListener('click', () => applyHost2PlayTemplate());
}
if (taskEnvApplyRawBtn) {
  taskEnvApplyRawBtn.addEventListener('click', () => {
    try {
      const parsed = parseEnvText(paramJsonRaw?.value || '');
      if (!parsed.length) throw new Error('未解析到任何 KEY=value');
      const combined = new Map(
        collectTaskEnvFromForm().map((entry) => [String(entry.name || '').toUpperCase(), entry])
      );
      for (const entry of parsed) combined.set(String(entry.name || '').toUpperCase(), entry);
      const rows = [...combined.values()];
      if (taskUseGlobalTelegram && rows.some((entry) => String(entry.name || '').toUpperCase() === 'USE_GLOBAL_TELEGRAM')) {
        taskUseGlobalTelegram.checked = readUseGlobalTelegramFlag(rows);
      }
      taskEnvUI.setRows(filterManagedEnvRows(rows));
      updateTaskFormSummary();
      toast('已应用到表格与专用设置', 'success');
    } catch (error) {
      toast(error.message || '导入失败', 'error');
    }
  });
}
if (taskEnvExportRawBtn) {
  taskEnvExportRawBtn.addEventListener('click', () => {
    try {
      const rows = filterManagedEnvRows(collectTaskEnvFromForm());
      if (paramJsonRaw) {
        paramJsonRaw.value = rows
          .map((entry) => `${entry.name}=${String(entry.value || '').replace(/\n/g, '\\n')}`)
          .join('\n');
      }
      toast('已导出到文本框', 'success');
    } catch (error) {
      toast(error.message || '导出失败', 'error');
    }
  });
}
if (globalEnvAddRowBtn) {
  globalEnvAddRowBtn.addEventListener('click', () => globalEnvUI.addRow({}));
}
if (globalEnvImportBtn) {
  globalEnvImportBtn.addEventListener('click', () => {
    const text = window.prompt('粘贴 .env 或 JSON 内容：', '');
    if (text == null) return;
    try {
      globalEnvUI.importText(text);
      toast('已导入到表格，请点保存', 'success');
    } catch (error) {
      toast(error.message || '导入失败', 'error');
    }
  });
}
if (globalEnvSaveBtn) {
  globalEnvSaveBtn.addEventListener('click', async () => {
    try {
      const env = globalEnvUI.collect();
      await fetchJson('/api/env', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'global',
          env,
          githubCompat: githubCompatEnabled ? githubCompatEnabled.checked : true,
        }),
      });
      toast('全局变量已保存', 'success');
      await loadGlobalEnvSettings();
    } catch (error) {
      toast(error.message || '保存失败', 'error');
    }
  });
}

/* ========== tasks/ 脚本文件管理（全局配置） ========== */
let fsCurrentPath = '';

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

/** File mtime for script manager — short local datetime. */
function formatFsMtime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    const s = String(value);
    return s.length >= 16 ? s.slice(0, 16).replace('T', ' ') : s;
  }
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fsBreadcrumb(rel) {
  const el = document.getElementById('fs-breadcrumb');
  if (!el) return;
  el.innerHTML = `<code>tasks/${escapeHtml(rel || '')}${rel ? '/' : ''}</code>`;
}

async function loadTasksFs(dir = fsCurrentPath) {
  const list = document.getElementById('fs-list');
  if (!list) return;
  fsCurrentPath = String(dir || '').replace(/^\/+|\/+$/g, '');
  fsBreadcrumb(fsCurrentPath);
  list.innerHTML = '<div class="files-list-empty">加载中…</div>';
  try {
    const q = fsCurrentPath ? `?path=${encodeURIComponent(fsCurrentPath)}` : '';
    const res = await fetchJson(`/api/tasks-fs${q}`);
    const entries = res.data?.entries || [];
    if (!entries.length) {
      list.innerHTML = '<div class="files-list-empty">空目录</div>';
      return;
    }
    list.innerHTML = '';
    // Column header (name / size / mtime / actions)
    const head = document.createElement('div');
    head.className = 'files-row files-row-head';
    head.innerHTML = `
      <span></span>
      <div class="files-name">名称</div>
      <div class="files-meta">大小</div>
      <div class="files-mtime">修改时间</div>
      <div class="files-actions"></div>
    `;
    list.appendChild(head);
    for (const ent of entries) {
      const row = document.createElement('div');
      row.className = `files-row ${ent.type === 'dir' ? 'is-dir' : ''}`;
      const icon = ent.type === 'dir' ? 'folder' : 'file-code';
      const mtimeLabel = formatFsMtime(ent.mtime);
      const sizeLabel = ent.type === 'dir' ? '文件夹' : formatBytes(ent.size);
      row.innerHTML = `
        <i data-lucide="${icon}" class="icon-sm" style="opacity:.85"></i>
        <div class="files-name" title="${escapeHtml(ent.name)}">${escapeHtml(ent.name)}</div>
        <div class="files-meta">${escapeHtml(sizeLabel)}</div>
        <div class="files-mtime" title="${escapeHtml(ent.mtime || '')}">${escapeHtml(mtimeLabel)}</div>
        <div class="files-actions"></div>
      `;
      const actions = row.querySelector('.files-actions');
      if (ent.type === 'dir') {
        row.addEventListener('click', (e) => {
          if (e.target.closest('button')) return;
          loadTasksFs(ent.path);
        });
      } else {
        if (ent.text) {
          const editBtn = document.createElement('button');
          editBtn.type = 'button';
          editBtn.className = 'alt';
          editBtn.textContent = '编辑';
          editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openTasksFileEditor(ent.path);
          });
          actions.appendChild(editBtn);
        }
        const dlBtn = document.createElement('button');
        dlBtn.type = 'button';
        dlBtn.className = 'alt';
        dlBtn.textContent = '下载';
        dlBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          window.open(`/api/tasks-fs/download?path=${encodeURIComponent(ent.path)}`, '_blank');
        });
        actions.appendChild(dlBtn);
      }
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'alt danger';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dialogConfirm(`确定删除「${ent.name}」？`, async () => {
          try {
            await fetchJson('/api/tasks-fs', {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: ent.path }),
            });
            toast('已删除', 'success');
            await loadTasksFs(fsCurrentPath);
            await loadScripts();
          } catch (err) {
            toast(err.message || '删除失败', 'error');
          }
        });
      });
      actions.appendChild(delBtn);
      list.appendChild(row);
    }
    if (window.lucide) window.lucide.createIcons({ root: list });
  } catch (error) {
    list.innerHTML = `<div class="files-list-empty">${escapeHtml(error.message || '加载失败')}</div>`;
  }
}

function openTasksFileEditor(relPath) {
  fetchJson(`/api/tasks-fs/read?path=${encodeURIComponent(relPath)}`)
    .then((res) => {
      const file = res.data || {};
      const mask = document.createElement('div');
      mask.className = 'modal-mask open';
      mask.style.zIndex = '10050';
      const dialog = document.createElement('div');
      dialog.className = 'modal open files-editor-dialog';
      dialog.style.cssText = 'z-index:10051; max-width:860px; width:min(860px,96vw);';
      dialog.innerHTML = `
        <div class="modal-header">
          <div>
            <h2>编辑 ${escapeHtml(file.name || relPath)}</h2>
            <p class="muted" style="margin:4px 0 0;font-size:13px;"><code>tasks/${escapeHtml(relPath)}</code></p>
          </div>
          <button type="button" class="icon-btn fs-ed-close" aria-label="关闭"><i data-lucide="x" class="icon-md"></i></button>
        </div>
        <div class="modal-body">
          <textarea class="files-editor-area" spellcheck="false"></textarea>
          <div class="row" style="margin-top:12px; gap:8px; justify-content:flex-end;">
            <button type="button" class="alt fs-ed-cancel">取消</button>
            <button type="button" class="btn-primary fs-ed-save">保存</button>
          </div>
        </div>
      `;
      document.body.appendChild(mask);
      document.body.appendChild(dialog);
      const area = dialog.querySelector('.files-editor-area');
      area.value = file.content || '';
      if (window.lucide) window.lucide.createIcons({ root: dialog });
      const close = () => { mask.remove(); dialog.remove(); };
      dialog.querySelector('.fs-ed-close').addEventListener('click', close);
      dialog.querySelector('.fs-ed-cancel').addEventListener('click', close);
      mask.addEventListener('click', close);
      dialog.querySelector('.fs-ed-save').addEventListener('click', async () => {
        try {
          await fetchJson('/api/tasks-fs/write', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: relPath, content: area.value }),
          });
          toast('已保存', 'success');
          close();
          await loadTasksFs(fsCurrentPath);
        } catch (err) {
          toast(err.message || '保存失败', 'error');
        }
      });
      setTimeout(() => area.focus(), 40);
    })
    .catch((err) => toast(err.message || '读取失败', 'error'));
}

function promptFsName(title, placeholder) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask open';
    mask.style.zIndex = '10050';
    const dialog = document.createElement('div');
    dialog.className = 'modal open';
    dialog.style.cssText = 'z-index:10051; max-width:420px; width:min(420px,92vw);';
    dialog.innerHTML = `
      <div class="modal-header">
        <h2>${escapeHtml(title)}</h2>
        <button type="button" class="icon-btn fs-nm-close"><i data-lucide="x" class="icon-md"></i></button>
      </div>
      <div class="modal-body">
        <input type="text" class="fs-nm-input" placeholder="${escapeHtml(placeholder || '')}" spellcheck="false" autocomplete="off" style="width:100%" />
        <div class="row" style="margin-top:12px; gap:8px; justify-content:flex-end;">
          <button type="button" class="alt fs-nm-cancel">取消</button>
          <button type="button" class="btn-primary fs-nm-ok">确定</button>
        </div>
      </div>
    `;
    document.body.appendChild(mask);
    document.body.appendChild(dialog);
    if (window.lucide) window.lucide.createIcons({ root: dialog });
    const input = dialog.querySelector('.fs-nm-input');
    const done = (val) => { mask.remove(); dialog.remove(); resolve(val); };
    dialog.querySelector('.fs-nm-close').addEventListener('click', () => done(null));
    dialog.querySelector('.fs-nm-cancel').addEventListener('click', () => done(null));
    mask.addEventListener('click', () => done(null));
    dialog.querySelector('.fs-nm-ok').addEventListener('click', () => done(String(input.value || '').trim()));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(String(input.value || '').trim()); }
    });
    setTimeout(() => input.focus(), 40);
  });
}

function wireTasksFsUi() {
  const up = document.getElementById('fs-btn-up');
  const refresh = document.getElementById('fs-btn-refresh');
  const newFile = document.getElementById('fs-btn-new-file');
  const newFolder = document.getElementById('fs-btn-new-folder');
  const uploadBtn = document.getElementById('fs-btn-upload');
  const uploadInput = document.getElementById('fs-upload-input');

  if (up) {
    up.addEventListener('click', () => {
      if (!fsCurrentPath) return;
      const parts = fsCurrentPath.split('/').filter(Boolean);
      parts.pop();
      loadTasksFs(parts.join('/'));
    });
  }
  if (refresh) refresh.addEventListener('click', () => loadTasksFs(fsCurrentPath));
  if (newFolder) {
    newFolder.addEventListener('click', async () => {
      const name = await promptFsName('新建文件夹', 'folder-name');
      if (!name) return;
      try {
        await fetchJson('/api/tasks-fs/mkdir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parent: fsCurrentPath, name }),
        });
        toast('文件夹已创建', 'success');
        await loadTasksFs(fsCurrentPath);
      } catch (err) {
        toast(err.message || '创建失败', 'error');
      }
    });
  }
  if (newFile) {
    newFile.addEventListener('click', async () => {
      const name = await promptFsName('新建文件', 'script.py');
      if (!name) return;
      try {
        const created = await fetchJson('/api/tasks-fs/create-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parent: fsCurrentPath, name, content: '' }),
        });
        toast('文件已创建', 'success');
        await loadTasksFs(fsCurrentPath);
        await loadScripts();
        if (created.data?.path) openTasksFileEditor(created.data.path);
      } catch (err) {
        toast(err.message || '创建失败', 'error');
      }
    });
  }
  async function fileToBase64(file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  /** Relative path for upload: folder pick keeps webkitRelativePath tree. */
  function uploadRelativePath(file) {
    const rel = String(file.webkitRelativePath || file.name || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');
    if (!rel || rel.includes('..')) return file.name || '';
    // Skip junk paths from OS folder pickers
    const parts = rel.split('/').filter(Boolean);
    if (parts.some((p) => p === '__pycache__' || p === '.git' || p === 'node_modules' || p === '.DS_Store')) {
      return '';
    }
    if (parts.some((p) => p.endsWith('.pyc') || p === 'Thumbs.db')) return '';
    return parts.join('/');
  }

  async function uploadFilesList(fileList, { asFolder = false } = {}) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    let ok = 0;
    let fail = 0;
    let skip = 0;
    const total = files.length;
    if (total > 1) toast(`开始上传 ${total} 个文件…`, 'info');
    for (const file of files) {
      const rel = uploadRelativePath(file);
      if (!rel) {
        skip += 1;
        continue;
      }
      // Flat multi-file: only basename; folder mode: keep relative path
      const relativePath = asFolder ? rel : pathBasename(rel);
      try {
        const b64 = await fileToBase64(file);
        await fetchJson('/api/tasks-fs/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            parent: fsCurrentPath,
            name: pathBasename(relativePath),
            relativePath,
            encoding: 'base64',
            content: b64,
          }),
        });
        ok += 1;
      } catch (err) {
        fail += 1;
        toast(`${relativePath}: ${err.message || '上传失败'}`, 'error');
      }
    }
    if (ok && !fail) {
      toast(
        asFolder
          ? `文件夹上传完成：${ok} 个文件${skip ? `，跳过 ${skip}` : ''}`
          : (ok === 1 ? `已上传 ${files[0]?.name || ''}` : `已上传 ${ok} 个文件`),
        'success',
      );
    } else if (ok && fail) {
      toast(`上传结束：成功 ${ok}，失败 ${fail}${skip ? `，跳过 ${skip}` : ''}`, 'warn');
    } else if (!ok && fail) {
      toast(`上传失败（${fail}）`, 'error');
    } else if (skip && !ok) {
      toast('没有可上传的文件（可能全是缓存/系统目录）', 'warn');
    }
    await loadTasksFs(fsCurrentPath);
    await loadScripts();
  }

  if (uploadBtn && uploadInput) {
    uploadBtn.addEventListener('click', () => {
      uploadInput.removeAttribute('webkitdirectory');
      uploadInput.removeAttribute('directory');
      uploadInput.click();
    });
    uploadInput.addEventListener('change', async () => {
      const files = [...(uploadInput.files || [])];
      uploadInput.value = '';
      await uploadFilesList(files, { asFolder: false });
    });
  }

  const uploadFolderBtn = document.getElementById('fs-btn-upload-folder');
  const uploadFolderInput = document.getElementById('fs-upload-folder-input');
  if (uploadFolderBtn && uploadFolderInput) {
    uploadFolderBtn.addEventListener('click', () => uploadFolderInput.click());
    uploadFolderInput.addEventListener('change', async () => {
      const files = [...(uploadFolderInput.files || [])];
      uploadFolderInput.value = '';
      await uploadFilesList(files, { asFolder: true });
    });
  }

}

/* ========== 插件与用户目录文件管理 ========== */
const resourceManagerState = {
  extensions: { path: '', api: '/api/extensions-fs', rootLabel: '/home/browser/browser-work/' },
  profiles: { path: '', api: '/api/profiles-fs', rootLabel: 'profiles/' },
};

function getResourceManager(kind) {
  const root = document.querySelector(`.resource-manager[data-resource="${kind}"]`);
  const state = resourceManagerState[kind];
  return root && state ? { root, state } : null;
}

function uploadResourceFile(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.responseType = 'json';
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && typeof onProgress === 'function') {
        onProgress(event.loaded, event.total);
      }
    });
    xhr.addEventListener('load', () => {
      const data = xhr.response || {};
      if (xhr.status === 401) {
        goLogin();
        reject(new Error('会话已失效，正在跳转登录页'));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(data.message || `上传失败（HTTP ${xhr.status}）`));
        return;
      }
      resolve(data);
    });
    xhr.addEventListener('error', () => reject(new Error('网络错误，上传失败')));
    xhr.addEventListener('abort', () => reject(new Error('上传已取消')));
    xhr.send(file);
  });
}

async function resourceAction(kind, path, action, extra = {}) {
  const manager = getResourceManager(kind);
  if (!manager) return;
  await fetchJson(`${manager.state.api}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, ...extra }),
  });
  await loadResourceManager(kind);
}

async function loadResourceManager(kind, dir) {
  const manager = getResourceManager(kind);
  if (!manager) return;
  const { root, state } = manager;
  if (dir !== undefined) state.path = String(dir || '').replace(/^\/+|\/+$/g, '');
  const list = root.querySelector('.resource-list');
  const breadcrumb = root.querySelector('.resource-breadcrumb');
  breadcrumb.innerHTML = `<code>${escapeHtml(state.rootLabel)}${escapeHtml(state.path)}${state.path ? '/' : ''}</code>`;
  list.innerHTML = '<div class="files-list-empty">加载中…</div>';
  try {
    const suffix = state.path ? `?path=${encodeURIComponent(state.path)}` : '';
    const response = await fetchJson(`${state.api}${suffix}`);
    const entries = response.data?.entries || [];
    if (!entries.length) {
      list.innerHTML = '<div class="files-list-empty">空目录</div>';
      return;
    }
    list.innerHTML = `<div class="files-row files-row-head"><span></span><div class="files-name">名称</div><div class="files-meta">大小</div><div class="files-mtime">修改时间</div><div class="files-actions"></div></div>`;
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = `files-row ${entry.type === 'dir' ? 'is-dir' : ''}`;
      row.innerHTML = `
        <i data-lucide="${entry.type === 'dir' ? 'folder' : (entry.archive ? 'file-archive' : 'file')}" class="icon-sm"></i>
        <div class="files-name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</div>
        <div class="files-meta">${entry.type === 'dir' ? '文件夹' : formatBytes(entry.size)}</div>
        <div class="files-mtime">${escapeHtml(formatFsMtime(entry.mtime))}</div>
        <div class="files-actions"></div>`;
      const actions = row.querySelector('.files-actions');
      if (entry.type === 'dir') {
        row.addEventListener('click', (event) => {
          if (!event.target.closest('button')) loadResourceManager(kind, entry.path);
        });
      }
      if (entry.archive) {
        for (const [label, mode] of [['解压到当前目录', 'current'], ['解压到同名目录', 'folder']]) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'alt';
          button.textContent = label;
          button.addEventListener('click', async (event) => {
            event.stopPropagation();
            try {
              await resourceAction(kind, entry.path, 'extract', { mode, overwrite: false });
              toast('解压完成', 'success');
            } catch (error) {
              toast(error.message || '解压失败', 'error');
            }
          });
          actions.appendChild(button);
        }
      }
      const renameButton = document.createElement('button');
      renameButton.type = 'button';
      renameButton.className = 'alt';
      renameButton.textContent = '重命名';
      renameButton.addEventListener('click', async (event) => {
        event.stopPropagation();
        const newName = await promptFsName('重命名', entry.name);
        if (!newName || newName === entry.name) return;
        try {
          await resourceAction(kind, entry.path, 'rename', { newName });
          toast('已重命名', 'success');
        } catch (error) {
          toast(error.message || '重命名失败', 'error');
        }
      });
      actions.appendChild(renameButton);
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'alt danger';
      deleteButton.textContent = '删除';
      deleteButton.addEventListener('click', (event) => {
        event.stopPropagation();
        dialogConfirm(`确定删除「${entry.name}」？${entry.type === 'dir' ? ' 文件夹内容也会一并删除。' : ''}`, async () => {
          try {
            await fetchJson(state.api, {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: entry.path }),
            });
            toast('已删除', 'success');
            await loadResourceManager(kind);
          } catch (error) {
            toast(error.message || '删除失败', 'error');
          }
        });
      });
      actions.appendChild(deleteButton);
      list.appendChild(row);
    }
    if (window.lucide) window.lucide.createIcons({ root: list });
  } catch (error) {
    list.innerHTML = `<div class="files-list-empty">${escapeHtml(error.message || '加载失败')}</div>`;
  }
}

function wireResourceManagers() {
  for (const kind of Object.keys(resourceManagerState)) {
    const manager = getResourceManager(kind);
    if (!manager) continue;
    const { root, state } = manager;
    root.querySelector('.resource-up')?.addEventListener('click', () => {
      const parts = state.path.split('/').filter(Boolean);
      parts.pop();
      loadResourceManager(kind, parts.join('/'));
    });
    root.querySelector('.resource-refresh')?.addEventListener('click', () => loadResourceManager(kind));
    root.querySelector('.resource-mkdir')?.addEventListener('click', async () => {
      const name = await promptFsName('新建文件夹', 'folder-name');
      if (!name) return;
      try {
        await fetchJson(`${state.api}/mkdir`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parent: state.path, name }),
        });
        toast('文件夹已创建', 'success');
        await loadResourceManager(kind);
      } catch (error) {
        toast(error.message || '创建失败', 'error');
      }
    });
    const uploadButton = root.querySelector('.resource-upload');
    const uploadInput = root.querySelector('.resource-upload-input');
    const progressBox = root.querySelector('.resource-upload-progress');
    const progressText = root.querySelector('.resource-upload-progress-text');
    const progressPercent = root.querySelector('.resource-upload-progress-percent');
    const progressMeter = root.querySelector('.resource-upload-progress-meter');
    uploadButton?.addEventListener('click', () => uploadInput?.click());
    uploadInput?.addEventListener('change', async () => {
      const file = uploadInput.files?.[0];
      uploadInput.value = '';
      if (!file) return;
      try {
        uploadButton.disabled = true;
        if (progressBox) progressBox.hidden = false;
        if (progressMeter) progressMeter.value = 0;
        if (progressPercent) progressPercent.textContent = '0%';
        if (progressText) progressText.textContent = `${file.name} · 0 B / ${formatBytes(file.size)}`;
        const query = new URLSearchParams({
          parent: state.path,
          name: file.name,
          overwrite: 'false',
        });
        await uploadResourceFile(`${state.api}/upload?${query}`, file, (loaded, total) => {
          const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
          if (progressMeter) progressMeter.value = percent;
          if (progressPercent) progressPercent.textContent = `${percent}%`;
          if (progressText) progressText.textContent = `${file.name} · ${formatBytes(loaded)} / ${formatBytes(total)}`;
        });
        if (progressMeter) progressMeter.value = 100;
        if (progressPercent) progressPercent.textContent = '100%';
        if (progressText) progressText.textContent = `${file.name} · 上传完成`;
        toast('上传完成', 'success');
        await loadResourceManager(kind);
      } catch (error) {
        if (progressText) progressText.textContent = `${file.name} · ${error.message || '上传失败'}`;
        toast(error.message || '上传失败', 'error');
      } finally {
        uploadButton.disabled = false;
        window.setTimeout(() => {
          if (progressBox) progressBox.hidden = true;
        }, 2500);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// 登录态 / 顶栏用户区
// ---------------------------------------------------------------------------

function openChangePasswordDialog() {
  const mask = document.createElement('div');
  mask.className = 'modal-mask open';
  mask.style.zIndex = '10050';
  const dialog = document.createElement('div');
  dialog.className = 'modal open';
  dialog.style.cssText = 'z-index:10051; max-width:420px; width:min(420px,92vw);';
  dialog.innerHTML = `
    <div class="modal-header">
      <div>
        <h2>修改密码</h2>
        <p class="muted" style="margin:4px 0 0;font-size:13px;">改完会退出其他设备上的登录</p>
      </div>
      <button type="button" class="icon-btn cp-close" aria-label="关闭"><i data-lucide="x" class="icon-md"></i></button>
    </div>
    <div class="modal-body">
      <form class="stack-form cp-form">
        <div>
          <label class="field-label" for="cp-current">当前密码</label>
          <input id="cp-current" type="password" autocomplete="current-password" style="width:100%" />
        </div>
        <div>
          <label class="field-label" for="cp-new">新密码（至少 8 位）</label>
          <input id="cp-new" type="password" autocomplete="new-password" style="width:100%" />
        </div>
        <div>
          <label class="field-label" for="cp-confirm">确认新密码</label>
          <input id="cp-confirm" type="password" autocomplete="new-password" style="width:100%" />
        </div>
        <div class="row" style="margin-top:12px; gap:8px; justify-content:flex-end;">
          <button type="button" class="alt cp-cancel">取消</button>
          <button type="submit" class="btn-primary cp-ok">保存</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(mask);
  document.body.appendChild(dialog);
  if (window.lucide) window.lucide.createIcons({ root: dialog });

  const close = () => { mask.remove(); dialog.remove(); };
  dialog.querySelector('.cp-close').addEventListener('click', close);
  dialog.querySelector('.cp-cancel').addEventListener('click', close);
  mask.addEventListener('click', close);

  const form = dialog.querySelector('.cp-form');
  const okBtn = dialog.querySelector('.cp-ok');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const currentPassword = dialog.querySelector('#cp-current').value;
    const newPassword = dialog.querySelector('#cp-new').value;
    const confirmPassword = dialog.querySelector('#cp-confirm').value;
    if (!currentPassword || !newPassword) {
      toast('请填写当前密码和新密码', 'error');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast('两次输入的新密码不一致', 'error');
      return;
    }
    okBtn.disabled = true;
    try {
      await fetchJson('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
      });
      close();
      toast('密码已修改', 'success');
    } catch (err) {
      toast(err.message || '修改失败', 'error');
      okBtn.disabled = false;
    }
  });
  setTimeout(() => dialog.querySelector('#cp-current').focus(), 40);
}

// —— 两步验证管理弹窗（TOTP 开关 + 通行密钥增删） ——

function bufferToBase64url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBuffer(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// 所有 /api/auth/2fa/* 接口都要验当前密码（require2faAccess），所以先做一道密码门：
// 输对密码才加载管理界面，拿到的 currentPassword 存闭包里，后续操作复用。
function open2faDialog() {
  const mask = document.createElement('div');
  mask.className = 'modal-mask open';
  mask.style.zIndex = '10050';
  const dialog = document.createElement('div');
  dialog.className = 'modal open';
  dialog.style.cssText = 'z-index:10051; max-width:520px; width:min(520px,94vw);';

  dialog.innerHTML = `
    <div class="modal-header">
      <div>
        <h2>两步验证</h2>
        <p class="muted" style="margin:4px 0 0;font-size:13px;">TOTP 动态码 + 通行密钥免密登录</p>
      </div>
      <button type="button" class="icon-btn t2-close" aria-label="关闭"><i data-lucide="x" class="icon-md"></i></button>
    </div>
    <div class="modal-body">
      <div id="t2-lock">
        <p class="muted" style="margin-top:0;font-size:13px;line-height:1.7;">
          两步验证的管理操作都需要先验证当前密码，防止别人趁会话未过期偷改你的安全设置。
        </p>
        <div class="stack-form">
          <div>
            <label class="field-label" for="t2-password">当前密码</label>
            <input id="t2-password" type="password" autocomplete="current-password" style="width:100%" />
          </div>
          <div class="row" style="gap:8px; justify-content:flex-end;">
            <button type="button" class="alt t2-cancel">取消</button>
            <button type="button" class="btn-primary t2-unlock">验证并进入</button>
          </div>
        </div>
      </div>

      <div id="t2-manage" hidden>
        <div class="twofa-section">
          <h3><i data-lucide="smartphone" class="icon-sm"></i> 身份验证器（TOTP）</h3>
          <div id="t2-totp"></div>
        </div>
        <div class="twofa-section">
          <h3><i data-lucide="fingerprint" class="icon-sm"></i> 通行密钥（Passkey）</h3>
          <div id="t2-passkey"></div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(mask);
  document.body.appendChild(dialog);
  if (window.lucide) window.lucide.createIcons({ root: dialog });

  const close = () => { mask.remove(); dialog.remove(); };
  dialog.querySelector('.t2-close').addEventListener('click', close);
  dialog.querySelector('.t2-cancel').addEventListener('click', close);
  mask.addEventListener('click', close);

  const lockEl = dialog.querySelector('#t2-lock');
  const manageEl = dialog.querySelector('#t2-manage');
  const passwordInput = dialog.querySelector('#t2-password');
  let currentPassword = '';

  dialog.querySelector('.t2-unlock').addEventListener('click', async () => {
    currentPassword = passwordInput.value;
    if (!currentPassword) { toast('请输入当前密码', 'error'); return; }
    const unlockBtn = dialog.querySelector('.t2-unlock');
    unlockBtn.disabled = true;
    try {
      await fetchJson('/api/auth/2fa/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword }),
      });
      lockEl.hidden = true;
      manageEl.hidden = false;
      await load2faStatus();
    } catch {
      // 401 已被 fetchJson 踢去登录页；剩的是密码错误之类，恢复按钮让用户重试
      unlockBtn.disabled = false;
      passwordInput.value = '';
      passwordInput.focus();
    }
  });

  async function load2faStatus() {
    try {
      const res = await fetchJson('/api/auth/2fa/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword }),
      });
      renderTotp(res.data);
      renderPasskeys(res.data);
    } catch { /* 401 已处理，其余错误进 toast */ }
  }

  function renderTotp(status) {
    const el = dialog.querySelector('#t2-totp');
    if (status.totpEnabled) {
      el.innerHTML = `
        <div class="twofa-row">
          <div>
            <strong>已开启</strong>
            <p>登录时需输入身份验证器里的 6 位动态码。</p>
          </div>
          <button type="button" class="danger t2-totp-off">关闭 TOTP</button>
        </div>`;
      el.querySelector('.t2-totp-off').addEventListener('click', async () => {
        try {
          await fetchJson('/api/auth/2fa/totp/disable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword }),
          });
          toast('两步验证已关闭', 'success');
          await load2faStatus();
        } catch (err) { toast(err.message || '关闭失败', 'error'); }
      });
    } else {
      el.innerHTML = `
        <div class="twofa-row">
          <div>
            <strong>未开启</strong>
            <p>开启后，输入密码后还要再输一个动态码才能登录。</p>
          </div>
          <button type="button" class="alt t2-totp-on">开启</button>
        </div>`;
      el.querySelector('.t2-totp-on').addEventListener('click', startTotpSetup);
    }
  }

  async function startTotpSetup() {
    const el = dialog.querySelector('#t2-totp');
    let setup;
    try {
      setup = (await fetchJson('/api/auth/2fa/totp/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword }),
      })).data;
    } catch (err) { toast(err.message || '生成秘钥失败', 'error'); return; }

    el.innerHTML = `
      <div class="totp-setup">
        <p class="muted" style="margin:0;font-size:13px;line-height:1.7;">
          用身份验证器 App（如 Google Authenticator / 1Password）扫下面的二维码，
          或手动输入秘钥，然后填上 App 里显示的 6 位动态码完成开启。
        </p>
        <div class="totp-qr-wrap"><div id="t2-qr"></div></div>
        <div class="totp-secret-row">
          <code id="t2-secret">${escapeHtml(setup.secret)}</code>
          <button type="button" class="alt t2-copy">复制</button>
        </div>
        <div>
          <label class="field-label" for="t2-code">动态验证码</label>
          <input id="t2-code" type="text" inputmode="numeric" maxlength="6"
                 placeholder="6 位数字" style="width:100%;font:600 18px/1.2 var(--font-mono);letter-spacing:0.3em;text-align:center;" />
        </div>
        <div class="row" style="gap:8px; justify-content:flex-end;">
          <button type="button" class="alt t2-setup-cancel">取消</button>
          <button type="button" class="btn-primary t2-setup-ok">确认开启</button>
        </div>
      </div>`;
    if (window.lucide) window.lucide.createIcons({ root: el });

    renderTotpQr(setup.otpauthUrl, el);

    el.querySelector('.t2-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(setup.secret);
        toast('秘钥已复制', 'success');
      } catch {
        // 剪贴板权限被拒就选中文本，让用户自己 Ctrl+C
        const code = el.querySelector('#t2-secret');
        const range = document.createRange();
        range.selectNodeContents(code);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });

    el.querySelector('.t2-setup-cancel').addEventListener('click', load2faStatus);

    el.querySelector('.t2-setup-ok').addEventListener('click', async () => {
      const code = el.querySelector('#t2-code').value.trim();
      if (!/^\d{6}$/.test(code)) { toast('请输入 6 位数字验证码', 'error'); return; }
      try {
        await fetchJson('/api/auth/2fa/totp/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword, code }),
        });
        toast('两步验证已开启', 'success');
        await load2faStatus();
      } catch (err) { toast(err.message || '开启失败', 'error'); }
    });
  }

  // 二维码本地生成（qrcode-generator，CDN 懒加载，只在开启 TOTP 时拉一次）；
  // 加载失败就退化为手动输入秘钥——二维码没了但功能不丢。
  let qrLibPromise = null;
  function loadQrLib() {
    if (window.qrcode) return Promise.resolve();
    if (!qrLibPromise) {
      qrLibPromise = new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
        script.onload = () => resolve();
        script.onerror = () => resolve(); // 失败也走完，draw 里会兜底
        document.head.appendChild(script);
      });
    }
    return qrLibPromise;
  }

  function renderTotpQr(otpauthUrl, root) {
    const wrap = root.querySelector('#t2-qr');
    loadQrLib().then(() => {
      if (!window.qrcode) {
        wrap.innerHTML = '<p class="muted" style="margin:0;text-align:center;font-size:12px;">二维码组件加载失败，请手动输入下方秘钥。</p>';
        return;
      }
      try {
        const qr = window.qrcode(0, 'L');
        qr.addData(otpauthUrl);
        qr.make();
        const img = document.createElement('img');
        img.src = qr.createDataURL(4, 12);
        img.alt = 'TOTP 二维码';
        img.width = 180;
        img.height = 180;
        wrap.innerHTML = '';
        wrap.appendChild(img);
      } catch {
        wrap.innerHTML = '<p class="muted" style="margin:0;text-align:center;font-size:12px;">二维码生成失败，请手动输入下方秘钥。</p>';
      }
    });
  }

  function fmtTime(iso) {
    if (!iso) return '从未';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function renderPasskeys(status) {
    const el = dialog.querySelector('#t2-passkey');
    const list = status.passkeys || [];
    const rows = list.length
      ? list.map((pk) => `
          <div class="passkey-item">
            <div>
              <strong>${escapeHtml(pk.name || '未命名通行密钥')}</strong>
              <p>注册于 ${fmtTime(pk.created_at)} · 上次使用 ${fmtTime(pk.last_used_at)}</p>
            </div>
            <button type="button" class="danger passkey-del" data-id="${pk.id}">删除</button>
          </div>`).join('')
      : '<p class="muted" style="font-size:13px;margin:0;">还没有通行密钥。</p>';

    const supported = Boolean(window.isSecureContext && navigator.credentials && window.PublicKeyCredential);
    el.innerHTML = `
      <div class="passkey-list">${rows}</div>
      <div class="twofa-add-row">
        <input id="t2-passkey-name" type="text" maxlength="60" placeholder="名称（可选）" />
        <button type="button" class="alt t2-passkey-add" ${supported ? '' : 'disabled'}>添加</button>
      </div>
      ${supported ? '' : '<p class="muted" style="font-size:12px;margin:8px 0 0;">当前环境不支持 WebAuthn（需 HTTPS 或 localhost），无法注册通行密钥。</p>'}`;
    if (window.lucide) window.lucide.createIcons({ root: el });

    el.querySelectorAll('.passkey-del').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.id);
        if (!id) return;
        if (!confirm('确定删除这把通行密钥？删除后该设备将无法用它免密登录。')) return;
        try {
          await fetchJson('/api/auth/2fa/passkey/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword, id }),
          });
          toast('通行密钥已删除', 'success');
          await load2faStatus();
        } catch (err) { toast(err.message || '删除失败', 'error'); }
      });
    });

    const addBtn = el.querySelector('.t2-passkey-add');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        registerPasskey(el.querySelector('#t2-passkey-name').value);
      });
    }
  }

  async function registerPasskey(name) {
    if (!window.PublicKeyCredential || !navigator.credentials) {
      toast('当前环境不支持通行密钥（需要 HTTPS 或 localhost）', 'error');
      return;
    }
    let options;
    try {
      options = (await fetchJson('/api/auth/2fa/passkey/register/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, name: String(name || '').trim() }),
      })).data;
    } catch (err) { toast(err.message || '获取注册凭证失败', 'error'); return; }

    try {
      const cred = await navigator.credentials.create({
        publicKey: {
          challenge: base64urlToBuffer(options.challenge),
          rp: options.rp,
          user: {
            id: base64urlToBuffer(options.user.id),
            name: options.user.name,
            displayName: options.user.displayName,
          },
          pubKeyCredParams: options.pubKeyCredParams,
          timeout: options.timeout,
          attestation: options.attestation || 'none',
          authenticatorSelection: options.authenticatorSelection,
          excludeCredentials: (options.excludeCredentials || []).map((c) => ({
            ...c,
            id: base64urlToBuffer(c.id),
          })),
        },
      });
      const transports = cred.response.getTransports
        ? cred.response.getTransports()
        : (cred.response.transports || []);
      await fetchJson('/api/auth/2fa/passkey/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword,
          challenge: options.challenge,
          response: {
            id: cred.id,
            rawId: bufferToBase64url(cred.rawId),
            type: cred.type,
            response: {
              clientDataJSON: bufferToBase64url(cred.response.clientDataJSON),
              attestationObject: bufferToBase64url(cred.response.attestationObject),
              transports,
            },
          },
        }),
      });
      toast('通行密钥已添加', 'success');
      await load2faStatus();
    } catch (err) {
      const msg = String((err && err.message) || err || '');
      // 用户主动取消是正常路径，不弹错
      if (msg && !/NotAllowedError|abort|cancel|取消/i.test(msg)) {
        toast('添加通行密钥失败：' + msg, 'error');
      }
    }
  }

  setTimeout(() => passwordInput.focus(), 40);
}

function wireAuthUi(username) {
  const box = document.getElementById('topbar-user');
  const nameEl = document.getElementById('topbar-username');
  if (nameEl) nameEl.textContent = username || '';
  if (box) box.hidden = false;

  // 版本号显示在侧边栏 brand 旁边。走独立小接口，失败就藏起来 ——
  // 一个装饰性的标签不值得报错打断启动。
  fetch('/api/version')
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      const el = document.getElementById('app-version');
      const label = data && data.data && data.data.label;
      if (el && label) {
        el.textContent = label;
        el.title = `版本 ${label}${data.data.describe ? `（${data.data.describe}）` : ''}`;
        el.hidden = false;
      }
    })
    .catch(() => {});

  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      try {
        await fetch('/api/auth/logout', { method: 'POST' });
      } catch {
        // 退出失败也照样跳登录页：Cookie 可能已经没了，留在面板上没意义
      }
      location.replace('/login.html');
    });
  }

  const cpBtn = document.getElementById('change-password-btn');
  if (cpBtn) cpBtn.addEventListener('click', openChangePasswordDialog);

  const twofaBtn = document.getElementById('twofa-btn');
  if (twofaBtn) twofaBtn.addEventListener('click', open2faDialog);
}

// 先确认登录再启动面板。不先问一句的话，未登录时十几个接口会并发打出去，
// 全部 401，用户先看到一屏报错才被弹走。
async function bootPanel() {
  let state = null;
  try {
    const res = await fetch('/api/auth/state');
    state = (await res.json()).data || {};
  } catch {
    toast('无法连接后端，请确认面板服务已启动。', 'error');
    return;
  }
  if (!state.authenticated) {
    goLogin();
    return;
  }

  wireAuthUi(state.username);

  wireTasksFsUi();
  wireResourceManagers();

  resetAllModalState();
  closeModal();
  refreshAll();
  startStatusStream();
  loadSchedulerSettings();
  loadSuccessHeuristicsSettings();
  loadBrowserRuntimeSettings();
  loadVisionSettings();
  loadGlobalEnvSettings();
  loadTelegramSettings();
  loadCloudBackupSettings();
  loadCloudBackupList();
  loadTasksFs(fsCurrentPath);
}

bootPanel();
