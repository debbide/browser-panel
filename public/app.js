async function fetchJson(url, options) {
  const res = await fetch(url, options);
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
const openBrowserBtn = document.getElementById('open-browser-btn');
const browserProfileSelect = document.getElementById('browser-profile-select');
const taskProfileSelect = document.getElementById('task-profile-select');
const taskProfileModeSelect = document.getElementById('task-profile-mode');
const taskProfileModeHint = document.getElementById('task-profile-mode-hint');
const taskProfilePersistentFields = document.getElementById('task-profile-persistent-fields');
const taskUsePersistentInput = document.getElementById('task-use-persistent');
const taskProxyInput = document.getElementById('task-proxy-input');
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

const tgForm = document.getElementById('tg-form');
const tgStatusText = document.getElementById('tg-status-text');
const tgBotToken = document.getElementById('tg-bot-token');
const tgChatId = document.getElementById('tg-chat-id');
const tgProxy = document.getElementById('tg-proxy');
const tgTokenHelp = document.getElementById('tg-token-help');
const tgSaveBtn = document.getElementById('tg-save-btn');
const tgTestBtn = document.getElementById('tg-test-btn');
const browserRuntimeForm = document.getElementById('browser-runtime-form');
const browserRuntimeStatus = document.getElementById('browser-runtime-status');
const brRuntimeStack = document.getElementById('br-runtime-stack');
const brUsePlaywrightExtra = document.getElementById('br-use-playwright-extra');
const brPluginPackages = document.getElementById('br-plugin-packages');
const brSaveBtn = document.getElementById('br-save-btn');
const brInstallBtn = document.getElementById('br-install-btn');
const brInstallBrowserBtn = document.getElementById('br-install-browser-btn');
const visionForm = document.getElementById('vision-form');
const visionStatusText = document.getElementById('vision-status-text');
const visionChannelsList = document.getElementById('vision-channels-list');
const visionAddChannelBtn = document.getElementById('vision-add-channel');
const visionSaveBtn = document.getElementById('vision-save-btn');
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

const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const targetId = btn.getAttribute('data-tab');
    
    tabBtns.forEach(b => {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    tabContents.forEach(c => {
      c.classList.remove('active');
      c.hidden = true;
      c.setAttribute('aria-hidden', 'true');
    });
    
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    const panel = document.getElementById(targetId);
    panel.classList.add('active');
    panel.hidden = false;
    panel.setAttribute('aria-hidden', 'false');
  });
});

