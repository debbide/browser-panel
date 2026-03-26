async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '请求失败');
  return data;
}

const tasksEl = document.getElementById('tasks');
const runsEl = document.getElementById('runs');
const metaEl = document.getElementById('meta');
const scriptsPageEl = document.getElementById('scripts-page');
const scriptsModalEl = document.getElementById('scripts-modal');
const form = document.getElementById('task-form');
const pageImportForm = document.getElementById('page-import-form');
const modalImportForm = document.getElementById('modal-import-form');
const modal = document.getElementById('task-modal');
const modalMask = document.getElementById('modal-mask');
const modalTitle = document.getElementById('modal-title');
const modalCloseBtn = document.getElementById('modal-close-btn');
const formTitle = document.getElementById('form-title');
const formHint = document.getElementById('form-hint');
const saveBtn = document.getElementById('save-btn');
const resetBtn = document.getElementById('reset-btn');
const cleanupBtn = document.getElementById('cleanup-runs-btn');
const refreshScriptsBtn = document.getElementById('refresh-scripts-btn');
const refreshScriptsModalBtn = document.getElementById('refresh-scripts-modal-btn');
const useScriptContentBtn = document.getElementById('use-script-content-btn');
const addTaskBtn = document.getElementById('add-task-btn');
const addScriptBtn = document.getElementById('add-script-btn');
const topSettingsBtn = document.getElementById('top-settings-btn');
const tabButtons = Array.from(document.querySelectorAll('.tab-btn'));
const tabPanels = Array.from(document.querySelectorAll('.tab-panel'));
const scheduleModeInputs = Array.from(document.querySelectorAll('input[name="schedule_mode"]'));
const fixedFieldsEl = document.getElementById('fixed-schedule-fields');
const intervalFieldsEl = document.getElementById('interval-schedule-fields');
const fixedKindEl = form.elements.fixed_kind;
const fixedWeekdayEl = form.elements.fixed_weekday;
const fixedTimeEl = form.elements.fixed_time;
const intervalMinEl = form.elements.interval_min;
const intervalMaxEl = form.elements.interval_max;
const intervalUnitEl = form.elements.interval_unit;

let editingId = null;
let tasksCache = [];
let runsCache = [];
let runningTaskIds = new Set();
let scriptsCache = [];
let activeTab = 'tasks';
let lastRunsByTask = new Map();
let selectedScriptPath = '';

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
  };
  return map[code] || code || '';
}

function prettyStatus(status) {
  if (status === 'success') return '成功';
  if (status === 'failed') return '失败';
  if (status === 'running') return '运行中';
  return status || '-';
}

function shortTime(value) {
  if (!value) return '-';
  return String(value).replace('T', ' ').slice(0, 19);
}

function getScheduleMode() {
  return form.elements.schedule_mode.value || 'fixed';
}

function updateScheduleModeUI() {
  const mode = getScheduleMode();
  fixedFieldsEl.hidden = mode !== 'fixed';
  intervalFieldsEl.hidden = mode !== 'interval';
  for (const label of document.querySelectorAll('.timer-mode-card')) {
    const input = label.querySelector('input');
    label.classList.toggle('active-mode', input.checked);
  }
  fixedWeekdayEl.disabled = fixedKindEl.value !== 'weekly';
}

function buildSchedulePayloadFromForm() {
  const enabled = form.elements.enabled.checked;
  const mode = getScheduleMode();
  if (!enabled) {
    return {
      enabled: false,
      cron_expr: '',
      schedule_mode: 'fixed',
      interval_min: null,
      interval_max: null,
      interval_unit: null,
      next_run_at: null,
    };
  }

  if (mode === 'interval') {
    const min = Math.max(1, Number(intervalMinEl.value || 1));
    const max = Math.max(min, Number(intervalMaxEl.value || min));
    return {
      enabled: true,
      cron_expr: '',
      schedule_mode: 'interval',
      interval_min: min,
      interval_max: max,
      interval_unit: intervalUnitEl.value || 'hours',
      next_run_at: null,
    };
  }

  const fixedTime = fixedTimeEl.value || '09:00';
  const [hourRaw, minuteRaw] = fixedTime.split(':');
  const hour = Number(hourRaw || 0);
  const minute = Number(minuteRaw || 0);
  const cronExpr = fixedKindEl.value === 'weekly'
    ? `${minute} ${hour} * * ${fixedWeekdayEl.value}`
    : `${minute} ${hour} * * *`;

  return {
    enabled: true,
    cron_expr: cronExpr,
    schedule_mode: 'fixed',
    interval_min: null,
    interval_max: null,
    interval_unit: null,
    next_run_at: null,
  };
}

