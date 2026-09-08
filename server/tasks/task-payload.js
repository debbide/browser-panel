'use strict';

const SUPPORTED_TASK_TYPES = new Set(['javascript', 'python', 'php', 'shell']);
const PURE_REQUEST_TASK_TYPES = new Set(['python', 'php', 'shell']);

function normalizeTaskType(value) {
  const type = String(value || '').trim().toLowerCase();
  return SUPPORTED_TASK_TYPES.has(type) ? type : 'javascript';
}

function isPureRequestTaskType(value) {
  return PURE_REQUEST_TASK_TYPES.has(normalizeTaskType(value));
}

function slugifyScriptName(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function buildTaskScriptFilename(taskName, type) {
  const normalizedType = normalizeTaskType(type);
  const ext = normalizedType === 'python'
    ? '.py'
    : normalizedType === 'php'
      ? '.php'
      : normalizedType === 'shell'
        ? '.sh'
        : '.js';
  const base = slugifyScriptName(taskName) || 'task-script';
  return `${base}${ext}`;
}

function resolveTaskScriptPath(taskName, type, currentScriptPath = '') {
  const normalizedCurrent = String(currentScriptPath || '').replace(/\\/g, '/');
  if (!normalizedCurrent.startsWith('tasks/')) return normalizedCurrent;

  return normalizedCurrent;
}

module.exports = {
  normalizeTaskType,
  isPureRequestTaskType,
  slugifyScriptName,
  buildTaskScriptFilename,
  resolveTaskScriptPath,
};
