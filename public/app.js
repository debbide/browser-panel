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
  if (!res.ok) throw new Error(data.message || '请求失败');
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
const closeBrowserBtn = document.getElementById('close-browser-btn');
const scriptSelectEl = document.getElementById('script-select');
const useScriptBtn = document.getElementById('use-script-btn');
const editScriptBtn = document.getElementById('edit-script-btn');

const scheduleModeSelect = document.getElementById('schedule-mode-select');
const fixedFieldsEl = document.getElementById('fixed-schedule-fields');
const intervalFieldsEl = document.getElementById('interval-schedule-fields');
const fixedSummaryEl = document.getElementById('fixed-schedule-summary');
const intervalSummaryEl = document.getElementById('interval-schedule-summary');

const fixedDaysEl = form.elements.fixed_days;
const fixedHoursEl = form.elements.fixed_hours;
const fixedMinutesEl = form.elements.fixed_minutes;
const intervalMinEl = form.elements.interval_min;
const intervalMaxEl = form.elements.interval_max;
const intervalUnitEl = form.elements.interval_unit;

const tgForm = document.getElementById('tg-form');
const tgStatusText = document.getElementById('tg-status-text');
const tgBotToken = document.getElementById('tg-bot-token');
const tgChatId = document.getElementById('tg-chat-id');
const tgTokenHelp = document.getElementById('tg-token-help');
const tgSaveBtn = document.getElementById('tg-save-btn');
const tgTestBtn = document.getElementById('tg-test-btn');

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
    await fetchJson('/api/browser/open', { method: 'POST' });
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
  fixedFieldsEl.setAttribute('aria-hidden', mode === 'fixed' ? 'false' : 'true');
  intervalFieldsEl.setAttribute('aria-hidden', mode === 'interval' ? 'false' : 'true');
  fixedFieldsEl.classList.toggle('active-pane', mode === 'fixed');
  intervalFieldsEl.classList.toggle('active-pane', mode === 'interval');

  if (mode === 'fixed') {
    intervalMinEl.disabled = true;
    intervalMaxEl.disabled = true;
    intervalUnitEl.disabled = true;
    fixedDaysEl.disabled = false;
    fixedHoursEl.disabled = false;
    fixedMinutesEl.disabled = false;
  } else {
    intervalMinEl.disabled = false;
    intervalMaxEl.disabled = false;
    intervalUnitEl.disabled = false;
    fixedDaysEl.disabled = true;
    fixedHoursEl.disabled = true;
    fixedMinutesEl.disabled = true;
  }

  updateFixedSummary();
  updateIntervalSummary();
}

function buildSchedulePayloadFromForm() {
  const enabled = form.elements.enabled.checked;
  if (!enabled) {
    return { enabled: false, cron_expr: '', schedule_mode: 'fixed', interval_min: null, interval_max: null, interval_unit: null, next_run_at: null };
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
    return { enabled: false, mode: 'fixed', fixedDays: 0, fixedHours: 4, fixedMinutes: 0, intervalMin: 5, intervalMax: 10, intervalUnit: 'minutes' };
  }
  if (task.schedule_mode === 'interval') {
    return { enabled: true, mode: 'interval', fixedDays: 0, fixedHours: 4, fixedMinutes: 0, intervalMin: Number(task.interval_min || 5), intervalMax: Number(task.interval_max || 10), intervalUnit: task.interval_unit || 'minutes' };
  }
  let totalMinutes = Number(task.interval_min || task.interval_max || 0);
  if ((task.interval_unit || 'minutes') === 'days') totalMinutes *= 24 * 60;
  else if ((task.interval_unit || 'minutes') === 'hours') totalMinutes *= 60;
  const fixedDays = Math.floor(totalMinutes / (24 * 60));
  totalMinutes -= fixedDays * 24 * 60;
  const fixedHours = Math.floor(totalMinutes / 60);
  totalMinutes -= fixedHours * 60;
  return { enabled: true, mode: 'fixed', fixedDays, fixedHours, fixedMinutes: totalMinutes, intervalMin: 5, intervalMax: 10, intervalUnit: 'minutes' };
}

