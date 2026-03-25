async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Request failed');
  return data;
}

const tasksEl = document.getElementById('tasks');
const runsEl = document.getElementById('runs');
const form = document.getElementById('task-form');

function taskCard(task) {
  return `
    <div class="task">
      <div><strong>${task.name}</strong> <small>#${task.id}</small></div>
      <div>Type: ${task.type} | Script: ${task.script_path}</div>
      <div>Cron: ${task.cron_expr || '-'} | Enabled: ${task.enabled ? 'Yes' : 'No'}</div>
      <div>Browser: ${task.use_browser ? 'Yes' : 'No'} | Persistent: ${task.use_persistent ? 'Yes' : 'No'} | Timeout: ${task.timeout_sec}s</div>
      <div class="row">
        <button onclick="runTask(${task.id})">Run</button>
        <button class="alt" onclick="deleteTask(${task.id})">Delete</button>
      </div>
    </div>
  `;
}

function runCard(run) {
  return `
    <div class="run">
      <div><strong>Task #${run.task_id}</strong> | ${run.status}</div>
      <div>Started: ${run.started_at}</div>
      <div>Ended: ${run.ended_at || '-'}</div>
      <div>Exit: ${run.exit_code ?? '-'}</div>
      <div class="row">
        ${run.log_path ? `<a href="/${run.log_path.replace(/^.*?(logs\/)/, '$1')}" target="_blank">Log</a>` : ''}
        ${run.screenshot_path ? `<a href="/${run.screenshot_path.replace(/^.*?(screenshots\/)/, '$1')}" target="_blank">Screenshot</a>` : ''}
      </div>
      ${run.error_text ? `<pre>${run.error_text}</pre>` : ''}
    </div>
  `;
}

async function loadTasks() {
  const data = await fetchJson('/api/tasks');
  tasksEl.innerHTML = data.data.map(taskCard).join('') || '<p>No tasks yet.</p>';
}

async function loadRuns() {
  const data = await fetchJson('/api/runs');
  runsEl.innerHTML = data.data.map(runCard).join('') || '<p>No runs yet.</p>';
}

async function runTask(id) {
  await fetchJson(`/api/tasks/${id}/run`, { method: 'POST' });
  await loadRuns();
}

async function deleteTask(id) {
  await fetchJson(`/api/tasks/${id}`, { method: 'DELETE' });
  await loadTasks();
  await loadRuns();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());
  payload.enabled = formData.get('enabled') === 'on';
  payload.use_browser = formData.get('use_browser') === 'on';
  payload.use_persistent = formData.get('use_persistent') === 'on';
  payload.timeout_sec = Number(payload.timeout_sec || 300);
  await fetchJson('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  form.reset();
  await loadTasks();
});

window.runTask = runTask;
window.deleteTask = deleteTask;

loadTasks();
loadRuns();
