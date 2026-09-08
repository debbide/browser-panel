const { fetchJson, goLogin } = SessionApi;

const { dialogPassphrase, dialogPassphraseOnce } = UiFeedback;
const { copyText } = Clipboard;
const { classifyShotKind, formatBytes, indexLatestRunsByTask, logLineClass, prettyErrorCode } = RunPresentation;
const { toast, dialogConfirm } = window;


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

const appNavigation = AppNavigation.create({
  closeTaskOverflow: () => closeTaskOverflow(),
  loadFileBrowser: () => fileBrowserController.load(),
  loadBrowserResource: (kind) => browserResourcesController.loadResourceManager(kind),
  loadWarpStatus: () => loadWarpStatus(),
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
  return window.TaskScheduleModel.buildSchedulePayload({
    enabled: form.elements.enabled.checked,
    mode: getScheduleMode(),
    fixedDays: fixedDaysEl.value,
    fixedHours: fixedHoursEl.value,
    fixedMinutes: fixedMinutesEl.value,
    intervalMin: intervalMinEl.value,
    intervalMax: intervalMaxEl.value,
    intervalUnit: intervalUnitEl.value,
    dailyTimeStart: dailyTimeStartEl?.value,
    dailyTimeEnd: dailyTimeEndEl?.value,
    dailyDayMin: dailyDayMinEl?.value,
    dailyDayMax: dailyDayMaxEl?.value,
  });
}

const {
  describeTaskSchedule,
  intervalToUnitValue,
  parseTaskSchedule,
  unitValueToSec,
} = window.TaskScheduleModel;

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
  return window.TaskConditionModel.buildConditionPayload({
    enabled: Boolean(conditionEnabledEl?.checked),
    type: getConditionType(),
    checkInterval: conditionCheckIntervalEl?.value,
    checkUnit: conditionCheckUnitEl?.value,
    cooldown: conditionCooldownEl?.value,
    cooldownUnit: conditionCooldownUnitEl?.value,
    url: conditionUrlEl?.value,
    proxy: conditionProxyEl?.value,
    method: conditionMethodEl?.value,
    timeout: conditionTimeoutEl?.value,
    successStatuses: conditionSuccessStatusesEl?.value,
    expectBody: conditionExpectBodyEl?.value,
    windowValue: conditionWindowValueEl?.value,
    windowUnit: conditionWindowUnitEl?.value,
    jitterMin: conditionJitterMinEl?.value,
    jitterMax: conditionJitterMaxEl?.value,
    jitterUnit: conditionJitterUnitEl?.value,
    triggerIfExpired: conditionTriggerIfExpiredEl?.checked,
  }, unitValueToSec);
}

function fillConditionForm(task) {
  applyConditionFormValues(window.TaskConditionModel.getFormValues(task, intervalToUnitValue));
  updateConditionLastStatusText(task);
  updateConditionCallbackStatusText(task);
  updateConditionFieldsUI();
}

function resetConditionForm() {
  applyConditionFormValues(window.TaskConditionModel.getDefaultFormValues());
  updateConditionLastStatusText(null);
  updateConditionCallbackStatusText(null);
  updateConditionFieldsUI();
}

function applyConditionFormValues(values) {
  window.TaskConditionFormView.applyFormValues({
    enabled: conditionEnabledEl,
    type: conditionTypeEl,
    checkInterval: conditionCheckIntervalEl,
    checkUnit: conditionCheckUnitEl,
    cooldown: conditionCooldownEl,
    cooldownUnit: conditionCooldownUnitEl,
    url: conditionUrlEl,
    proxy: conditionProxyEl,
    method: conditionMethodEl,
    timeout: conditionTimeoutEl,
    successStatuses: conditionSuccessStatusesEl,
    expectBody: conditionExpectBodyEl,
    windowValue: conditionWindowValueEl,
    windowUnit: conditionWindowUnitEl,
    jitterMin: conditionJitterMinEl,
    jitterMax: conditionJitterMaxEl,
    jitterUnit: conditionJitterUnitEl,
    triggerIfExpired: conditionTriggerIfExpiredEl,
  }, values);
}