function describeTaskSchedule(task) {
  if (!task.enabled) return '未启用';
  if (task.schedule_mode === 'interval') return `${task.interval_min} - ${task.interval_max} ${prettyUnit(task.interval_unit)}之间`;
  const parsed = parseTaskSchedule(task);
  return `${parsed.fixedDays}天 ${parsed.fixedHours}小时 ${parsed.fixedMinutes}分`;
}

function describeNextRun(task) {
  if (!task.enabled) return '未启用';
  if (task.next_run_at) return `下次：${shortTime(task.next_run_at)}`;
  return describeTaskSchedule(task);
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
  form.elements.enabled.checked = false;
  scheduleModeSelect.value = 'fixed';
  fixedDaysEl.value = '0';
  fixedHoursEl.value = '4';
  fixedMinutesEl.value = '0';
  intervalMinEl.value = '5';
  intervalMaxEl.value = '10';
  intervalUnitEl.value = 'minutes';
  updateScheduleModeUI();
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

function runCard(run) {
  return `
    <div class="run-card ${run.status === 'failed' ? 'run-failed' : 'run-success'}">
      <div class="run-head">
        <strong>任务 #${run.task_id}</strong>
        <span class="run-status ${run.status}">${escapeHtml(prettyStatus(run.status))}</span>
      </div>
      <div class="run-grid compact">
        <div><span class="label">开始</span><span>${escapeHtml(shortTime(run.started_at))}</span></div>
        <div><span class="label">结束</span><span>${escapeHtml(shortTime(run.ended_at))}</span></div>
        <div><span class="label">退出码</span><span>${run.exit_code ?? '-'}</span></div>
        <div><span class="label">错误类型</span><span>${escapeHtml(prettyErrorCode(run.error_code) || '-')}</span></div>
      </div>
      <div class="row">
        ${run.log_path ? `<a href="/${run.log_path.replace(/^.*?(logs\/)/, '$1')}" target="_blank">查看日志</a>` : ''}
        ${run.screenshot_path ? `<a href="/${run.screenshot_path.replace(/^.*?(screenshots\/)/, '$1')}" target="_blank">查看截图</a>` : ''}
      </div>
      ${run.error_text ? `<pre>${escapeHtml(run.error_text)}</pre>` : ''}
    </div>`;
}

async function showTaskRuns(id) {
  const data = await fetchJson(`/api/tasks/${id}/runs`);
  const target = document.getElementById(`task-runs-${id}`);
  if (!target) return;
  const html = data.data.map(runCard).join('') || '<p class="empty">这个任务还没有运行记录。</p>';
  target.innerHTML = target.innerHTML ? '' : html;
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
  return `
    <article class="task-card ${isRunning ? 'task-running' : ''}" data-testid="task-card" data-task-id="${task.id}">
      <div class="task-card-top">
        <div>
          <div class="task-title-row">
            <h3>${escapeHtml(task.name)}</h3>
            <span class="pill pill-type">${escapeHtml(task.type)}</span>
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
            <span>${task.enabled ? (task.schedule_mode === 'interval' ? '随机区间' : '固定周期') : '未启用'}</span>
          </div>
          <span class="metric-value">${escapeHtml(describeNextRun(task))}</span>
        </div>
      </div>
      <div class="task-actions">
        <button onclick="runTask(${task.id})" ${isRunning ? 'disabled' : ''} data-testid="run-task-btn">${isRunning ? '运行中…' : '启动'}</button>
        <button class="alt" onclick="stopTask(${task.id})" ${!isRunning ? 'disabled' : ''} data-testid="stop-task-btn">停止</button>
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
    const { configured, chatId, botTokenMasked } = res.data;
    
    tgStatusText.textContent = configured ? '状态：已配置' : '状态：未配置';
    tgStatusText.style.color = configured ? '#86efac' : '#94a3b8';
    
    tgChatId.value = chatId || '';
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

async function refreshAll() {
  await Promise.all([loadScripts(), loadRuns(), loadBrowserStatus(), loadTelegramSettings()]);
  await loadTasks();
}

async function runTask(id) {
  try {
    runningTaskIds.add(id);
    await loadTasks();
    await fetchJson(`/api/tasks/${id}/run`, { method: 'POST' });
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
  form.type.value = task.type;
  form.script_path.value = task.script_path;
  form.timeout_sec.value = task.timeout_sec;
  const schedule = parseTaskSchedule(task);
  form.elements.enabled.checked = schedule.enabled;
  scheduleModeSelect.value = schedule.mode;
  fixedDaysEl.value = schedule.fixedDays;
  fixedHoursEl.value = schedule.fixedHours;
  fixedMinutesEl.value = schedule.fixedMinutes;
  intervalMinEl.value = schedule.intervalMin;
  intervalMaxEl.value = schedule.intervalMax;
  intervalUnitEl.value = schedule.intervalUnit;
  updateScheduleModeUI();
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
  form.type.value = type;
  if (!form.name.value.trim()) form.name.value = scriptPath.split('/').pop().replace(/\.(js|py)$/i, '');
  formHint.textContent = `已选脚本：${getScriptLabel(scriptPath)}`;
  renderScripts();
  openModal(editingId ? 'edit' : 'create');
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
  const schedule = buildSchedulePayloadFromForm();
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());
  Object.assign(payload, schedule);
  payload.use_browser = true;
  payload.use_persistent = true;
  payload.timeout_sec = Number(payload.timeout_sec || 300);
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
  const taskName = String(form.elements.name.value || '').trim();
  if (!taskName) throw new Error('请先填写任务名，再导入脚本');
  const baseName = slugifyName(taskName);
  let name = baseName;
  if (type === 'python' && !name.endsWith('.py')) name += '.py';
  if (type === 'javascript' && !name.endsWith('.js')) name += '.js';
  return fetchJson('/api/scripts/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, content }) });
}

modalImportForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (modalImportBtn) {
    modalImportBtn.disabled = true;
    modalImportBtn.textContent = '导入中...';
  }

  try {
    const result = await saveScriptFromForm(modalImportForm);
    selectedScriptPath = result.data.path;
    form.script_path.value = result.data.path;
    form.type.value = result.data.type;
    if (!form.name.value.trim()) form.name.value = result.data.name.replace(/\.(js|py)$/i, '');
    openModal(editingId ? 'edit' : 'create');
    formHint.textContent = `已导入脚本：${getScriptLabel(result.data.path)}`;
    try {
      await loadScripts();
    } catch (error) {
      scriptsCache = [
        ...scriptsCache.filter(item => item.path !== result.data.path),
        { name: result.data.name, path: result.data.path, type: result.data.type },
      ];
    }
    renderScripts();
    toast('脚本已导入，现在可以直接保存任务并运行', 'success');
  } catch (error) {
    toast(error.message || '脚本导入失败', 'error');
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

if (tgForm) {
  tgForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const botToken = tgBotToken.value.trim();
    const chatId = tgChatId.value.trim();
    
    tgSaveBtn.disabled = true;
    tgSaveBtn.textContent = '保存中...';
    
    try {
      await fetchJson('/api/settings/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken, chatId })
      });
      toast('Telegram 设置已成功保存', 'success');
      await loadTelegramSettings();
    } catch (error) {
      toast(error.message || '保存设置遇到了错误', 'error');
    } finally {
      tgSaveBtn.disabled = false;
      tgSaveBtn.textContent = '保存设置';
    }
  });
}

if (tgTestBtn) {
  tgTestBtn.addEventListener('click', async () => {
    tgTestBtn.disabled = true;
    tgTestBtn.textContent = '发送中...';
    
    try {
      await fetchJson('/api/settings/telegram/test', { method: 'POST' });
      toast('一条测试用推送已发往你的 Telegram', 'success');
    } catch (error) {
      toast(error.message || '发送推送到 Telegram 失败', 'error');
    } finally {
      tgTestBtn.disabled = false;
      tgTestBtn.textContent = '发送测试消息';
    }
  });
}

resetAllModalState();
closeModal();
refreshAll();
