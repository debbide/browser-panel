const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('../config');
const db = require('./db');
const { runTask } = require('./task-runner');
const { reloadJobs } = require('./scheduler');

fs.mkdirSync(config.paths.tasksDir, { recursive: true });
fs.mkdirSync(config.paths.publicDir, { recursive: true });

async function executeTask(id) {
  const task = db.getTask(id);
  if (!task) throw new Error('Task not found');

  const run = db.createRun(id, {
    status: 'running',
    started_at: new Date().toISOString(),
    ended_at: null,
    exit_code: null,
    log_path: null,
    screenshot_path: null,
    error_text: null,
  });

  const result = await runTask(task);

  return db.updateRun(run.id, {
    status: result.status,
    ended_at: result.endedAt,
    exit_code: result.exitCode,
    log_path: result.logPath,
    screenshot_path: result.screenshotPath,
    error_text: result.errorText,
  });
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(config.paths.publicDir));
app.use('/logs', express.static(config.paths.logsDir));
app.use('/screenshots', express.static(config.paths.screenshotsDir));

app.get('/api/tasks', (req, res) => {
  res.json({ data: db.listTasks() });
});

app.post('/api/tasks', (req, res) => {
  const payload = req.body || {};
  const task = db.createTask({
    name: String(payload.name || 'Untitled Task'),
    type: payload.type === 'python' ? 'python' : 'javascript',
    script_path: String(payload.script_path || ''),
    cron_expr: String(payload.cron_expr || ''),
    enabled: payload.enabled ? 1 : 0,
    use_browser: payload.use_browser === false ? 0 : 1,
    use_persistent: payload.use_persistent === false ? 0 : 1,
    timeout_sec: Number(payload.timeout_sec || 300),
  });
  reloadJobs(executeTask);
  res.json({ data: task });
});

app.put('/api/tasks/:id', (req, res) => {
  const id = Number(req.params.id);
  const payload = req.body || {};
  const task = db.updateTask(id, {
    name: String(payload.name || 'Untitled Task'),
    type: payload.type === 'python' ? 'python' : 'javascript',
    script_path: String(payload.script_path || ''),
    cron_expr: String(payload.cron_expr || ''),
    enabled: payload.enabled ? 1 : 0,
    use_browser: payload.use_browser === false ? 0 : 1,
    use_persistent: payload.use_persistent === false ? 0 : 1,
    timeout_sec: Number(payload.timeout_sec || 300),
  });
  reloadJobs(executeTask);
  res.json({ data: task });
});

app.delete('/api/tasks/:id', (req, res) => {
  db.deleteTask(Number(req.params.id));
  reloadJobs(executeTask);
  res.json({ ok: true });
});

app.post('/api/tasks/:id/run', async (req, res) => {
  try {
    const run = await executeTask(Number(req.params.id));
    res.json({ data: run });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.get('/api/tasks/:id/runs', (req, res) => {
  res.json({ data: db.listRunsByTask(Number(req.params.id)) });
});

app.get('/api/runs', (req, res) => {
  res.json({ data: db.listRuns(100) });
});

app.post('/api/runs/cleanup', (req, res) => {
  const rows = db.db.prepare('SELECT MAX(id) as id FROM task_runs GROUP BY task_id').all();
  const keep = new Set(rows.map(row => row.id));
  const allRows = db.listRuns(1000);
  for (const row of allRows) {
    if (!keep.has(row.id)) {
      db.db.prepare('DELETE FROM task_runs WHERE id = ?').run(row.id);
    }
  }
  res.json({ ok: true });
});

app.get('/api/meta', (req, res) => {
  res.json({
    data: {
      browser: config.browser,
      paths: {
        tasksDir: config.paths.tasksDir,
        logsDir: config.paths.logsDir,
        screenshotsDir: config.paths.screenshotsDir,
      },
    },
  });
});

app.use((req, res) => {
  res.sendFile(path.join(config.paths.publicDir, 'index.html'));
});

app.listen(config.server.port, config.server.host, () => {
  reloadJobs(executeTask);
  console.log(`Panel running on http://${config.server.host}:${config.server.port}`);
});
