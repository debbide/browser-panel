const fs = require('fs');
const path = require('path');
const config = require('../../../config');

function ensureReplayDir() {
  const dir = path.join(config.paths.root, 'runtime-data', 'replay');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createStepTrace(task) {
  const startedAt = new Date().toISOString();
  return {
    task_id: task.id,
    task_name: task.name,
    execution_mode: 'modular',
    started_at: startedAt,
    ended_at: null,
    status: 'running',
    steps: [],
  };
}

function addTraceStep(trace, step) {
  if (!trace || !Array.isArray(trace.steps)) return;
  trace.steps.push({
    ...step,
    timestamp: step?.timestamp || new Date().toISOString(),
  });
}

function finalizeStepTrace(trace, status) {
  if (!trace) return trace;
  trace.ended_at = new Date().toISOString();
  trace.status = status || trace.status || 'unknown';
  return trace;
}

function writeStepTrace(trace, customName = '') {
  const dir = ensureReplayDir();
  const safeName = String(customName || `task-${trace?.task_id || 'unknown'}`).replace(/[^a-zA-Z0-9._-]+/g, '-');
  const fileName = `${safeName}-${Date.now()}.json`;
  const fullPath = path.join(dir, fileName);
  fs.writeFileSync(fullPath, JSON.stringify(trace, null, 2), 'utf8');
  return fullPath;
}

module.exports = {
  createStepTrace,
  addTraceStep,
  finalizeStepTrace,
  writeStepTrace,
};
