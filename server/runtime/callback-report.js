/**
 * Parse TASK_RESULT payload for remaining-time callback and persist on the task.
 *
 * Script protocol (any of these shapes work):
 *   { callback: { remaining_sec, valid_until?, action? } }
 *   { remaining_sec, valid_until?, action? }
 *   { data: { remaining_sec, ... } }
 *
 * Scheduling adoption is controlled by condition type remaining_callback (panel switch).
 * Reports are always stored when remaining_sec is present.
 */

const db = require('../db');
const { conditionFromTask } = require('../conditions');
const remainingCallback = require('../conditions/types/remaining_callback');

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function pickRemainingSec(...candidates) {
  for (const raw of candidates) {
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Extract callback fields from a TASK_RESULT JSON object.
 * @returns {{ remaining_sec: number, valid_until: string|null, action: string|null } | null}
 */
function extractCallbackFromTaskResult(taskResult) {
  const root = asObject(taskResult);
  if (!root) return null;

  const nested = asObject(root.callback) || asObject(root.data) || {};
  const remaining_sec = pickRemainingSec(
    nested.remaining_sec,
    nested.remainingSec,
    nested.remaining,
    root.remaining_sec,
    root.remainingSec,
    root.remaining
  );
  if (remaining_sec === null) return null;

  const valid_until = nested.valid_until || nested.validUntil || root.valid_until || root.validUntil || null;
  const action = nested.action || root.action || null;

  return {
    remaining_sec,
    valid_until: valid_until != null ? String(valid_until) : null,
    action: action != null ? String(action) : null,
  };
}

/**
 * Store report + compute trigger_at when condition is remaining_callback.
 * Safe no-op if payload has no remaining_sec.
 *
 * @returns {object|null} updated task or null
 */
function ingestTaskResultCallback(taskId, taskResult) {
  const extracted = extractCallbackFromTaskResult(taskResult);
  if (!extracted) return null;

  const task = db.getTask(taskId);
  if (!task) return null;

  const reportedAt = new Date();
  const report = {
    remaining_sec: extracted.remaining_sec,
    reported_at: reportedAt.toISOString(),
    valid_until: extracted.valid_until,
    action: extracted.action,
  };

  // Only compute trigger when panel uses remaining_callback (switch on = condition enabled + type)
  const cond = conditionFromTask(task);
  const type = String(cond.type || '').trim();
  const enabled = Boolean(Number(task.condition_enabled));
  if (enabled && type === 'remaining_callback') {
    const cfg = cond.config || {};
    const computed = remainingCallback.computeTriggerFromReport(
      extracted.remaining_sec,
      cfg,
      reportedAt
    );
    report.trigger_at = computed.trigger_at;
    report.threshold_sec = computed.threshold_sec;
  } else {
    // Still store remaining; leave previous trigger or clear if we want pure storage
    // Keep existing trigger fields unless remaining changed a lot — simpler: clear trigger
    // when not adopting, so UI does not show a stale "will fire" time.
    report.trigger_at = null;
    report.threshold_sec = null;
  }

  const updated = db.applyTaskCallbackReport(taskId, report);

  // If adopting remaining_callback, advance condition_next_check toward trigger
  if (updated && enabled && type === 'remaining_callback' && report.trigger_at) {
    const triggerMs = new Date(report.trigger_at).getTime();
    if (Number.isFinite(triggerMs)) {
      const nextCheckMs = Math.max(Date.now() + 30_000, triggerMs - 30_000);
      db.updateTask(taskId, {
        ...updated,
        condition_next_check_at: new Date(nextCheckMs).toISOString(),
      });
      return db.getTask(taskId);
    }
  }

  return updated;
}

module.exports = {
  extractCallbackFromTaskResult,
  ingestTaskResultCallback,
};