function updateConditionFieldsUI() {
  const on = Boolean(conditionEnabledEl && conditionEnabledEl.checked);
  const state = window.TaskConditionModel.getFieldsState(on, getConditionType());
  window.TaskConditionFormView.renderFieldsState({
    fields: conditionFieldsEl,
    httpFields: conditionHttpFieldsEl,
    remainingFields: conditionRemainingFieldsEl,
    hint: document.getElementById('condition-type-hint'),
    testLabel: document.getElementById('condition-test-btn-label'),
    testButton: conditionTestBtn,
  }, state);
  if (state.showRemainingPreview) updateRemainingThresholdPreview();
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
  const text = window.TasksModel.buildTaskFormSummary({
    scriptPath: form?.elements?.script_path?.value,
    timeout: form?.elements?.timeout_sec?.value,
    scheduleEnabled: isScheduleEnabled(),
    scheduleMode: getScheduleMode(),
    conditionEnabled: Boolean(conditionEnabledEl && conditionEnabledEl.checked),
    temporaryProfile: isTaskTempProfileMode(),
  });
  if (scriptSummaryEl) scriptSummaryEl.textContent = text.scriptSummary;
  if (summaryEl) summaryEl.textContent = text.summary;
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

const {
  conditionStatusClass,
  describeCondition,
  describeConditionValue,
  describeConditionValueFull,
  formatRemainingSec,
} = window.TaskConditionPresentation;

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
  return window.TasksModel.isHost2PlayScript(scriptPath);
}

function parseParamsJson(raw) {
  return window.TasksModel.parseParamsJson(raw);
}

const { createEnvEditor, parseEnvText, looksLikeSecretName } = EnvironmentEditor;

const taskEnvUI = createEnvEditor(taskEnvEditor);
const globalEnvUI = createEnvEditor(globalEnvEditor);

const visionSettingsUi = VisionSettingsUi.create({
  api: SettingsApi,
  elements: {
    form: visionForm,
    status: visionStatusText,
    channelsList: visionChannelsList,
    addButton: visionAddChannelBtn,
  },
  actions: {
    toast,
    escapeHtml,
    openTestModalForCard: (card) => openVisionTestModalForCard(card),
  },
});

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
      render: visionSettingsUi.render,
      collect: visionSettingsUi.collect,
      updateStatus: visionSettingsUi.updateStatus,
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
  actions: {
    toast,
    dialogConfirm,
    loadScripts,
    pathBasename(path) {
      const normalizedPath = String(path || '').replace(/\\/g, '/');
      const separatorIndex = normalizedPath.lastIndexOf('/');
      return separatorIndex >= 0 ? normalizedPath.slice(separatorIndex + 1) : normalizedPath;
    },
  },
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
    formatBytes,
    formatFsMtime,
    promptFsName,
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
  return window.TasksModel.entriesFromParamsObject(params, looksLikeSecretName);
}

function readUseGlobalTelegramFlag(paramsOrEnv) {
  return window.TasksModel.readUseGlobalTelegramFlag(paramsOrEnv);
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
  return window.TasksModel.paramsFromEnvRows(collectTaskEnvFromForm());
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
  taskEnvUI.setRows(window.TasksModel.mergeHost2PlayTemplate(current));
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

function groupLastRuns(runs) {
  lastRunsByTask = indexLatestRunsByTask(runs);
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

visionSettingsUi.mountAddButton();

/** Open modal: test a specific channel card (or primary if omitted). */
function openVisionTestModalForCard(cardEl) {
  const channel = visionSettingsUi.readCard(cardEl) || visionSettingsUi.collect()[0] || {};
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
    const live = visionSettingsUi.readCard(targetCard) || channel;
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
      visionSettingsUi.promote(targetCard);
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

const authUi = AuthUi.create({
  fetchJson,
  toast,
});

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

  authUi.wire(state.username);

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