function parseTaskSchedule(task) {
  if (!task || !task.enabled) {
    return {
      enabled: false,
      mode: 'fixed',
      fixedKind: 'daily',
      fixedWeekday: '1',
      fixedTime: '09:00',
      intervalMin: '10',
      intervalMax: '12',
      intervalUnit: 'days',
    };
  }

  if (task.schedule_mode === 'interval') {
    return {
      enabled: true,
      mode: 'interval',
      fixedKind: 'daily',
      fixedWeekday: '1',
      fixedTime: '09:00',
      intervalMin: String(task.interval_min || 10),
      intervalMax: String(task.interval_max || 12),
      intervalUnit: task.interval_unit || 'days',
    };
  }

  const cronExpr = task.cron_expr || '';
  const fixedMatch = cronExpr.match(/^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6])$/);
  if (fixedMatch) {
    const minute = String(fixedMatch[1]).padStart(2, '0');
    const hour = String(fixedMatch[2]).padStart(2, '0');
    const day = fixedMatch[3];
    return {
      enabled: true,
      mode: 'fixed',
      fixedKind: day === '*' ? 'daily' : 'weekly',
      fixedWeekday: day === '*' ? '1' : day,
      fixedTime: `${hour}:${minute}`,
      intervalMin: '10',
      intervalMax: '12',
      intervalUnit: 'days',
    };
  }

  return {
    enabled: true,
    mode: 'fixed',
    fixedKind: 'daily',
    fixedWeekday: '1',
    fixedTime: '09:00',
    intervalMin: '10',
    intervalMax: '12',
    intervalUnit: 'days',
  };
}

