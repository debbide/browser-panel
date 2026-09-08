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

const setupPresetCustomControl = PresetCustomControl.setup;
const getPresetCustomValue = PresetCustomControl.getValue;
const updateProxyModeUI = ProxyModeControl.update;

const {
  PROXY_ENV_ALIAS_KEYS,
  MANAGED_TASK_ENV_KEYS,
  PROFILE_MANAGED_ENV_KEYS,
  isManagedEnvKey,
  filterManagedEnvRows,
  filterManagedEnvObject,
  findManagedEnvValue,
  findManagedParamValue,
  deleteManagedMapKeys,
  deleteManagedObjectKeys,
} = ManagedEnvironment;

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

  if (targetId === 'scripts-tab') fileBrowserController.load();
  if (targetId === 'extensions-tab') browserResourcesController.loadResourceManager('extensions');
  if (targetId === 'profile-files-tab') browserResourcesController.loadResourceManager('profiles');
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

// 点了停止、但服务端还没报 is_running=false 的任务。
// runningTaskIds 是 OR 进 isRunning 的，只能强制点亮不能强制熄灭：停止真正生效前
// 服务端仍回 is_running=true，光从 runningTaskIds 删掉按钮还是灰的。所以熄灭方向
// 需要这个独立的覆盖标记，优先级高于服务端状态。
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

const { createEnvEditor, parseEnvText, looksLikeSecretName } = EnvironmentEditor;

const taskEnvUI = createEnvEditor(taskEnvEditor);
const globalEnvUI = createEnvEditor(globalEnvEditor);

const settingsController = SettingsController.create({
  api: SettingsApi,
  view: SettingsView,
  toast,
  elements: {
    telegram: {
      form: tgForm,
      status: tgStatusText,
      botToken: tgBotToken,
      chatId: tgChatId,
      proxy: tgProxy,
      webhookUrl: tgWebhookUrl,
      tokenHelp: tgTokenHelp,
      webhookHelp: tgWebhookHelp,
      saveButton: tgSaveBtn,
      testButton: tgTestBtn,
    },
    vision: {
      form: visionForm,
      status: visionStatusText,
      saveButton: visionSaveBtn,
      testButton: visionTestBtn,
      render: renderVisionChannels,
      collect: collectVisionChannels,
      updateStatus: updateVisionStatusText,
      openTestModal: openVisionTestModal,
    },
  },
  actions: {
    mount() {},
    load() {
      loadGlobalEnvSettings();
    },
  },
});

const fileBrowserController = FileBrowserController.create({
  api: FileBrowserApi,
  view: FileBrowserView,
  actions: { toast, dialogConfirm, loadScripts, pathBasename },
});

const backupStorageController = BackupStorageController.create({
  api: BackupStorageApi,
  view: BackupStorageView,
  elements: {
    backupSelectBtn,
    backupImportBtn,
    backupFileInput,
    backupSelectCancelBtn,
    backupSelectAll,
    backupSelectionBar,
    backupSelectionCount,
    backupIncludeSecrets,
    backupExportBtn,
    backupImportModal,
    backupImportMask,
    backupAssetsModal: document.getElementById('backup-assets-modal'),
    backupAssetsMask: document.getElementById('backup-assets-mask'),
    storageCleanupDays,
    storageCleanupCategories,
    storageCleanupPreviewBtn,
    storageCleanupRunBtn,
    storageCleanupStatus,
    storageCleanupResult,
    cloudBackupForm,
    cloudBackupStatusText,
    cloudBackupEnabled,
    cloudBackupEndpoint,
    cloudBackupRegion,
    cloudBackupBucket,
    cloudBackupAccessKey,
    cloudBackupSecretKey,
    cloudBackupToken,
    cloudBackupProxy,
    cloudBackupPathStyle,
    cloudBackupPrefix,
    cloudBackupRetention,
    cloudBackupSchedule,
    cloudBackupTimeFields,
    cloudBackupHour,
    cloudBackupMinute,
    cloudBackupPassphrase,
    cloudBackupPassphraseConfirm,
    cloudBackupTestBtn,
    cloudBackupSaveBtn,
    cloudBackupClearBtn,
    cloudBackupLabel,
    cloudBackupRunBtn,
    cloudBackupRefreshBtn,
    cloudBackupNextText,
    cloudBackupList,
    cloudRestoreModal,
    cloudRestoreMask,
    cloudBackupUploadBtn,
    cloudBackupUploadInput,
  },
  actions: {
    getTasks: () => tasksCache,
    renderTasks: () => {
      lastTasksHtml = null;
      renderTasks();
    },
    createIcons: (root) => window.lucide?.createIcons(root ? { root } : undefined),
    toast,
    goLogin,
    formatBytes,
    formatFsMtime,
    promptFsName,
    dialogPassphrase,
    dialogPassphraseOnce,
    fetch: window.fetch.bind(window),
    goLogin,
    loadTasks,
    refreshAll,
    escapeHtml,
    formatBytes,
    dialogConfirm,
    confirm: (message) => window.confirm(message),
    uploadCloudBackupRestore,
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    downloadBlob(blob, filename) {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(link.href);
    },
  },
});
const backupStorageState = backupStorageController.state;
window.toggleBackupTask = backupStorageController.toggleBackupTask;

