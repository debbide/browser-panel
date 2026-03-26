async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Request failed');
  return data;
}

const tasksEl = document.getElementById('tasks');
const runsEl = document.getElementById('runs');
const metaEl = document.getElementById('meta');
const form = document.getElementById('task-form');
const formTitle = document.getElementById('form-title');
const formHint = document.getElementById('form-hint');
const saveBtn = document.getElementById('save-btn');
const resetBtn = document.getElementById('reset-btn');
const cleanupBtn = document.getElementById('cleanup-runs-btn');
let editingId = null;
let tasksCache = [];
let runningTaskIds = new Set();

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
    timeout: 'Timeout',
    permission_error: 'Permission error',
    script_error: 'Script error',
    browser_task_error: 'Browser task error',
    browser_launch_error: 'Browser launch error',
    missing_result: 'Missing result',
    already_running: 'Already running',
  };
  return map[code] || code || '';
}

function runCard(run) {
  return `
    <div class="run ${run.status === 'failed' ? 'run-failed' : 'run-success'}">
      <div><strong>Task #${run.task_id}</strong> | ${escapeHtml(run.status)}</div>
      <div>Started: ${escapeHtml(run.started_at)}</div>
      <div>Ended: ${escapeHtml(run.ended_at || '-')}</div>
      <div>Exit: ${run.exit_code ?? '-'}</div>
      <div>Error type: ${escapeHtml(prettyErrorCode(run.error_code) || '-')}</div>
      <div class="row">
        ${run.log_path ? `<a href="/${run.log_path.replace(/^.*?(logs\/)/, '$1')}" target="_blank">Log</a>` : ''}
        ${run.screenshot_path ? `<a href="/${run.screenshot_path.replace(/^.*?(screenshots\/)/, '$1')}" target="_blank">Screenshot</a>` : ''}
      </div>
      ${run.error_text ? `<pre>${escapeHtml(run.error_text)}</pre>` : ''}
    </div>
  `;
}

async function showTaskRuns(id) {
  const data = await fetchJson(`/api/tasks/${id}/runs`);
  const html = data.data.map(runCard).join('') || '<p>No runs for this task yet.</p>';
  const target = document.getElementById(`task-runs-${id}`);
  if (target) target.innerHTML = html;
}

function taskCard(task) {
  const isRunning = runningTaskIds.has(task.id) || Boolean(task.is_running);
  return `
    <div class="task ${isRunning ? 'task-running' : ''}">
      <div><strong>${escapeHtml(task.name)}</strong> <small>#${task.id}</small> ${isRunning ? '<span class="badge-running">Running</span>' : ''}</div>
      <div>Type: ${escapeHtml(task.type)} | Script: ${escapeHtml(task.script_path)}</div>
      <div>Cron: ${escapeHtml(task.cron_expr || '-')} | Enabled: ${task.enabled ? 'Yes' : 'No'}</div>
      <div>Browser: ${task.use_browser ? 'Yes' : 'No'} | Persistent: ${task.use_persistent ? 'Yes' : 'No'} | Timeout: ${task.timeout_sec}s</div>
      <div class="row">
        <button onclick="runTask(${task.id})" ${isRunning ? 'disabled' : ''}>${isRunning ? 'Running…' : 'Run'}</button>
        <button class="alt" onclick="editTask(${task.id})" ${isRunning ? 'disabled' : ''}>Edit</button>
        <button class="alt" onclick="showTaskRuns(${task.id})">Runs</button>
        <button class="alt" onclick="deleteTask(${task.id})" ${isRunning ? 'disabled' : ''}>Delete</button>
      </div>
      <div id="task-runs-${task.id}" class="task-runs"></div>
    </div>
  `;
}

function resetForm() {
  form.reset();
  editingId = null;
  saveBtn.textContent = 'Save Task';
  formTitle.textContent = 'Create or Edit Task';
  formHint.textContent = 'Use JS or Python tasks on the same shared headed browser profile.';
}

async function loadMeta() {
  const data = await fetchJson('/api/meta');
  const browser = data.data.browser;
  const paths = data.data.paths;
  metaEl.innerHTML = `
    <div class="task">
      <div><strong>Display:</strong> ${escapeHtml(browser.display)}</div>
      <div><strong>Xauthority:</strong> ${escapeHtml(browser.xauthority)}</div>
      <div><strong>User:</strong> ${escapeHtml(browser.user)}</div>
      <div><strong>Profile:</strong> ${escapeHtml(browser.userDataDir)}</div>
      <div><strong>Chrome:</strong> ${escapeHtml(browser.chromePath)}</div>
      <div><strong>Proxy:</strong> ${escapeHtml(browser.proxy)}</div>
      <div><strong>Tasks dir:</strong> ${escapeHtml(paths.tasksDir)}</div>
      <div><strong>Runtime data:</strong> ${escapeHtml(paths.runtimeDataDir)}</div>
    </div>
  `;
}

async function loadTasks() {
  const data = await fetchJson('/api/tasks');
  tasksCache = data.data;
  tasksEl.innerHTML = data.data.map(taskCard).join('') || '<p>No tasks yet.</p>';
}

async function loadRuns() {
  const data = await fetchJson('/api/runs');
  runsEl.innerHTML = data.data.map(runCard).join('') || '<p>No runs yet.</p>';
}

async function runTask(id) {
  try {
    runningTaskIds.add(id);
    await loadTasks();
    await fetchJson(`/api/tasks/${id}/run`, { method: 'POST' });
  } catch (error) {
    alert(error.message || 'Run failed');
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
  saveBtn.textContent = `Update Task #${id}`;
  formTitle.textContent = `Editing Task #${id}`;
  formHint.textContent = `Editing ${task.name} (${task.type})`;
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

resetBtn.addEventListener('click', resetForm);
cleanupBtn.addEventListener('click', async () => {
  await fetchJson('/api/runs/cleanup', { method: 'POST' });
  await loadRuns();
  await loadTasks();
});

window.runTask = runTask;
window.deleteTask = deleteTask;
window.editTask = editTask;
window.showTaskRuns = showTaskRuns;

loadMeta();
loadTasks();
loadRuns();
