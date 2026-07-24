/**
 * remaining_callback — trigger when script-reported remaining time enters the renew window.
 *
 * Script always reports (via TASK_RESULT.callback); panel switch (condition enabled + this type)
 * decides whether reports drive scheduling.
 *
 * Config:
 *   window_value/unit  — site renew window W (e.g. last 30 minutes)
 *   jitter_min/max/unit — random early offset R inside the window → threshold T = W - R
 *
 * Trigger when estimated remaining_now <= T (and still > 0 unless trigger_if_expired).
 */

const UNIT_SEC = {
  seconds: 1,
  second: 1,
  sec: 1,
  s: 1,
  minutes: 60,
  minute: 60,
  min: 60,
  m: 60,
  hours: 3600,
  hour: 3600,
  h: 3600,
  days: 86400,
  day: 86400,
  d: 86400,
};

function unitToSec(value, unit, fallbackUnit = 'minutes') {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  const key = String(unit || fallbackUnit).trim().toLowerCase();
  const mult = UNIT_SEC[key] || UNIT_SEC[fallbackUnit] || 60;
  return Math.floor(n * mult);
}

function formatDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return h ? `${d}d ${h}h` : `${d}d`;
}

function parseIsoMs(value) {
  if (!value) return NaN;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? NaN : t;
}

/**
 * Pick random threshold T = windowSec - R, R ∈ [jitterMinSec, jitterMaxSec].
 * Clamped so T is at least 30s when window is large enough.
 */
function pickThresholdSec(windowSec, jitterMinSec, jitterMaxSec) {
  const w = Math.max(0, Math.floor(Number(windowSec) || 0));
  let jMin = Math.max(0, Math.floor(Number(jitterMinSec) || 0));
  let jMax = Math.max(0, Math.floor(Number(jitterMaxSec) || 0));
  if (jMax < jMin) {
    const tmp = jMin;
    jMin = jMax;
    jMax = tmp;
  }
  // Jitter cannot exceed window (otherwise threshold would go negative)
  jMin = Math.min(jMin, w);
  jMax = Math.min(jMax, w);
  const r = jMin === jMax
    ? jMin
    : jMin + Math.floor(Math.random() * (jMax - jMin + 1));
  let t = w - r;
  if (w >= 60) t = Math.max(30, t);
  return { thresholdSec: t, jitterSec: r };
}

function normalizeConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};

  // Accept both nested and flat (UI may send flat fields)
  const window_value = Number(src.window_value ?? src.windowValue ?? 30);
  const window_unit = String(src.window_unit || src.windowUnit || 'minutes').trim() || 'minutes';
  const jitter_min = Number(src.jitter_min ?? src.jitterMin ?? 5);
  const jitter_max = Number(src.jitter_max ?? src.jitterMax ?? 10);
  const jitter_unit = String(src.jitter_unit || src.jitterUnit || window_unit || 'minutes').trim() || 'minutes';
  const trigger_if_expired = Boolean(
    src.trigger_if_expired === true
    || src.trigger_if_expired === 1
    || src.trigger_if_expired === '1'
    || src.triggerIfExpired
  );

  if (!Number.isFinite(window_value) || window_value <= 0) {
    throw new Error('续期窗口必须大于 0');
  }
  if (!Number.isFinite(jitter_min) || jitter_min < 0) {
    throw new Error('随机提前下限不能为负');
  }
  if (!Number.isFinite(jitter_max) || jitter_max < 0) {
    throw new Error('随机提前上限不能为负');
  }
  if (jitter_max < jitter_min) {
    throw new Error('随机提前上限不能小于下限');
  }

  const window_sec = unitToSec(window_value, window_unit);
  const jitter_min_sec = unitToSec(jitter_min, jitter_unit);
  const jitter_max_sec = unitToSec(jitter_max, jitter_unit);
  if (window_sec < 30) {
    throw new Error('续期窗口至少 30 秒');
  }
  if (jitter_max_sec > window_sec) {
    throw new Error('随机提前不能大于续期窗口');
  }

  return {
    window_value,
    window_unit,
    window_sec,
    jitter_min,
    jitter_max,
    jitter_unit,
    jitter_min_sec,
    jitter_max_sec,
    trigger_if_expired,
  };
}

/**
 * Estimate remaining seconds from last script report.
 */
function estimateRemainingNow(task, nowMs = Date.now()) {
  const reportedSec = Number(task && task.callback_remaining_sec);
  const reportedAtMs = parseIsoMs(task && task.callback_reported_at);
  if (!Number.isFinite(reportedSec) || !Number.isFinite(reportedAtMs)) {
    return { ok: false, remainingSec: null, ageSec: null };
  }
  const ageSec = Math.max(0, (nowMs - reportedAtMs) / 1000);
  const remainingSec = reportedSec - ageSec;
  return { ok: true, remainingSec, ageSec, reportedSec, reportedAtMs };
}

/**
 * @returns {Promise<{ok:boolean, shouldTrigger:boolean, status:string, detail:string, meta?:object}>}
 */
