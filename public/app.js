async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Request failed');
  return data;
}

const tasksEl = document.getElementById('tasks');
const runsEl = document.getElementById('runs');
const metaEl = document.getElementById('meta');
const scriptsEl = document.getElementById('scripts');
const form = document.getElementById('task-form');
const importForm = document.getElementById('import-form');
const formTitle = document.getElementById('form-title');
const formHint = document.getElementById('form-hint');
const saveBtn = document.getElementById('save-btn');
const resetBtn = document.getElementById('reset-btn');
const cleanupBtn = document.getElementById('cleanup-runs-btn');
const refreshScriptsBtn = document.getElementById('refresh-scripts-btn');
let editingId = null;
let tasksCache = [];
let runningTaskIds = new Set();
let scriptsCache = [];

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

function runCard(run) {
  return `
    <div class="run ${run.status === 'failed' ? 'run-failed' : 'run-success'}">
      <div><strong>任务 #${run.task_id}</strong> | ${escapeHtml(run.status === 'success' ? '成功' : run.status === 'failed' ? '失败' : run.status)}</div>
      <div>开始时间：${escapeHtml(run.started_at)}</div>
      <div>结束时间：${escapeHtml(run.ended_at || '-')}</div>
      <div>退出码：${run.exit_code ?? '-'}</div>
      <div>错误类型：${escapeHtml(prettyErrorCode(run.error_code) || '-')}</div>
      <div class="row">
        ${run.log_path ? `<a href="/${run.log_path.replace(/^.*?(logs\/)/, '$1')}" target="_blank">日志</a>` : ''}
        ${run.screenshot_path ? `<a href="/${run.screenshot_path.replace(/^.*?(screenshots\/)/, '$1')}" target="_blank">截图</a>` : ''}
      </div>
      ${run.error_text ? `<pre>${escapeHtml(run.error_text)}</pre>` : ''}
    </div>
  `;
}

async function showTaskRuns(id) {
  const data = await fetchJson(`/api/tasks/${id}/runs`);
  const html = data.data.map(runCard).join('') || '<p>这个任务还没有运行记录。</p>';
  const target = document.getElementById(`task-runs-${id}`);
  if (target) target.innerHTML = html;
}

function taskCard(task) {
  const isRunning = runningTaskIds.has(task.id) || Boolean(task.is_running);
  return `
    <div class="task ${isRunning ? 'task-running' : ''}">
      <div><strong>${escapeHtml(task.name)}</strong> <small>#${task.id}</small> ${isRunning ? '<span class="badge-running">运行中</span>' : ''}</div>
      <div>类型：${escapeHtml(task.type)} | 脚本：${escapeHtml(task.script_path)}</div>
      <div>Cron：${escapeHtml(task.cron_expr || '-')} | 已启用：${task.enabled ? '是' : '否'}</div>
      <div>浏览器：${task.use_browser ? '是' : '否'} | 持久化：${task.use_persistent ? '是' : '否'} | 超时：${task.timeout_sec}秒</div>
      <div class="row">
        <button onclick="runTask(${task.id})" ${isRunning ? 'disabled' : ''}>${isRunning ? '运行中…' : '启动'}</button>
        <button class="alt" onclick="stopTask(${task.id})" ${!isRunning ? 'disabled' : ''}>停止</button>
        <button class="alt" onclick="editTask(${task.id})" ${isRunning ? 'disabled' : ''}>编辑</button>
        <button class="alt" onclick="showTaskRuns(${task.id})">运行记录</button>
        <button class="alt" onclick="deleteTask(${task.id})" ${isRunning ? 'disabled' : ''}>删除</button>
      </div>
      <div id="task-runs-${task.id}" class="task-runs"></div>
    </div>
  `;
}

function resetForm() {
  form.reset();
  editingId = null;
  saveBtn.textContent = '保存任务';
  formTitle.textContent = '创建或编辑任务';
  formHint.textContent = '可使用 JS 或 Python 任务，共享同一浏览器持久化配置。';
}