let editingId = null;
let tasksCache = [];
let runsCache = [];
let runningTaskIds = new Set();
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
  if (openBrowserBtn) openBrowserBtn.disabled = browserSessionOpen;
  if (closeBrowserBtn) closeBrowserBtn.disabled = !browserSessionOpen;
  if (openBrowserBtn) openBrowserBtn.textContent = browserSessionOpen ? '浏览器已启动' : '启动浏览器';
  if (closeBrowserBtn) closeBrowserBtn.textContent = browserSessionOpen ? '关闭浏览器' : '浏览器未启动';
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
  try {
    const profileId = browserProfileSelect ? browserProfileSelect.value : '';
    await fetchJson('/api/browser/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile_id: profileId || null }) });
    await loadBrowserStatus();
    toast('浏览器已成功启动', 'success');
  } catch (error) {
    toast(error.message || '浏览器启动失败', 'error');
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

  updateFixedSummary();
  updateIntervalSummary();
}

function buildSchedulePayloadFromForm() {
  const enabled = form.elements.enabled.checked;
  if (!enabled) {
    return { enabled: false, cron_expr: '', schedule_mode: 'fixed', interval_min: null, interval_max: null, interval_unit: null, daily_time_start: null, daily_time_end: null, next_run_at: null };
  }

  if (getScheduleMode() === 'daily_window') {
    return {
      enabled: true,
      cron_expr: '',
      schedule_mode: 'daily_window',
      interval_min: null,
      interval_max: null,
      interval_unit: null,
      daily_time_start: dailyTimeStartEl?.value || '08:00',
      daily_time_end: dailyTimeEndEl?.value || '12:00',
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
    return { enabled: false, mode: 'fixed', fixedDays: 0, fixedHours: 4, fixedMinutes: 0, intervalMin: 5, intervalMax: 10, intervalUnit: 'minutes', dailyTimeStart: '08:00', dailyTimeEnd: '12:00' };
  }
  if (task.schedule_mode === 'daily_window') {
    return { enabled: true, mode: 'daily_window', fixedDays: 0, fixedHours: 4, fixedMinutes: 0, intervalMin: 5, intervalMax: 10, intervalUnit: 'minutes', dailyTimeStart: task.daily_time_start || '08:00', dailyTimeEnd: task.daily_time_end || '12:00' };
  }
  if (task.schedule_mode === 'interval') {
    return { enabled: true, mode: 'interval', fixedDays: 0, fixedHours: 4, fixedMinutes: 0, intervalMin: Number(task.interval_min || 5), intervalMax: Number(task.interval_max || 10), intervalUnit: task.interval_unit || 'minutes', dailyTimeStart: '08:00', dailyTimeEnd: '12:00' };
  }
  let totalMinutes = Number(task.interval_min || task.interval_max || 0);
  if ((task.interval_unit || 'minutes') === 'days') totalMinutes *= 24 * 60;
  else if ((task.interval_unit || 'minutes') === 'hours') totalMinutes *= 60;
  const fixedDays = Math.floor(totalMinutes / (24 * 60));
  totalMinutes -= fixedDays * 24 * 60;
  const fixedHours = Math.floor(totalMinutes / 60);
  totalMinutes -= fixedHours * 60;
  return { enabled: true, mode: 'fixed', fixedDays, fixedHours, fixedMinutes: totalMinutes, intervalMin: 5, intervalMax: 10, intervalUnit: 'minutes', dailyTimeStart: '08:00', dailyTimeEnd: '12:00' };
}

function describeTaskSchedule(task) {
  if (!task.enabled) return '未启用';
  if (task.schedule_mode === 'daily_window') return `每天 ${task.daily_time_start || '00:00'}-${task.daily_time_end || '23:59'} 随机`;
  if (task.schedule_mode === 'interval') return `${task.interval_min} - ${task.interval_max} ${prettyUnit(task.interval_unit)}之间`;
  const parsed = parseTaskSchedule(task);
  return `${parsed.fixedDays}天 ${parsed.fixedHours}小时 ${parsed.fixedMinutes}分`;
}

function describeNextRun(task) {
  if (!task.enabled) return '未启用';
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
      .map((e) => ({
        name: e.name,
        value: e.value == null ? '' : String(e.value),
        is_secret: e.is_secret ? 1 : 0,
      }));
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

  // Hide internal control keys from the visible list (managed by UI switches)
  const HIDDEN_ENV_KEYS = new Set([
    'USE_GLOBAL_TELEGRAM',
    'USE_TEMP_PROFILE',
    'use_temp_profile',
    'use_global_telegram',
  ]);
  let rows = paramsOrEnv;
  if (Array.isArray(paramsOrEnv)) {
    rows = paramsOrEnv.filter((e) => !HIDDEN_ENV_KEYS.has(String(e?.name || '').toUpperCase()) && !HIDDEN_ENV_KEYS.has(String(e?.name || '')));
    // also filter case-insensitively
    rows = paramsOrEnv.filter((e) => {
      const n = String(e?.name || '').toUpperCase();
      return n !== 'USE_GLOBAL_TELEGRAM' && n !== 'USE_TEMP_PROFILE';
    });
    taskEnvUI.setRows(rows);
  } else {
    const obj = { ...(paramsOrEnv || {}) };
    delete obj.USE_GLOBAL_TELEGRAM;
    delete obj.use_global_telegram;
    delete obj.USE_TEMP_PROFILE;
    delete obj.use_temp_profile;
    taskEnvUI.setRows(entriesFromParamsObject(obj));
  }

  if (taskUseGlobalTelegram) {
    taskUseGlobalTelegram.checked = readUseGlobalTelegramFlag(paramsOrEnv);
  }

  if (isHost2 && form.elements.timeout_sec && Number(form.elements.timeout_sec.value || 0) < 600) {
    form.elements.timeout_sec.value = '900';
  }
}

function collectTaskEnvFromForm() {
  return taskEnvUI.collect();
}

function collectTaskParamsFromForm() {
  // Backward-compatible flat object (also used for USE_TEMP_PROFILE side effects)
  const env = collectTaskEnvFromForm();
  const params = {};
  for (const item of env) {
    if (!item.name) continue;
    params[item.name] = item.value;
  }
  return params;
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
  card.className = 'vision-channel-card';
  card.dataset.visionChannel = '1';

  const masked = channel.apiKeyMasked || '';
  const keyPlaceholder = masked ? `已保存 ${masked}` : 'API Key';
  const label = isPrimary ? '主' : String(index);

  card.innerHTML = `
    <div class="vision-channel-row">
      <span class="vision-channel-badge">${label}</span>
      <input type="text" class="vision-ch-base" placeholder="Base URL" value="${(channel.baseUrl || '').replace(/"/g, '&quot;')}" />
      <input type="password" class="vision-ch-key" placeholder="${keyPlaceholder.replace(/"/g, '&quot;')}" autocomplete="new-password" />
      <input type="text" class="vision-ch-model" placeholder="Model" value="${(channel.model || '').replace(/"/g, '&quot;')}" />
      <button type="button" class="icon-btn vision-channel-remove" title="删除" ${isPrimary ? 'disabled style="visibility:hidden;"' : ''}>
        <i data-lucide="trash-2" class="icon-sm"></i>
      </button>
    </div>
  `;

  const removeBtn = card.querySelector('.vision-channel-remove');
  if (removeBtn && !isPrimary) {
    removeBtn.addEventListener('click', () => {
      card.remove();
      renumberVisionChannels();
    });
  }
  return card;
}

function renumberVisionChannels() {
  if (!visionChannelsList) return;
  const cards = visionChannelsList.querySelectorAll('[data-vision-channel]');
  cards.forEach((card, i) => {
    const badge = card.querySelector('.vision-channel-badge');
    if (badge) badge.textContent = i === 0 ? '主' : String(i);
    const removeBtn = card.querySelector('.vision-channel-remove');
    if (removeBtn) {
      removeBtn.style.visibility = i === 0 ? 'hidden' : 'visible';
      removeBtn.disabled = i === 0;
    }
  });
}

function renderVisionChannels(list) {
  if (!visionChannelsList) return;
  visionChannelsList.innerHTML = '';
  const channels = Array.isArray(list) && list.length ? list : [{}];
  channels.forEach((ch, i) => visionChannelsList.appendChild(makeVisionChannelCard(ch, i)));
  if (window.lucide) window.lucide.createIcons();
}

function collectVisionChannels() {
  if (!visionChannelsList) return [];
  const cards = visionChannelsList.querySelectorAll('[data-vision-channel]');
  const out = [];
  cards.forEach((card) => {
    const baseUrl = card.querySelector('.vision-ch-base')?.value?.trim() || '';
    const apiKey = card.querySelector('.vision-ch-key')?.value?.trim() || '';
    const model = card.querySelector('.vision-ch-model')?.value?.trim() || '';
    if (!baseUrl && !apiKey && !model) return;
    out.push({ baseUrl, apiKey, model });
  });
  return out;
}

async function loadVisionSettings() {
  if (!visionForm) return;
  try {
    const res = await fetchJson('/api/settings/vision');
    const data = res.data || {};
    renderVisionChannels(data.channelList);
    if (visionStatusText) {
      const count = Number(data.channelCount || 0);
      const base = data.configured ? 'Status: configured' : 'Status: not configured';
      visionStatusText.textContent = count > 1 ? `${base} · ${count} 通道` : base;
      visionStatusText.style.color = data.configured ? '#86efac' : '#94a3b8';
    }
  } catch (error) {
    if (visionStatusText) {
      visionStatusText.textContent = 'Status: load failed';
      visionStatusText.style.color = '#ef4444';
    }
    console.error('Failed to load vision settings:', error);
  }
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
  setTaskProxyInput('');
  setTaskProfileMode('temp');
  if (taskProfileSelect) renderProfileOptions(taskProfileSelect, '');
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
  updateScheduleModeUI();
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
  const lower = String(name || '').toLowerCase();
  if (lower.startsWith('instr_')) return '题目';
  if (lower.includes('_grid.png')) return '标注';
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

  const render = () => {
    const active = items[activeIndex] || items[0];
    const thumbs = items.map((item, idx) => {
      const selected = idx === activeIndex ? ' is-active' : '';
      return '<button type="button" class="shot-thumb' + selected + '" data-shot-index="' + idx + '">'
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
      + '    <div class="shots-thumbs">' + thumbs + '</div>'
      + '    <div class="shots-preview">'
      + '      <div class="shots-preview-meta">'
      + '        <strong>' + escapeHtml(active.name) + '</strong>'
      + '        <span class="muted">' + escapeHtml(classifyShotKind(active.name)) + ' · ' + escapeHtml(formatBytes(active.size)) + '</span>'
      + '      </div>'
      + '      <div class="shots-preview-frame">'
      + '        <img src="' + escapeHtml(active.url) + '" alt="' + escapeHtml(active.name) + '" />'
      + '      </div>'
      + '      <div class="row shots-preview-actions">'
      + '        <a href="' + escapeHtml(active.url) + '" target="_blank">新窗口打开</a>'
      + '        <span class="muted">' + (activeIndex + 1) + ' / ' + items.length + '</span>'
      + '      </div>'
      + '    </div>'
      + '  </div>'
      + '</div>';

    dialog.querySelector('[data-close-shots-modal]').addEventListener('click', close);
    dialog.querySelectorAll('[data-shot-index]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeIndex = Number(btn.getAttribute('data-shot-index')) || 0;
        render();
      });
    });
    if (window.lucide) window.lucide.createIcons({ root: dialog });
  };

  const close = () => {
    mask.remove();
    dialog.remove();
  };

  document.body.appendChild(mask);
  document.body.appendChild(dialog);
  mask.addEventListener('click', close);
  render();
}

function runCard(run) {
  const logHref = run.log_path ? `/${run.log_path.replace(/^.*?(logs\/)/, '$1')}` : '';
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
        ${logHref ? `<a href="${logHref}" target="_blank">\u539f\u6587</a>` : ''}
        ${screenshotHref ? `<a href="${screenshotHref}" target="_blank">\u67e5\u770b\u622a\u56fe</a>` : ''}
        <button type="button" class="linkish" data-open-run-shots="${run.id}">\u67e5\u770b\u622a\u56fe\u96c6</button>
      </div>
      ${run.error_text ? `<pre>${escapeHtml(run.error_text)}</pre>` : ''}
    </div>`;
}

async function openRunLog(runId) {
  const res = await fetchJson(`/api/runs/${runId}/log?tail=150`);
  const data = res.data || {};
  const mask = document.createElement('div');
  mask.className = 'modal-mask open';
  mask.style.zIndex = '10020';

  const dialog = document.createElement('section');
  dialog.className = 'modal modal-wide open log-viewer-modal';
  dialog.style.zIndex = '10030';
  dialog.setAttribute('aria-hidden', 'false');

  const statusLabel = prettyStatus(data.status || '-');
  const errLabel = prettyErrorCode(data.errorCode) || data.errorCode || '-';
  const summaryHtml = data.summary
    ? `<pre class="log-viewer-summary">${escapeHtml(data.summary)}</pre>`
    : '<p class="muted">\u65e0\u6458\u8981 section</p>';

  dialog.innerHTML = `
    <div class="modal-header">
      <div>
        <h2>\u8fd0\u884c\u65e5\u5fd7 #${runId}</h2>
        <p class="muted">\u4efb\u52a1 #${data.taskId || '-'} \u00b7 ${escapeHtml(statusLabel)} \u00b7 ${escapeHtml(String(errLabel))} \u00b7 ${data.totalLines || 0} \u884c</p>
      </div>
      <button class="icon-btn" type="button" aria-label="\u5173\u95ed" data-close-log-modal>
        <i data-lucide="x" class="icon-md"></i>
      </button>
    </div>
    <div class="modal-body log-viewer-body">
      <div class="log-viewer-toolbar row" style="gap:8px; margin-bottom:10px; flex-wrap:wrap;">
        <button type="button" class="alt" data-log-mode="summary">\u6458\u8981</button>
        <button type="button" class="alt" data-log-mode="tail">\u6700\u540e ${data.tail || 150} \u884c</button>
        <button type="button" class="alt" data-log-mode="full">\u5168\u6587</button>
        ${data.logUrl ? `<a class="alt btn-with-icon" href="${escapeHtml(data.logUrl)}" target="_blank" style="display:inline-flex;align-items:center;">\u65b0\u7a97\u53e3</a>` : ''}
      </div>
      <div class="log-viewer-panel" data-log-panel="summary">${summaryHtml}</div>
      <div class="log-viewer-panel" data-log-panel="tail" hidden>
        <pre class="log-viewer-pre">${escapeHtml(data.content || '')}</pre>
      </div>
      <div class="log-viewer-panel" data-log-panel="full" hidden>
        <pre class="log-viewer-pre muted">\u70b9\u51fb\u300c\u5168\u6587\u300d\u52a0\u8f7d\u2026</pre>
      </div>
    </div>
  `;

  const close = () => {
    mask.remove();
    dialog.remove();
  };

  document.body.appendChild(mask);
  document.body.appendChild(dialog);
  mask.addEventListener('click', close);
  dialog.querySelector('[data-close-log-modal]').addEventListener('click', close);

  const panels = {
    summary: dialog.querySelector('[data-log-panel="summary"]'),
    tail: dialog.querySelector('[data-log-panel="tail"]'),
    full: dialog.querySelector('[data-log-panel="full"]'),
  };
  let fullLoaded = false;

  function showPanel(mode) {
    Object.keys(panels).forEach((key) => {
      if (panels[key]) panels[key].hidden = key !== mode;
    });
  }

  dialog.querySelectorAll('[data-log-mode]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const mode = btn.getAttribute('data-log-mode');
      if (mode === 'full' && !fullLoaded) {
        try {
          const fullRes = await fetchJson(`/api/runs/${runId}/log?full=1`);
          const fullData = fullRes.data || {};
          panels.full.innerHTML = `<pre class="log-viewer-pre">${escapeHtml(fullData.content || '')}</pre>`;
          fullLoaded = true;
        } catch (error) {
          toast(error.message || '\u52a0\u8f7d\u5168\u6587\u5931\u8d25', 'error');
          return;
        }
      }
      showPanel(mode);
    });
  });

  if (window.lucide) window.lucide.createIcons({ root: dialog });
}

async function showTaskRuns(id) {
  const data = await fetchJson(`/api/tasks/${id}/runs`);
  openTaskRunsModal(id, data.data || []);
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
      const runId = Number(btn.getAttribute('data-open-run-log'));
      try {
        await openRunLog(runId);
      } catch (error) {
        toast(error.message || '加载日志失败', 'error');
      }
    });
  });
  if (window.lucide) window.lucide.createIcons({ root: dialog });
}

function latestRunSummary(taskId) {
  const run = lastRunsByTask.get(taskId);
  if (!run) return { status: '未运行', detail: '还没有运行记录', className: 'idle' };
  return {
    status: prettyStatus(run.status),
    detail: run.error_code ? prettyErrorCode(run.error_code) : `最近：${shortTime(run.started_at)}`,
    className: run.status === 'success' ? 'success' : run.status === 'failed' ? 'failed' : 'idle',
  };
}

function taskCard(task) {
  const isRunning = runningTaskIds.has(task.id) || Boolean(task.is_running);
  const latest = latestRunSummary(task.id);
  const scriptLabel = task.script_path ? `已绑定脚本 · ${getScriptLabel(task.script_path)}` : '未绑定脚本';
  const isPersistent = Boolean(Number(task.use_persistent));
  const profileName = (() => {
    if (!task.browser_profile_id) return isPersistent ? '默认配置' : '临时目录';
    const p = profilesCache.find((x) => Number(x.id) === Number(task.browser_profile_id));
    return p ? p.name : `#${task.browser_profile_id}`;
  })();
  const profilePill = isPersistent
    ? `<span class="pill pill-persistent" title="持久浏览器配置">持久 · ${escapeHtml(profileName)}</span>`
    : `<span class="pill pill-temp" title="临时 profile，不写持久目录">临时 · ${escapeHtml(profileName)}</span>`;
  return `
    <article class="task-card ${isRunning ? 'task-running' : ''}" data-testid="task-card" data-task-id="${task.id}">
      <div class="task-card-top">
        <div>
          <div class="task-title-row">
            <h3>${escapeHtml(task.name)}</h3>
            <span class="pill pill-type">${escapeHtml(task.type)}</span>
            ${profilePill}
            ${isRunning ? '<span class="pill pill-running">运行中</span>' : ''}
          </div>
          <div class="task-subtitle">${escapeHtml(scriptLabel)}</div>
        </div>
        <button class="icon-btn" onclick="editTask(${task.id})" ${isRunning ? 'disabled' : ''} data-testid="edit-task-btn">编辑</button>
      </div>
      <div class="task-metrics">
        <div class="metric-card ${latest.className}">
          <span class="metric-label">最新结果</span>
          <div class="status-indicator">
            <span class="dot ${latest.className}"></span>
            <span data-testid="task-status">${escapeHtml(latest.status)}</span>
          </div>
          <span class="metric-value">${escapeHtml(latest.detail)}</span>
        </div>
        <div class="metric-card">
          <span class="metric-label">定时</span>
          <div class="status-indicator">
            <span class="dot ${task.enabled ? 'active' : 'idle'}"></span>
            <span>${task.enabled ? (task.schedule_mode === 'daily_window' ? '每天随机时段' : (task.schedule_mode === 'interval' ? '随机区间' : '固定周期')) : '未启用'}</span>
          </div>
          <span class="metric-value">${escapeHtml(describeNextRun(task))}</span>
        </div>
      </div>
      <div class="task-actions">
        <button onclick="runTask(${task.id})" ${isRunning ? 'disabled' : ''} data-testid="run-task-btn">${isRunning ? '运行中…' : '启动'}</button>
        <button class="alt" onclick="stopTask(${task.id})" ${!isRunning ? 'disabled' : ''} data-testid="stop-task-btn">停止</button>
        <button class="alt" onclick="showTaskRuns(${task.id})">记录</button>
        <button class="alt danger" onclick="deleteTask(${task.id})" ${isRunning ? 'disabled' : ''} data-testid="delete-task-btn">删除</button>
      </div>
    </article>`;
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