function describeTaskSchedule(task) {
  if (!task.enabled) return '未启用';
  if (task.schedule_mode === 'interval') {
    return `${task.interval_min} - ${task.interval_max} ${task.interval_unit === 'days' ? '天' : '小时'}之间`;
  }
  const schedule = parseTaskSchedule(task);
  if (schedule.fixedKind === 'weekly') {
    const weekdayMap = { 0: '周日', 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六' };
    return `${weekdayMap[schedule.fixedWeekday] || '每周'} ${schedule.fixedTime}`;
  }
  return `每天 ${schedule.fixedTime}`;
}

function describeNextRun(task) {
  if (!task.enabled) return '未启用';
  if (task.schedule_mode === 'interval') {
    return task.next_run_at ? `下次：${shortTime(task.next_run_at)}` : '等待生成下次时间';
  }
  return describeTaskSchedule(task);
}

function setActiveTab(name) {
  activeTab = name;
  for (const btn of tabButtons) {
    btn.classList.toggle('active', btn.dataset.tab === name);
  }
  for (const panel of tabPanels) {
    panel.classList.toggle('active', panel.dataset.panel === name);
  }
}

function openModal(mode = 'create') {
  modal.classList.add('open');
  modalMask.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
  modalTitle.textContent = mode === 'edit' ? '编辑任务配置' : '新建任务';
}

function closeModal() {
  modal.classList.remove('open');
  modalMask.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
}

function resetTaskForm() {
  form.reset();
  editingId = null;
  selectedScriptPath = '';
  saveBtn.textContent = '保存任务';
  formTitle.textContent = '创建或编辑任务';
  formHint.textContent = '可使用 JS 或 Python 任务，共享同一浏览器持久化配置。';
  modalTitle.textContent = '新建任务';
  form.elements.enabled.checked = false;
  form.elements.schedule_mode.value = 'fixed';
  fixedKindEl.value = 'daily';
  fixedWeekdayEl.value = '1';
  fixedTimeEl.value = '09:00';
  intervalMinEl.value = '10';
  intervalMaxEl.value = '12';
  intervalUnitEl.value = 'days';
  form.elements.cron_expr.value = '';
  updateScheduleModeUI();
}

function resetScriptEditor() {
  modalImportForm.reset();
}

function resetAllModalState() {
  resetTaskForm();
  resetScriptEditor();
}

function groupLastRuns(runs) {
  lastRunsByTask = new Map();
  for (const run of runs) {
    if (!lastRunsByTask.has(run.task_id)) {
      lastRunsByTask.set(run.task_id, run);
    }
  }
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
    </div>
  `;
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
  if (!run) {
    return {
      status: '未运行',
      detail: '还没有运行记录',
      className: 'idle',
    };
  }
  return {
    status: prettyStatus(run.status),
    detail: run.error_code ? prettyErrorCode(run.error_code) : `最近运行：${shortTime(run.started_at)}`,
    className: run.status === 'success' ? 'success' : run.status === 'failed' ? 'failed' : 'idle',
  };
}

function taskCard(task) {
  const isRunning = runningTaskIds.has(task.id) || Boolean(task.is_running);
  const latest = latestRunSummary(task.id);
  return `
    <article class="task-card ${isRunning ? 'task-running' : ''}">
      <div class="task-card-top">
        <div>
          <div class="task-title-row">
            <h3>${escapeHtml(task.name)}</h3>
            <span class="pill pill-id">#${task.id}</span>
            <span class="pill pill-type">${escapeHtml(task.type)}</span>
            ${isRunning ? '<span class="pill pill-running">运行中</span>' : ''}
          </div>
          <div class="task-subtitle">${escapeHtml(task.script_path)}</div>
        </div>
        <button class="icon-btn" onclick="editTask(${task.id})" ${isRunning ? 'disabled' : ''}>编辑</button>
      </div>

      <div class="task-metrics">
        <div class="metric-card ${latest.className}">
          <span class="metric-label">最新结果</span>
          <strong>${escapeHtml(latest.status)}</strong>
          <span class="metric-value">${escapeHtml(latest.detail)}</span>
        </div>
        <div class="metric-card">
          <span class="metric-label">调度模式</span>
          <strong>${task.enabled ? (task.schedule_mode === 'interval' ? '区间随机' : '固定时间') : '未启用'}</strong>
          <span class="metric-value">${escapeHtml(describeTaskSchedule(task))}</span>
        </div>
        <div class="metric-card">
          <span class="metric-label">下次执行 / 浏览器</span>
          <strong>${escapeHtml(describeNextRun(task))}</strong>
          <span class="metric-value">浏览器：${task.use_browser ? '启用' : '关闭'} / 持久化：${task.use_persistent ? '是' : '否'} / 超时：${task.timeout_sec}秒</span>
        </div>
      </div>

      <div class="task-actions">
        <button onclick="runTask(${task.id})" ${isRunning ? 'disabled' : ''}>${isRunning ? '运行中…' : '启动'}</button>
        <button class="alt" onclick="stopTask(${task.id})" ${!isRunning ? 'disabled' : ''}>停止</button>
        <button class="alt" onclick="showTaskRuns(${task.id})">运行记录</button>
        <button class="alt danger" onclick="deleteTask(${task.id})" ${isRunning ? 'disabled' : ''}>删除</button>
      </div>

      <div id="task-runs-${task.id}" class="task-runs-inline"></div>
    </article>
  `;
}

function scriptCard(script) {
  const selected = selectedScriptPath === script.path;
  return `
    <article class="script-card ${selected ? 'selected-script' : ''}">
      <div class="task-title-row">
        <h3>${escapeHtml(script.name)}</h3>
        <span class="pill pill-type">${escapeHtml(script.type)}</span>
      </div>
      <div class="task-subtitle">${escapeHtml(script.path)}</div>
      <div class="task-actions">
        <button class="alt" onclick="useScript('${escapeHtml(script.path)}', '${escapeHtml(script.type)}')">填入任务配置</button>
        <button class="alt" onclick="loadScriptIntoEditor('${escapeHtml(script.path)}')">加载到编辑器</button>
      </div>
    </article>
  `;
}

async function loadMeta() {
  const data = await fetchJson('/api/meta');
  const browser = data.data.browser;
  const paths = data.data.paths;
  metaEl.innerHTML = `
    <div class="settings-grid">
      <div class="metric-card"><span class="metric-label">显示器</span><strong>${escapeHtml(browser.display)}</strong></div>
      <div class="metric-card"><span class="metric-label">运行用户</span><strong>${escapeHtml(browser.user)}</strong></div>
      <div class="metric-card"><span class="metric-label">持久化配置</span><strong>${escapeHtml(browser.userDataDir)}</strong></div>
      <div class="metric-card"><span class="metric-label">Chrome</span><strong>${escapeHtml(browser.chromePath)}</strong></div>
      <div class="metric-card"><span class="metric-label">代理</span><strong>${escapeHtml(browser.proxy)}</strong></div>
      <div class="metric-card"><span class="metric-label">任务目录</span><strong>${escapeHtml(paths.tasksDir)}</strong></div>
      <div class="metric-card full"><span class="metric-label">运行数据目录</span><strong>${escapeHtml(paths.runtimeDataDir)}</strong></div>
    </div>
  `;
}

function renderScripts() {
  const html = scriptsCache.map(scriptCard).join('') || '<p class="empty">当前还没有脚本文件。</p>';
  scriptsPageEl.innerHTML = html;
  scriptsModalEl.innerHTML = html;
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
  runsEl.innerHTML = runsCache.map(runCard).join('') || '<p class="empty">当前还没有运行记录。</p>';
}

async function refreshAll() {
  await Promise.all([loadMeta(), loadScripts(), loadRuns()]);
  await loadTasks();
}

async function runTask(id) {
  try {
    runningTaskIds.add(id);
    await loadTasks();
    await fetchJson(`/api/tasks/${id}/run`, { method: 'POST' });
  } catch (error) {
    alert(error.message || '启动失败');
  } finally {
    runningTaskIds.delete(id);
    await refreshAll();
    await showTaskRuns(id);
  }
}

async function stopTask(id) {
  try {
    await fetchJson(`/api/tasks/${id}/stop`, { method: 'POST' });
  } catch (error) {
    alert(error.message || '停止失败');
  } finally {
    runningTaskIds.delete(id);
    await refreshAll();
    await showTaskRuns(id);
  }
}

async function deleteTask(id) {
  if (!confirm('确定要删除这个任务吗？')) return;
  await fetchJson(`/api/tasks/${id}`, { method: 'DELETE' });
  if (editingId === id) {
    resetAllModalState();
    closeModal();
  }
  await refreshAll();
}

function fillTaskForm(task) {
  form.name.value = task.name;
  form.type.value = task.type;
  form.script_path.value = task.script_path;
  form.timeout_sec.value = task.timeout_sec;
  form.use_browser.checked = Boolean(task.use_browser);
  form.use_persistent.checked = Boolean(task.use_persistent);

  const schedule = parseTaskSchedule(task);
  form.elements.enabled.checked = schedule.enabled;
  form.elements.schedule_mode.value = schedule.mode;
  fixedKindEl.value = schedule.fixedKind;
  fixedWeekdayEl.value = schedule.fixedWeekday;
  fixedTimeEl.value = schedule.fixedTime;
  intervalMinEl.value = schedule.intervalMin;
  intervalMaxEl.value = schedule.intervalMax;
  intervalUnitEl.value = schedule.intervalUnit;
  form.elements.cron_expr.value = task.cron_expr || '';
  updateScheduleModeUI();
}

function editTask(id) {
  const task = tasksCache.find(item => item.id === id);
  if (!task) return;
  editingId = id;
  fillTaskForm(task);
  selectedScriptPath = task.script_path;
  saveBtn.textContent = `保存修改 #${id}`;
  formTitle.textContent = `正在编辑任务 #${id}`;
  formHint.textContent = `正在编辑：${task.name}（${task.type}）`;
  renderScripts();
  openModal('edit');
}

function useScript(scriptPath, type) {
  selectedScriptPath = scriptPath;
  form.script_path.value = scriptPath;
  form.type.value = type;
  if (!form.name.value.trim()) {
    form.name.value = scriptPath.split('/').pop().replace(/\.(js|py)$/i, '');
  }
  formHint.textContent = `已选择脚本：${scriptPath}`;
  renderScripts();
  openModal(editingId ? 'edit' : 'create');
}

async function loadScriptIntoEditor(scriptPath) {
  const script = scriptsCache.find(item => item.path === scriptPath);
  if (!script) return;
  const response = await fetch(scriptPath);
  const content = await response.text();
  selectedScriptPath = scriptPath;
  modalImportForm.elements.name.value = script.name;
  modalImportForm.elements.type.value = script.type;
  modalImportForm.elements.content.value = content;
  formHint.textContent = `已加载脚本到编辑器：${scriptPath}`;
  renderScripts();
  openModal(editingId ? 'edit' : 'create');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const schedule = buildSchedulePayloadFromForm();
  form.elements.cron_expr.value = schedule.cron_expr;
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());
  payload.enabled = schedule.enabled;
  payload.cron_expr = schedule.cron_expr;
  payload.schedule_mode = schedule.schedule_mode;
  payload.interval_min = schedule.interval_min;
  payload.interval_max = schedule.interval_max;
  payload.interval_unit = schedule.interval_unit;
  payload.next_run_at = schedule.next_run_at;
  payload.use_browser = formData.get('use_browser') === 'on';
  payload.use_persistent = formData.get('use_persistent') === 'on';
  payload.timeout_sec = Number(payload.timeout_sec || 300);

  const url = editingId ? `/api/tasks/${editingId}` : '/api/tasks';
  const method = editingId ? 'PUT' : 'POST';
  await fetchJson(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  resetAllModalState();
  closeModal();
  await refreshAll();
});

