async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '请求失败');
  return data;
}

const tasksEl = document.getElementById('tasks');
const runsEl = document.getElementById('runs');
const metaEl = document.getElementById('meta');
const scriptsEl = document.getElementById('scripts');
const form = document.getElementById('task-form');
const importForm = document.getElementById('import-form');
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
const addTaskBtn = document.getElementById('add-task-btn');
const addScriptBtn = document.getElementById('add-script-btn');
const topSettingsBtn = document.getElementById('top-settings-btn');
const tabButtons = Array.from(document.querySelectorAll('.tab-btn'));
const tabPanels = Array.from(document.querySelectorAll('.tab-panel'));

let editingId = null;
let tasksCache = [];
let runsCache = [];
let runningTaskIds = new Set();
let scriptsCache = [];
let activeTab = 'tasks';
let lastRunsByTask = new Map();

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
  modalTitle.textContent = mode === 'edit' ? '编辑任务配置' : '新建任务';
}

function closeModal() {
  modal.classList.remove('open');
  modalMask.hidden = true;
}

function resetForm() {
  form.reset();
  editingId = null;
  saveBtn.textContent = '保存任务';
  formTitle.textContent = '创建或编辑任务';
  formHint.textContent = '可使用 JS 或 Python 任务，共享同一浏览器持久化配置。';
  modalTitle.textContent = '新建任务';
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
          <span class="metric-label">调度</span>
          <strong>${task.enabled ? '已启用' : '未启用'}</strong>
          <span class="metric-value">${escapeHtml(task.cron_expr || '手动触发')}</span>
        </div>
        <div class="metric-card">
          <span class="metric-label">浏览器</span>
          <strong>${task.use_browser ? '启用' : '关闭'}</strong>
          <span class="metric-value">持久化：${task.use_persistent ? '是' : '否'} / 超时：${task.timeout_sec}秒</span>
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
  return `
    <article class="script-card">
      <div class="task-title-row">
        <h3>${escapeHtml(script.name)}</h3>
        <span class="pill pill-type">${escapeHtml(script.type)}</span>
      </div>
      <div class="task-subtitle">${escapeHtml(script.path)}</div>
      <div class="task-actions">
        <button class="alt" onclick="useScript('${escapeHtml(script.path)}', '${escapeHtml(script.type)}')">填入任务配置</button>
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

async function loadScripts() {
  const data = await fetchJson('/api/scripts');
  scriptsCache = data.data;
  scriptsEl.innerHTML = data.data.map(scriptCard).join('') || '<p class="empty">当前还没有脚本文件。</p>';
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
    resetForm();
    closeModal();
  }
  await refreshAll();
}

function fillTaskForm(task) {
  form.name.value = task.name;
  form.type.value = task.type;
  form.script_path.value = task.script_path;
  form.cron_expr.value = task.cron_expr || '';
  form.timeout_sec.value = task.timeout_sec;
  form.enabled.checked = Boolean(task.enabled);
  form.use_browser.checked = Boolean(task.use_browser);
  form.use_persistent.checked = Boolean(task.use_persistent);
}

function editTask(id) {
  const task = tasksCache.find(item => item.id === id);
  if (!task) return;
  editingId = id;
  fillTaskForm(task);
  saveBtn.textContent = `保存修改 #${id}`;
  formTitle.textContent = `正在编辑任务 #${id}`;
  formHint.textContent = `正在编辑：${task.name}（${task.type}）`;
  openModal('edit');
}

function useScript(scriptPath, type) {
  form.script_path.value = scriptPath;
  form.type.value = type;
  if (!form.name.value.trim()) {
    form.name.value = scriptPath.split('/').pop().replace(/\.(js|py)$/i, '');
  }
  formHint.textContent = `已选择脚本：${scriptPath}`;
  openModal(editingId ? 'edit' : 'create');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());
  payload.enabled = formData.get('enabled') === 'on';
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
  resetForm();
  closeModal();
  await refreshAll();
});

importForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(importForm);
  let name = String(formData.get('name') || '').trim();
  const type = String(formData.get('type') || 'javascript');
  const content = String(formData.get('content') || '');
  if (type === 'python' && !name.endsWith('.py')) name += '.py';
  if (type === 'javascript' && !name.endsWith('.js')) name += '.js';
  const result = await fetchJson('/api/scripts/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, content }),
  });
  importForm.reset();
  await loadScripts();
  setActiveTab('scripts');
  useScript(result.data.path, result.data.type);
  alert(`脚本已导入：${result.data.path}`);
});

resetBtn.addEventListener('click', () => {
  resetForm();
  closeModal();
});

modalCloseBtn.addEventListener('click', closeModal);
modalMask.addEventListener('click', closeModal);
refreshScriptsBtn.addEventListener('click', loadScripts);
cleanupBtn.addEventListener('click', async () => {
  await fetchJson('/api/runs/cleanup', { method: 'POST' });
  await refreshAll();
});
addTaskBtn.addEventListener('click', () => {
  resetForm();
  openModal('create');
});
addScriptBtn.addEventListener('click', () => setActiveTab('scripts'));
topSettingsBtn.addEventListener('click', () => setActiveTab('settings'));

for (const btn of tabButtons) {
  btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
}

window.runTask = runTask;
window.stopTask = stopTask;
window.deleteTask = deleteTask;
window.editTask = editTask;
window.showTaskRuns = showTaskRuns;
window.useScript = useScript;

setActiveTab('tasks');
refreshAll();