async function loadMeta() {
  const data = await fetchJson('/api/meta');
  const browser = data.data.browser;
  const paths = data.data.paths;
  metaEl.innerHTML = `
    <div class="task">
      <div><strong>显示器:</strong> ${escapeHtml(browser.display)}</div>
      <div><strong>Xauthority:</strong> ${escapeHtml(browser.xauthority)}</div>
      <div><strong>运行用户:</strong> ${escapeHtml(browser.user)}</div>
      <div><strong>持久化配置:</strong> ${escapeHtml(browser.userDataDir)}</div>
      <div><strong>Chrome:</strong> ${escapeHtml(browser.chromePath)}</div>
      <div><strong>代理:</strong> ${escapeHtml(browser.proxy)}</div>
      <div><strong>任务目录:</strong> ${escapeHtml(paths.tasksDir)}</div>
      <div><strong>运行数据目录:</strong> ${escapeHtml(paths.runtimeDataDir)}</div>
    </div>
  `;
}

function scriptCard(script) {
  return `
    <div class="task">
      <div><strong>${escapeHtml(script.name)}</strong></div>
      <div>类型：${escapeHtml(script.type)} | 路径：${escapeHtml(script.path)}</div>
      <div class="row">
        <button class="alt" onclick="useScript('${escapeHtml(script.path)}', '${escapeHtml(script.type)}')">填入表单</button>
      </div>
    </div>
  `;
}

async function loadScripts() {
  const data = await fetchJson('/api/scripts');
  scriptsCache = data.data;
  scriptsEl.innerHTML = data.data.map(scriptCard).join('') || '<p>当前还没有脚本文件。</p>';
}

async function loadTasks() {
  const data = await fetchJson('/api/tasks');
  tasksCache = data.data;
  tasksEl.innerHTML = data.data.map(taskCard).join('') || '<p>当前还没有任务。</p>';
}

async function loadRuns() {
  const data = await fetchJson('/api/runs');
  runsEl.innerHTML = data.data.map(runCard).join('') || '<p>当前还没有运行记录。</p>';
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
    await loadTasks();
    await loadRuns();
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
    await loadTasks();
    await loadRuns();
    await showTaskRuns(id);
  }
}

async function deleteTask(id) {
  await fetchJson(`/api/tasks/${id}`, { method: 'DELETE' });
  if (editingId === id) resetForm();
  await loadTasks();
  await loadRuns();
}

function editTask(id) {
  const task = tasksCache.find(item => item.id === id);
  if (!task) return;
  editingId = id;
  form.name.value = task.name;
  form.type.value = task.type;
  form.script_path.value = task.script_path;
  form.cron_expr.value = task.cron_expr || '';
  form.timeout_sec.value = task.timeout_sec;
  form.enabled.checked = Boolean(task.enabled);
  form.use_browser.checked = Boolean(task.use_browser);
  form.use_persistent.checked = Boolean(task.use_persistent);
  saveBtn.textContent = `保存修改 #${id}`;
  formTitle.textContent = `正在编辑任务 #${id}`;
  formHint.textContent = `正在编辑：${task.name}（${task.type}）`;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function useScript(scriptPath, type) {
  form.script_path.value = scriptPath;
  form.type.value = type;
  if (!form.name.value.trim()) {
    form.name.value = scriptPath.split('/').pop().replace(/\.(js|py)$/i, '');
  }
  formHint.textContent = `已选择脚本：${scriptPath}`;
  window.scrollTo({ top: 0, behavior: 'smooth' });
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
  await loadTasks();
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
  useScript(result.data.path, result.data.type);
  alert(`脚本已导入：${result.data.path}`);
});

resetBtn.addEventListener('click', resetForm);
refreshScriptsBtn.addEventListener('click', loadScripts);
cleanupBtn.addEventListener('click', async () => {
  await fetchJson('/api/runs/cleanup', { method: 'POST' });
  await loadRuns();
  await loadTasks();
});

window.runTask = runTask;
window.stopTask = stopTask;
window.deleteTask = deleteTask;
window.editTask = editTask;
window.showTaskRuns = showTaskRuns;
window.useScript = useScript;

loadMeta();
loadScripts();
loadTasks();
loadRuns();