async function loadTasks() {
  const data = await fetchJson('/api/tasks');
  tasksCache = data.data;
  tasksEl.innerHTML = data.data.map(taskCard).join('') || '<p class="empty">当前还没有任务。</p>';
}

async function loadRuns() {
  const data = await fetchJson('/api/runs');
  runsCache = data.data;
  groupLastRuns(runsCache);
}

async function loadTelegramSettings() {
  try {
    const res = await fetchJson('/api/settings/telegram');
    const { configured, chatId, botTokenMasked, proxy } = res.data;
    
    tgStatusText.textContent = configured ? '状态：已配置' : '状态：未配置';
    tgStatusText.style.color = configured ? '#86efac' : '#94a3b8';
    
    tgChatId.value = chatId || '';
    if (tgProxy) tgProxy.value = proxy || '';
    tgBotToken.value = '';
    tgBotToken.setAttribute('aria-describedby', 'tg-token-help');
    
    if (botTokenMasked) {
      tgTokenHelp.textContent = `当前 Token: ${botTokenMasked}`;
    } else {
      tgTokenHelp.textContent = '未设置 Token';
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

function setBrowserRuntimeStatus(text, color) {
  if (!browserRuntimeStatus) return;
  browserRuntimeStatus.textContent = text;
  if (color) browserRuntimeStatus.style.color = color;
}

function collectBrowserRuntimeFormPayload() {
  return {
    runtimeStack: brRuntimeStack?.value || 'playwright',
    usePlaywrightExtra: Boolean(brUsePlaywrightExtra?.checked),
    pluginPackages: normalizePluginPackagesForUi(brPluginPackages?.value),
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
    const packageCount = normalizePluginPackagesForUi(data.pluginPackages).split(',').map(s => s.trim()).filter(Boolean).length;
    const runtimeStack = data.runtimeStack || 'playwright';
    const stackLabel = runtimeStack === 'seleniumbase'
      ? 'SeleniumBase + ChromeDriver'
      : 'Playwright';
    const pluginStatus = runtimeStack === 'seleniumbase'
      ? 'Playwright 插件配置已保留'
      : (data.usePlaywrightExtra ? '已启用 playwright-extra' : '使用原生 playwright');
    setBrowserRuntimeStatus(`状态：${stackLabel}，${pluginStatus}，插件数：${packageCount}`, '#94a3b8');
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
      ? '\u4e34\u65f6\u6a21\u5f0f\uff1a\u6bcf\u6b21\u72ec\u7acb user-data-dir\uff0c\u8dd1\u5b8c\u9694\u79bb\u3002\u4ee3\u7406\u53ef\u5355\u72ec\u586b\u5199\uff0c\u65e0\u9700\u7ed1\u5b9a\u4f1a\u5199\u6570\u636e\u7684\u914d\u7f6e\u3002'
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

function getTaskProxyFromForm() {
  return String(taskProxyInput?.value || '').trim();
}

function setTaskProxyInput(value) {
  if (taskProxyInput) taskProxyInput.value = String(value || '').trim();
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
  if (!p.proxy) {
    toast('\u8be5\u914d\u7f6e\u672a\u8bbe\u7f6e\u4ee3\u7406', 'warn');
    return;
  }
  setTaskProxyInput(p.proxy);
  toast('\u5df2\u586b\u5165\u914d\u7f6e\u4ee3\u7406\uff08\u4ecd\u4f7f\u7528\u4e34\u65f6\u6570\u636e\u76ee\u5f55\uff09', 'success');
}

function extractProxyFromEnvList(envList) {
  if (!Array.isArray(envList)) return '';
  const hit = envList.find((e) => String(e?.name || '').toUpperCase() === 'BROWSER_PROXY');
  return hit ? String(hit.value || '') : '';
}

function extractProxyFromParams(params = {}) {
  if (!params || typeof params !== 'object') return '';
  return String(params.BROWSER_PROXY || params.browser_proxy || '').trim();
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
          <span class="profile-kv-label">\u8fd0\u884c\u6808</span>
          <span class="profile-kv-value">${escapeHtml((p.runtime_stack || '').trim() ? p.runtime_stack : 'default')}</span>
        </div>
        <div class="profile-kv">
          <span class="profile-kv-label">\u4ee3\u7406</span>
          <span class="profile-kv-value">${escapeHtml(p.proxy || '\u65e0')}</span>
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
          <label class="field-label">\u4ee3\u7406\u5730\u5740</label>
          <input name="proxy" placeholder="socks5://127.0.0.1:7891" value="${escapeHtml(profile?.proxy || '')}" />
        </div>
        <div>
          <label class="field-label">\u8fd0\u884c\u6808</label>
          <select name="runtime_stack">
            <option value="" ${(profile?.runtime_stack || '') === '' ? 'selected' : ''}>\u8ddf\u968f\u5168\u5c40\u9ed8\u8ba4</option>
            <option value="playwright" ${(profile?.runtime_stack || '') === 'playwright' ? 'selected' : ''}>Playwright</option>
            <option value="seleniumbase" ${(profile?.runtime_stack || '') === 'seleniumbase' ? 'selected' : ''}>SeleniumBase + ChromeDriver</option>
          </select>
        </div>
        <div>
          <label class="field-label">Locale</label>
          <input name="locale" placeholder="zh-CN" value="${escapeHtml(profile?.locale || '')}" />
        </div>
        <div>
          <label class="field-label">Timezone</label>
          <input name="timezone_id" placeholder="Asia/Shanghai" value="${escapeHtml(profile?.timezone_id || '')}" />
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
  const profileEnvUI = createEnvEditor(dialog.querySelector('#profile-env-editor'));
  profileEnvUI.setRows(profileEnv);
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
    const body = {
      name: fd.get('name'),
      user_data_dir: fd.get('user_data_dir'),
      proxy: fd.get('proxy'),
      runtime_stack: fd.get('runtime_stack'),
      locale: fd.get('locale'),
      timezone_id: fd.get('timezone_id'),
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
    loadTelegramSettings(),
    loadProfiles(),
    loadGlobalEnvSettings(),
  ]);
  await loadTasks();
}

async function runTask(id) {
  try {
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
  try {
    await fetchJson(`/api/tasks/${id}/stop`, { method: 'POST' });
    toast(`停止指令已发送至任务 #${id}`, 'success');
  } catch (error) {
    toast(error.message || '停止失败', 'error');
  } finally {
    runningTaskIds.delete(id);
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
  updateScheduleModeUI();
  // use_persistent=1 → 持久；否则默认临时（含历史任务字段缺失）
  setTaskProfileMode(Number(task.use_persistent) ? 'persistent' : 'temp');
  if (taskProfileSelect) {
    renderProfileOptions(taskProfileSelect, task.browser_profile_id || '');
  }
  if (form.elements.browser_profile_id) form.elements.browser_profile_id.value = task.browser_profile_id || '';
  let proxyValue = '';
  if (Array.isArray(task.env) && task.env.length) {
    proxyValue = extractProxyFromEnvList(task.env);
    // 表格里不再重复展示 BROWSER_PROXY（有专用输入框）
    const envWithoutProxy = task.env.filter((e) => String(e?.name || '').toUpperCase() !== 'BROWSER_PROXY');
    syncTaskParamsUI(task.script_path, envWithoutProxy);
  } else {
    const params = task.params || parseParamsJson(task.params_json);
    proxyValue = extractProxyFromParams(params);
    const paramsWithoutProxy = { ...params };
    delete paramsWithoutProxy.BROWSER_PROXY;
    delete paramsWithoutProxy.browser_proxy;
    syncTaskParamsUI(task.script_path, paramsWithoutProxy);
  }
  setTaskProxyInput(proxyValue);
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
  syncTaskParamsUI(scriptPath, collectSafeCurrentParams());
  renderScripts();
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
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());
  Object.assign(payload, schedule);
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
  // 临时/持久只走 use_persistent 字段，不再写入可见 env 列表
  const envByName = new Map(env.map((e) => [e.name, e]));
  envByName.delete('USE_TEMP_PROFILE');
  envByName.delete('use_temp_profile');

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

  // 任务代理单独输入框 → BROWSER_PROXY（业务需要，保留在 env）
  const taskProxy = getTaskProxyFromForm();
  if (taskProxy) {
    envByName.set('BROWSER_PROXY', {
      name: 'BROWSER_PROXY',
      value: taskProxy,
      is_secret: 0,
    });
  } else {
    envByName.delete('BROWSER_PROXY');
  }

  payload.env = [...envByName.values()].filter((e) => {
    const n = String(e.name || '').toUpperCase();
    return n !== 'USE_TEMP_PROFILE';
  });
  payload.params = {
    ...params,
    USE_GLOBAL_TELEGRAM: useGlobalTg ? '1' : '0',
  };
  delete payload.params.USE_TEMP_PROFILE;
  delete payload.params.use_temp_profile;
  if (taskProxy) payload.params.BROWSER_PROXY = taskProxy;
  else delete payload.params.BROWSER_PROXY;
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
    syncTaskParamsUI(result.data.path, collectSafeCurrentParams());
    if (!form.name.value.trim()) form.name.value = result.data.name.replace(/\.(js|py)$/i, '');
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
scheduleModeSelect.addEventListener('change', updateScheduleModeUI);
fixedDaysEl.addEventListener('input', updateFixedSummary);
fixedHoursEl.addEventListener('input', updateFixedSummary);
fixedMinutesEl.addEventListener('input', updateFixedSummary);
intervalMinEl.addEventListener('input', updateIntervalSummary);
intervalMaxEl.addEventListener('input', updateIntervalSummary);
intervalUnitEl.addEventListener('change', updateIntervalSummary);

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

    tgSaveBtn.disabled = true;
    tgSaveBtn.textContent = '保存中...';

    try {
      await fetchJson('/api/settings/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken, chatId, proxy }),
      });
      toast('Telegram \u8bbe\u7f6e\u5df2\u6210\u529f\u4fdd\u5b58', 'success');
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
  taskProfileModeSelect.addEventListener('change', () => updateTaskProfileModeUI());
  updateTaskProfileModeUI();
}
if (taskProfileSelect) {
  taskProfileSelect.addEventListener('change', () => {
    if (form.elements.browser_profile_id) {
      form.elements.browser_profile_id.value = taskProfileSelect.value || '';
    }
    updateTaskProfileModeUI();
  });
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
      taskEnvUI.importText(paramJsonRaw?.value || '');
      toast('已应用到表格', 'success');
    } catch (error) {
      toast(error.message || '导入失败', 'error');
    }
  });
}
if (taskEnvExportRawBtn) {
  taskEnvExportRawBtn.addEventListener('click', () => {
    try {
      if (paramJsonRaw) paramJsonRaw.value = taskEnvUI.exportText();
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
    for (const ent of entries) {
      const row = document.createElement('div');
      row.className = `files-row ${ent.type === 'dir' ? 'is-dir' : ''}`;
      const icon = ent.type === 'dir' ? 'folder' : 'file-code';
      row.innerHTML = `
        <i data-lucide="${icon}" class="icon-sm" style="opacity:.85"></i>
        <div class="files-name" title="${escapeHtml(ent.name)}">${escapeHtml(ent.name)}</div>
        <div class="files-meta">${ent.type === 'dir' ? '文件夹' : formatBytes(ent.size)}</div>
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
  if (uploadBtn && uploadInput) {
    uploadBtn.addEventListener('click', () => uploadInput.click());
    uploadInput.addEventListener('change', async () => {
      const files = [...(uploadInput.files || [])];
      uploadInput.value = '';
      if (!files.length) return;
      for (const file of files) {
        try {
          const buf = await file.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let binary = '';
          const chunk = 0x8000;
          for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
          }
          const b64 = btoa(binary);
          await fetchJson('/api/tasks-fs/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              parent: fsCurrentPath,
              name: file.name,
              encoding: 'base64',
              content: b64,
            }),
          });
          toast(`已上传 ${file.name}`, 'success');
        } catch (err) {
          toast(`${file.name}: ${err.message || '上传失败'}`, 'error');
        }
      }
      await loadTasksFs(fsCurrentPath);
      await loadScripts();
    });
  }

  // 进入全局配置时加载
  const configTabBtn = document.getElementById('tab-config');
  if (configTabBtn) {
    configTabBtn.addEventListener('click', () => {
      loadTasksFs(fsCurrentPath);
    });
  }
}

wireTasksFsUi();

resetAllModalState();
closeModal();
refreshAll();
loadBrowserRuntimeSettings();
loadVisionSettings();
loadGlobalEnvSettings();
loadTasksFs('');