async function evaluate(config = {}, ctx = {}) {
  const task = ctx.task || {};
  const cfg = {
    window_sec: Number(config.window_sec) || unitToSec(config.window_value || 30, config.window_unit || 'minutes'),
    jitter_min_sec: Number(config.jitter_min_sec) || unitToSec(config.jitter_min || 0, config.jitter_unit || 'minutes'),
    jitter_max_sec: Number(config.jitter_max_sec) || unitToSec(config.jitter_max || 0, config.jitter_unit || 'minutes'),
    trigger_if_expired: Boolean(config.trigger_if_expired),
  };

  const nowMs = Date.now();
  const est = estimateRemainingNow(task, nowMs);

  if (!est.ok) {
    return {
      ok: true,
      shouldTrigger: false,
      status: 'waiting',
      detail: '等待脚本上报 remaining_sec（请先手动探测一次）',
      meta: { waiting: true },
    };
  }

  const remainingSec = est.remainingSec;
  const triggerAtMs = parseIsoMs(task.callback_trigger_at);
  const thresholdSec = Number(task.callback_threshold_sec);
  const hasThreshold = Number.isFinite(thresholdSec) && thresholdSec > 0;

  // Prefer stored trigger_at (stable random); fall back to threshold vs remaining
  let due = false;
  if (Number.isFinite(triggerAtMs)) {
    due = nowMs >= triggerAtMs;
  } else if (hasThreshold) {
    due = remainingSec <= thresholdSec;
  } else {
    // No threshold yet (report stored before condition configured) — use mid-window
    const mid = pickThresholdSec(cfg.window_sec, cfg.jitter_min_sec, cfg.jitter_max_sec);
    due = remainingSec <= mid.thresholdSec;
  }

  if (remainingSec <= 0) {
    if (cfg.trigger_if_expired) {
      return {
        ok: true,
        shouldTrigger: true,
        status: 'due',
        detail: `已过期 ${formatDuration(-remainingSec)}，按配置仍触发`,
        meta: {
          remaining_sec: remainingSec,
          due: true,
          next_check_at: null,
        },
      };
    }
    return {
      ok: true,
      shouldTrigger: false,
      status: 'expired',
      detail: `已过期 ${formatDuration(-remainingSec)}，不触发（需重新探测/续期）`,
      meta: {
        remaining_sec: remainingSec,
        due: false,
      },
    };
  }

  if (due) {
    return {
      ok: true,
      shouldTrigger: true,
      status: 'due',
      detail: `进入续期窗口，剩余约 ${formatDuration(remainingSec)}`,
      meta: {
        remaining_sec: remainingSec,
        threshold_sec: hasThreshold ? thresholdSec : null,
        trigger_at: Number.isFinite(triggerAtMs) ? new Date(triggerAtMs).toISOString() : null,
        due: true,
      },
    };
  }

  // Not due yet — suggest next check near trigger_at (scheduler may honor meta.next_check_at)
  let nextCheckAt = null;
  if (Number.isFinite(triggerAtMs) && triggerAtMs > nowMs) {
    // Poll a bit before trigger (up to 60s early) so we don't miss the window
    nextCheckAt = new Date(Math.max(nowMs + 30_000, triggerAtMs - 30_000)).toISOString();
  }

  const untilTrigger = Number.isFinite(triggerAtMs)
    ? Math.max(0, (triggerAtMs - nowMs) / 1000)
    : (hasThreshold ? Math.max(0, remainingSec - thresholdSec) : remainingSec);

  return {
    ok: true,
    shouldTrigger: false,
    status: 'waiting',
    detail: `剩余约 ${formatDuration(remainingSec)}，约 ${formatDuration(untilTrigger)} 后触发`,
    meta: {
      remaining_sec: remainingSec,
      threshold_sec: hasThreshold ? thresholdSec : null,
      trigger_at: Number.isFinite(triggerAtMs) ? new Date(triggerAtMs).toISOString() : null,
      next_check_at: nextCheckAt,
      due: false,
    },
  };
}

/**
 * Compute trigger fields from a fresh remaining_sec report + condition config.
 * Random jitter is drawn once per report.
 */
function computeTriggerFromReport(remainingSec, config = {}, reportedAt = new Date()) {
  const windowSec = Number(config.window_sec)
    || unitToSec(config.window_value || 30, config.window_unit || 'minutes');
  const jitterMinSec = Number(config.jitter_min_sec)
    || unitToSec(config.jitter_min || 0, config.jitter_unit || 'minutes');
  const jitterMaxSec = Number(config.jitter_max_sec)
    || unitToSec(config.jitter_max || 0, config.jitter_unit || 'minutes');

  const { thresholdSec, jitterSec } = pickThresholdSec(windowSec, jitterMinSec, jitterMaxSec);
  const rem = Number(remainingSec);
  const reportedMs = reportedAt instanceof Date ? reportedAt.getTime() : parseIsoMs(reportedAt);
  const baseMs = Number.isFinite(reportedMs) ? reportedMs : Date.now();

  let triggerAt = null;
  if (Number.isFinite(rem)) {
    // trigger when remaining drops to threshold → after (rem - threshold) seconds
    const delaySec = Math.max(0, rem - thresholdSec);
    triggerAt = new Date(baseMs + delaySec * 1000).toISOString();
  }

  return {
    threshold_sec: thresholdSec,
    jitter_sec: jitterSec,
    trigger_at: triggerAt,
    window_sec: windowSec,
  };
}

module.exports = {
  type: 'remaining_callback',
  label: '剩余时间回调（进入窗口触发）',
  evaluate,
  normalizeConfig,
  unitToSec,
  formatDuration,
  estimateRemainingNow,
  pickThresholdSec,
  computeTriggerFromReport,
};
