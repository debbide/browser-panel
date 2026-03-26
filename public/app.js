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

let editingId = null;
let tasksCache = [];
let runsCache = [];
let runningTaskIds = new Set();
let scriptsCache = [];
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

function prettyUnit(unit) {
  if (unit === 'minutes') return '分钟';
  if (unit === 'days') return '天';
  return '小时';
}

function shortTime(value) {
  if (!value) return '-';
  return String(value).replace('T', ' ').slice(0, 19);
}

function setActiveTab(name) {
  for (const btn of tabButtons) btn.classList.toggle('active', btn.dataset.tab === name);
  for (const panel of tabPanels) panel.classList.toggle('active', panel.dataset.panel === name);
}

function openModal(mode = 'create') {
  modal.classList.add('open');
  modalMask.hidden = false;
  modalTitle.textContent = mode === 'edit' ? '编辑任务配置' : '新建任务';
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
  return `${parsed.fixedDays} 天 ${parsed.fixedHours} 小时 ${parsed.fixedMinutes} 分钟`;
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
  formTitle.textContent = '创建或编辑任务';
  formHint.textContent = '任务只保留名称；脚本与调度在下方配置。';
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
          <div class="task-subtitle">${escapeHtml(task.script_path || '未绑定脚本')}</div>
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
          <strong>${task.enabled ? (task.schedule_mode === 'interval' ? '随机区间' : '固定周期') : '未启用'}</strong>
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
    </article>`;
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
    </article>`;
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
    </div>`;
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
  scheduleModeSelect.value = schedule.mode;
  fixedDaysEl.value = schedule.fixedDays;
  fixedHoursEl.value = schedule.fixedHours;
  fixedMinutesEl.value = schedule.fixedMinutes;
  intervalMinEl.value = schedule.intervalMin;
  intervalMaxEl.value = schedule.intervalMax;
  intervalUnitEl.value = schedule.intervalUnit;
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
  formHint.textContent = '任务只保留名称；脚本与调度在下方配置。';
  renderScripts();
  openModal('edit');
}

function useScript(scriptPath, type) {
  selectedScriptPath = scriptPath;
  form.script_path.value = scriptPath;
  form.type.value = type;
  if (!form.name.value.trim()) form.name.value = scriptPath.split('/').pop().replace(/\.(js|py)$/i, '');
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
  if (!form.elements.script_path.value) {
    alert('请先选择或导入脚本');
    return;
  }
  const schedule = buildSchedulePayloadFromForm();
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());
  Object.assign(payload, schedule);
  payload.use_browser = formData.get('use_browser') === 'on';
  payload.use_persistent = formData.get('use_persistent') === 'on';
  payload.timeout_sec = Number(payload.timeout_sec || 300);
  const url = editingId ? `/api/tasks/${editingId}` : '/api/tasks';
  const method = editingId ? 'PUT' : 'POST';
  await fetchJson(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
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
  return fetchJson('/api/scripts/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, content }) });
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

resetBtn.addEventListener('click', () => { resetAllModalState(); closeModal(); });
modalCloseBtn.addEventListener('click', closeModal);
modalMask.addEventListener('click', closeModal);
refreshScriptsBtn.addEventListener('click', loadScripts);
refreshScriptsModalBtn.addEventListener('click', loadScripts);
useScriptContentBtn.addEventListener('click', () => {
  const currentName = String(modalImportForm.elements.name.value || '').trim();
  const currentType = String(modalImportForm.elements.type.value || 'javascript');
  if (!currentName) return alert('请先填写脚本名称');
  let target = currentName;
  if (currentType === 'python' && !target.endsWith('.py')) target += '.py';
  if (currentType === 'javascript' && !target.endsWith('.js')) target += '.js';
  useScript(`tasks/${target}`, currentType);
});
cleanupBtn.addEventListener('click', async () => { await fetchJson('/api/runs/cleanup', { method: 'POST' }); await refreshAll(); });
addTaskBtn.addEventListener('click', () => { resetAllModalState(); renderScripts(); openModal('create'); });
addScriptBtn.addEventListener('click', () => setActiveTab('scripts'));
topSettingsBtn.addEventListener('click', () => setActiveTab('settings'));
for (const btn of tabButtons) btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
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
window.showTaskRuns = showTaskRuns;
window.useScript = useScript;
window.loadScriptIntoEditor = loadScriptIntoEditor;

setActiveTab('tasks');
resetAllModalState();
refreshAll();