async function saveScriptFromForm(sourceForm) {
  const formData = new FormData(sourceForm);
  let name = String(formData.get('name') || '').trim();
  const type = String(formData.get('type') || 'javascript');
  const content = String(formData.get('content') || '');
  if (!name) throw new Error('脚本名称不能为空');
  if (type === 'python' && !name.endsWith('.py')) name += '.py';
  if (type === 'javascript' && !name.endsWith('.js')) name += '.js';
  return fetchJson('/api/scripts/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, content }),
  });
}

pageImportForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await saveScriptFromForm(pageImportForm);
  pageImportForm.reset();
  await loadScripts();
  alert(`脚本已导入：${result.data.path}`);
});

modalImportForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await saveScriptFromForm(modalImportForm);
  selectedScriptPath = result.data.path;
  await loadScripts();
  useScript(result.data.path, result.data.type);
  alert(`脚本已导入：${result.data.path}`);
});

resetBtn.addEventListener('click', () => {
  resetAllModalState();
  closeModal();
});

modalCloseBtn.addEventListener('click', closeModal);
modalMask.addEventListener('click', closeModal);
refreshScriptsBtn.addEventListener('click', loadScripts);
refreshScriptsModalBtn.addEventListener('click', loadScripts);
useScriptContentBtn.addEventListener('click', () => {
  const currentName = String(modalImportForm.elements.name.value || '').trim();
  const currentType = String(modalImportForm.elements.type.value || 'javascript');
  if (!currentName) {
    alert('请先填写脚本名称');
    return;
  }
  let target = currentName;
  if (currentType === 'python' && !target.endsWith('.py')) target += '.py';
  if (currentType === 'javascript' && !target.endsWith('.js')) target += '.js';
  useScript(`tasks/${target}`, currentType);
});
cleanupBtn.addEventListener('click', async () => {
  await fetchJson('/api/runs/cleanup', { method: 'POST' });
  await refreshAll();
});
addTaskBtn.addEventListener('click', () => {
  resetAllModalState();
  renderScripts();
  openModal('create');
});
addScriptBtn.addEventListener('click', () => setActiveTab('scripts'));
topSettingsBtn.addEventListener('click', () => setActiveTab('settings'));

for (const btn of tabButtons) {
  btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
}

for (const input of scheduleModeInputs) {
  input.addEventListener('change', updateScheduleModeUI);
}
fixedKindEl.addEventListener('change', updateScheduleModeUI);

window.runTask = runTask;
window.stopTask = stopTask;
window.deleteTask = deleteTask;
window.editTask = editTask;
window.showTaskRuns = showTaskRuns;
window.useScript = useScript;
window.loadScriptIntoEditor = loadScriptIntoEditor;

setActiveTab('tasks');
resetAllModalState();
refreshAll();