const schedulerController = SchedulerController.create({
  api: SchedulerApi,
  view: SchedulerView,
  elements: {
    form: schedulerForm,
    statusText: schedulerStatusText,
    allowParallel: schedulerAllowParallel,
    saveBtn: schedulerSaveBtn,
  },
  toast,
  createIcons: () => {
    if (window.lucide) window.lucide.createIcons();
  },
});

const browserResourcesController = BrowserResourcesController.create({
  api: BrowserResourcesApi,
  view: BrowserResourcesView,
  elements: {
    openBrowserBtn,
    closeBrowserBtn,
    addTaskBtn,
    browserProfileSelect,
    taskProfileSelect,
    taskProfileModeSelect,
    profilesList,
    addProfileBtn,
  },
  actions: {
    toast,
    shortTime,
    escapeHtml,
    dialogConfirm,
    isTaskTempProfileMode,
    setTaskBrowserProxyInput,
    updateProxyModeUI,
    setupPresetCustomControl,
    getPresetCustomValue,
    createEnvEditor,
    filterManagedEnvRows,
    PROFILE_MANAGED_ENV_KEYS,
    LOCALE_PRESETS,
    TIMEZONE_PRESETS,
    createIcons: (root) => {
      if (window.lucide) window.lucide.createIcons({ root });
    },
  },
});

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
    const res = await SettingsApi.loadVision();
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
      const res = await SettingsApi.updateVisionModel({ id: channelId, model: id });
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
      const res = await SettingsApi.testVision({
        id: card.dataset.channelId || '',
        baseUrl,
        apiKey: card.querySelector('.vision-ch-key')?.value?.trim() || '',
        model: modelInput.value.trim(),
        fetchModels: true,
        testImage: false, // 只要列表，不跑识图探测
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
  return TasksView.taskCard(task, groupName, {
    taskIsRunning, latestRunSummary, profileStore: browserResourcesController.profileStore, describeConditionValueFull,
    describeCondition, conditionStatusClass, describeConditionValue, describeNextRun,
    selectedBackupTaskIds: backupStorageState.selectedTaskIds,
    backupSelectionMode: backupStorageState.selectionMode,
    escapeHtml,
  });
}
function renderScripts() {
  if (!scriptSelectEl) return;
  const options = ['<option value="">请选择脚本</option>'];
  for (const script of scriptsCache) {
    const selected = taskEditorController.isSelectedScript(script.path) ? ' selected' : '';
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
  return TasksView.renderTaskGroups({
    taskGroupsCache, taskGroupFilter, tasksCache, taskIsRunning, taskCard, escapeHtml,
  });
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
  const data = await TasksApi.listTasks();
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

function normalizePluginPackagesForUi(value) {
  return String(value || '')
    .split(/[\r\n,;]+/g)
    .map(item => item.trim())
    .filter(Boolean)
    .join(', ');
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
    browserResourcesController.renderProfileOptions(taskProfileSelect, taskProfileSelect.value);
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






async function refreshAll() {
  await Promise.all([
    loadScripts(),
    loadRuns(),
    browserResourcesController.loadBrowserStatus(),
    browserResourcesController.loadProfiles(),
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
let refreshInFlight = false;
let refreshQueued = false;

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
    await Promise.all([loadRuns(), browserResourcesController.loadBrowserStatus()]);
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

const taskEditorController = TaskEditorController.createTaskEditorController({
  dependencies: {
    PROXY_ENV_ALIAS_KEYS, addTaskBtn, browserResourcesController, buildConditionPayloadFromForm, buildSchedulePayloadFromForm, collectSafeCurrentEnvRows,
    collectTaskEnvFromForm, collectTaskParamsFromForm, conditionCheckIntervalEl, conditionCheckUnitEl, conditionCooldownEl, conditionCooldownUnitEl,
    conditionEnabledEl, conditionExpectBodyEl, conditionJitterMaxEl, conditionJitterMinEl, conditionJitterUnitEl, conditionLastStatusText,
    conditionMethodEl, conditionProxyEl, conditionSuccessStatusesEl, conditionTestBtn, conditionTimeoutEl, conditionTypeEl,
    conditionUrlEl, conditionWindowUnitEl, conditionWindowValueEl, dailyDayMaxEl, dailyDayMinEl, dailyTimeEndEl,
    dailyTimeStartEl, deleteManagedMapKeys, deleteManagedObjectKeys, editScriptBtn, entriesFromParamsObject, fetchJson,
    escapeHtml, fillConditionForm, findManagedEnvValue, findManagedParamValue, fixedDaysEl, fixedHoursEl,
    fixedMinutesEl,
    form, formHint, formTitle, getConditionType, getTaskBrowserProxyFromForm, intervalMaxEl,
    intervalMinEl, intervalUnitEl, isHost2PlayScript, isTaskTempProfileMode, loadScripts, modal,
    modalCloseBtn, modalImportBtn, modalImportForm, modalMask, modalTitle, parseParamsJson,
    parseTaskSchedule, refreshScriptsModalBtn, renderScripts, renderTaskGroupOptions, resetBtn,
    resetConditionForm, saveBtn, scheduleModeSelect, scriptSelectEl, setTaskBrowserProxyInput, setTaskProfileMode,
    syncTaskParamsUI, taskProfileSelect, taskUseGlobalTelegram, taskUsePersistentInput, unitValueToSec, updateConditionFieldsUI,
    updateDailyWindowSummary, updateFixedSummary, updateIntervalSummary, updateRemainingThresholdPreview, updateScheduleDetailsUI, updateScheduleModeUI,
    updateTaskFormSummary, updateTaskProfileModeUI, useScriptBtn,
    loadTasks: refreshAll,
  },
  getTasks: () => tasksCache,
  getScripts: () => scriptsCache,
  setScripts: (scripts) => { scriptsCache = scripts; },
});

const statusStream = createEventStream({
  refreshStatus,
  loadWarpStatus,
  isRedirecting: () => redirectingToLogin,
});

function scheduleRefresh() {
  statusStream.scheduleRefresh();
}

function startStatusStream() {
  statusStream.start();
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
    await TasksApi.runTask(id, profileId);
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
    await TasksApi.stopTask(id);
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

window.runTask = runTask;
window.stopTask = stopTask;
window.showTaskRuns = showTaskRuns;
window.openRunScreenshots = openRunScreenshots;

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
      const res = await SettingsApi.testVision({
        id: live.id || '',
        baseUrl: live.baseUrl,
        apiKey: live.apiKey || '',
        model: live.model || '',
        fetchModels: true,
        testImage: Boolean(testImage),
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
  taskProxyFromProfileBtn.addEventListener('click', () => browserResourcesController.fillTaskProxyFromSelectedProfile());
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

  const passwordForm = dialog.querySelector('.cp-form');
  const okBtn = dialog.querySelector('.cp-ok');
  passwordForm.addEventListener('submit', async (event) => {
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

  fileBrowserController.mount();
  browserResourcesController.mount();
  settingsController.mount();
  backupStorageController.mount();
  schedulerController.mount();
  taskEditorController.mount();

  taskEditorController.reset();
  taskEditorController.closeModal();
  refreshAll();
  startStatusStream();
  schedulerController.load();
  loadSuccessHeuristicsSettings();
  loadBrowserRuntimeSettings();
  settingsController.load();
  backupStorageController.load();
  fileBrowserController.load();
}

window.PanelRuntime = {
  start: bootPanel,
};
