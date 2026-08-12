importScripts('shared/selector-utils.js', 'shared/export-core.js', 'shared/exporters.js');

const STATE_KEY = 'automa_recorder_state';
const DATA_KEY = 'automa_recorder_data';
const OPTIONS_KEY = 'automa_recorder_options';
const DEFAULT_OPTIONS = Object.freeze({
  record_hover: false,
});

const SUPPORTED_STEP_TYPES = new Set([
  'goto',
  'click',
  'input',
  'wait',
  'scroll',
  'hover',
  'press',
  'select',
  'check',
  'uncheck',
  'assert_url_contains',
  'assert_text',
  'screenshot',
]);

async function getState() {
  const bag = await chrome.storage.local.get([STATE_KEY, DATA_KEY, OPTIONS_KEY]);
  const rawOptions = bag[OPTIONS_KEY] && typeof bag[OPTIONS_KEY] === 'object' ? bag[OPTIONS_KEY] : {};
  return {
    recording: Boolean(bag[STATE_KEY]),
    ir: bag[DATA_KEY] || null,
    options: {
      ...DEFAULT_OPTIONS,
      ...rawOptions,
      record_hover: rawOptions.record_hover === true,
    },
  };
}

function nowIso() {
  return new Date().toISOString();
}

function defaultIr(startUrl = '') {
  return {
    version: '1.0',
    meta: {
      name: `recording-${Date.now()}`,
      created_at: nowIso(),
      start_url: startUrl || '',
    },
    steps: [],
  };
}

function compactStep(step) {
  const raw = step && typeof step === 'object' ? step : {};
  return {
    id: raw.id || '',
    type: raw.type || 'unknown',
    ts: raw.ts || '',
    page_url: raw.page_url || '',
    url: raw.url === undefined || raw.url === null ? '' : String(raw.url),
    selector: raw.selector?.value || '',
    selectorPrimary: raw.selector?.primary || 'css',
    value: raw.value === undefined || raw.value === null ? '' : String(raw.value),
    key: raw.key === undefined || raw.key === null ? '' : String(raw.key),
    ms: raw.ms === undefined || raw.ms === null ? null : Number(raw.ms),
    x: raw.x === undefined || raw.x === null ? null : Number(raw.x),
    y: raw.y === undefined || raw.y === null ? null : Number(raw.y),
    name: raw.name === undefined || raw.name === null ? '' : String(raw.name),
    fullPage: raw.fullPage === true,
    enabled: raw.enabled !== false,
    group: raw.group === undefined || raw.group === null ? '' : String(raw.group),
    comment: raw.comment === undefined || raw.comment === null ? '' : String(raw.comment),
    wait_for: raw.wait_for === undefined || raw.wait_for === null ? '' : String(raw.wait_for),
    timeout_ms: raw.timeout_ms === undefined || raw.timeout_ms === null ? null : Number(raw.timeout_ms),
    fallback_ms: raw.fallback_ms === undefined || raw.fallback_ms === null ? null : Number(raw.fallback_ms),
    frame: raw.frame && typeof raw.frame === 'object' ? raw.frame : null,
  };
}

function buildStatusPayload(state, message = '') {
  const steps = Array.isArray(state?.ir?.steps) ? state.ir.steps : [];
  const stepCount = steps.length;
  return {
    ok: true,
    recording: Boolean(state?.recording),
    stepCount,
    meta: state?.ir?.meta || null,
    options: state?.options || { ...DEFAULT_OPTIONS },
    recentSteps: steps.slice(-8).reverse().map(compactStep),
    steps: steps.map(compactStep),
    message: message || `recording=${Boolean(state?.recording)} steps=${stepCount}`,
  };
}

function stepDigest(step) {
  if (!step || typeof step !== 'object') return '';
  const selector = step.selector?.value || '';
  const value = step.value === undefined || step.value === null ? '' : String(step.value);
  const key = step.key === undefined || step.key === null ? '' : String(step.key);
  const xy = `${step.x || 0},${step.y || 0}`;
  return `${step.type || ''}|${selector}|${value}|${key}|${xy}|${step.page_url || ''}`;
}

function isDuplicateStep(lastStep, nextStep) {
  if (!lastStep || !nextStep) return false;
  const t1 = Date.parse(lastStep.ts || '') || 0;
  const t2 = Date.parse(nextStep.ts || '') || Date.now();
  const close = Math.abs(t2 - t1) <= 700;
  return close && stepDigest(lastStep) === stepDigest(nextStep);
}

function appendStepsToIr(ir, rawSteps) {
  const targetIr = ir && typeof ir === 'object' ? ir : defaultIr('');
  const source = Array.isArray(rawSteps) ? rawSteps : [];
  let appended = 0;
  for (const step of source) {
    if (!step || typeof step !== 'object') continue;
    const prev = targetIr.steps.length ? targetIr.steps[targetIr.steps.length - 1] : null;
    if (isDuplicateStep(prev, step)) continue;
    targetIr.steps.push(step);
    appended += 1;
  }
  return appended;
}

function randomId() {
  return Math.floor(Math.random() * 100000).toString(36);
}

function newStep(type, pageUrl, payload = {}) {
  return {
    id: `step-${Date.now()}-${randomId()}`,
    type,
    ts: nowIso(),
    page_url: String(pageUrl || ''),
    enabled: true,
    ...payload,
  };
}

function defaultStepByType(type, pageUrl) {
  const t = String(type || '').trim();
  if (!SUPPORTED_STEP_TYPES.has(t)) return null;

  if (t === 'goto') return newStep(t, pageUrl, { url: pageUrl || '' });
  if (t === 'click') return newStep(t, pageUrl, { selector: { primary: 'css', value: '', fallbacks: [] } });
  if (t === 'input') return newStep(t, pageUrl, { selector: { primary: 'css', value: '', fallbacks: [] }, value: '' });
  if (t === 'wait') return newStep(t, pageUrl, { wait_for: 'timeout', ms: 1000, timeout_ms: 10000, fallback_ms: 1000 });
  if (t === 'scroll') return newStep(t, pageUrl, { x: 0, y: 400 });
  if (t === 'hover') return newStep(t, pageUrl, { selector: { primary: 'css', value: '', fallbacks: [] } });
  if (t === 'press') return newStep(t, pageUrl, { selector: { primary: 'css', value: '', fallbacks: [] }, key: 'Enter' });
  if (t === 'select') return newStep(t, pageUrl, { selector: { primary: 'css', value: '', fallbacks: [] }, value: '' });
  if (t === 'check' || t === 'uncheck') return newStep(t, pageUrl, { selector: { primary: 'css', value: '', fallbacks: [] } });
  if (t === 'assert_url_contains') return newStep(t, pageUrl, { value: '' });
  if (t === 'assert_text') return newStep(t, pageUrl, { selector: { primary: 'css', value: '', fallbacks: [] }, value: '' });
  if (t === 'screenshot') return newStep(t, pageUrl, { name: `shot-${Date.now()}`, fullPage: false });

  return newStep(t, pageUrl);
}

async function getActiveTabUrl() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.url || '';
}

function isRecordableStartUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return false;
  return /^https?:\/\//i.test(raw);
}

function isInjectableTabUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return false;
  return /^https?:\/\//i.test(raw);
}

async function syncRecorderStateToTab(tabId, recording, options) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'RECORDER_SET_ACTIVE', recording: Boolean(recording) });
    await chrome.tabs.sendMessage(tabId, { type: 'RECORDER_SET_OPTIONS', options });
    return true;
  } catch (error) {
    // The page may have been opened before the extension was loaded/reloaded.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content.js'],
    });
    await chrome.tabs.sendMessage(tabId, { type: 'RECORDER_SET_ACTIVE', recording: Boolean(recording) });
    await chrome.tabs.sendMessage(tabId, { type: 'RECORDER_SET_OPTIONS', options });
    return true;
  } catch (error) {
    // Ignore tabs where Chrome disallows extension scripts.
    return false;
  }
}

async function broadcastRecorderState(recording) {
  const state = await getState();
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab || typeof tab.id !== 'number') return;
      if (!isInjectableTabUrl(tab.url)) return;
      await syncRecorderStateToTab(tab.id, recording, state.options);
    })
  );
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!isInjectableTabUrl(tab?.url)) return;
  (async () => {
    const state = await getState();
    if (!state.recording) return;
    await syncRecorderStateToTab(tabId, true, state.options);
  })();
});

function textToDataUrl(text, mimeType = 'text/plain') {
  return `data:${mimeType};charset=utf-8,${encodeURIComponent(String(text || ''))}`;
}

async function downloadTextFile(filename, text, mimeType) {
  const url = textToDataUrl(text, mimeType);
  await chrome.downloads.download({
    url,
    filename,
    saveAs: true,
  });
}

async function downloadIr(ir) {
  const json = JSON.stringify(ir, null, 2);
  await downloadTextFile(`automa-recorder/${ir.meta.name}.ir.json`, json, 'application/json');
}

function findStepIndex(steps, stepId) {
  if (!Array.isArray(steps)) return -1;
  const id = String(stepId || '');
  if (!id) return -1;
  return steps.findIndex(item => String(item?.id || '') === id);
}

function normalizeStepPatch(step, patch) {
  const current = step && typeof step === 'object' ? step : {};
  const next = { ...current };
  if (patch.type !== undefined) {
    const type = String(patch.type || '').trim();
    if (SUPPORTED_STEP_TYPES.has(type)) next.type = type;
  }
  if (patch.url !== undefined) next.url = String(patch.url || '');
  if (patch.value !== undefined) next.value = String(patch.value);
  if (patch.key !== undefined) next.key = String(patch.key);
  if (patch.ms !== undefined) next.ms = Number(patch.ms);
  if (patch.wait_for !== undefined) next.wait_for = String(patch.wait_for || '');
  if (patch.timeout_ms !== undefined) next.timeout_ms = Number(patch.timeout_ms);
  if (patch.fallback_ms !== undefined) next.fallback_ms = Number(patch.fallback_ms);
  if (patch.x !== undefined) next.x = Number(patch.x);
  if (patch.y !== undefined) next.y = Number(patch.y);
  if (patch.name !== undefined) next.name = String(patch.name);
  if (patch.fullPage !== undefined) next.fullPage = Boolean(patch.fullPage);
  if (patch.group !== undefined) next.group = String(patch.group);
  if (patch.comment !== undefined) next.comment = String(patch.comment);
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  if (patch.selectorValue !== undefined) {
    const selector = next.selector && typeof next.selector === 'object'
      ? { ...next.selector }
      : { primary: 'css', fallbacks: [] };
    selector.value = String(patch.selectorValue || '');
    selector.primary = selector.primary || 'css';
    if (!Array.isArray(selector.fallbacks)) selector.fallbacks = [];
    next.selector = selector;
  }
  next.ts = nowIso();
  return next;
}

function groupNameOf(step) {
  if (!step || typeof step !== 'object') return '';
  return String(step.group || '').trim();
}

function normalizeGroupToken(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '__ungrouped__') return '';
  return raw;
}

function normalizeCleanupTargets(rawTargets) {
  const items = Array.isArray(rawTargets) ? rawTargets : [];
  const normalized = new Set();
  for (const item of items) {
    const key = String(item || '').trim().toLowerCase();
    if (!key) continue;
    normalized.add(key);
  }
  return normalized;
}

function cleanupSteps(steps, cleanupTargets) {
  const list = Array.isArray(steps) ? steps : [];
  const targets = normalizeCleanupTargets(cleanupTargets);
  const removeHover = targets.has('hover');
  const removeConsecutiveWait = targets.has('consecutive_wait');
  const removeDuplicateClick = targets.has('duplicate_click');
  const removeUrlChangeWait = targets.has('url_change_wait');
  const smartCompact = targets.has('smart_compact');

  const smartHover = smartCompact || removeHover;
  const smartWait = smartCompact || removeConsecutiveWait;
  const smartClick = smartCompact || removeDuplicateClick;
  const smartUrlWait = smartCompact || removeUrlChangeWait;
  const smartInput = smartCompact;

  if (!smartHover && !smartWait && !smartClick && !smartUrlWait && !smartInput) {
    return { steps: list.slice(), removed: 0 };
  }

  const cleaned = [];
  let removed = 0;
  for (const step of list) {
    if (!step || typeof step !== 'object') continue;

    if (smartHover && step.type === 'hover') {
      removed += 1;
      continue;
    }

    if (smartUrlWait && step.type === 'wait' && String(step.wait_for || '') === 'url_change') {
      removed += 1;
      continue;
    }

    if (smartWait && step.type === 'wait') {
      const last = cleaned.length ? cleaned[cleaned.length - 1] : null;
      if (last && last.type === 'wait' && String(last.wait_for || '') === String(step.wait_for || '')) {
        removed += 1;
        continue;
      }
    }

    if (smartClick && step.type === 'click') {
      const last = cleaned.length ? cleaned[cleaned.length - 1] : null;
      if (last && last.type === 'click' && (last.selector?.value || '') === (step.selector?.value || '')) {
        removed += 1;
        continue;
      }
    }

    if (smartInput && step.type === 'input') {
      const last = cleaned.length ? cleaned[cleaned.length - 1] : null;
      if (
        last
        && last.type === 'input'
        && (last.selector?.value || '') === (step.selector?.value || '')
      ) {
        cleaned[cleaned.length - 1] = step;
        removed += 1;
        continue;
      }
    }

    cleaned.push(step);
  }
  return { steps: cleaned, removed };
}

function summarizeRemovedSteps(removedSteps) {
  const list = Array.isArray(removedSteps) ? removedSteps : [];
  const counts = new Map();
  for (const item of list) {
    const key = String(item?.type || 'unknown');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries()).map(([type, count]) => ({ type, count }));
}

function buildCleanupPreviewPayload(originalSteps, cleanedSteps, targets) {
  const source = Array.isArray(originalSteps) ? originalSteps : [];
  const cleaned = Array.isArray(cleanedSteps) ? cleanedSteps : [];
  const kept = new Set(cleaned);
  const removedSteps = [];

  for (let i = 0; i < source.length; i += 1) {
    const step = source[i];
    if (kept.has(step)) continue;
    removedSteps.push({
      index: i + 1,
      id: String(step?.id || ''),
      type: String(step?.type || 'unknown'),
      selector: String(step?.selector?.value || ''),
      wait_for: String(step?.wait_for || ''),
      key: String(step?.key || ''),
      value: step?.value === undefined || step?.value === null ? '' : String(step.value),
      group: String(step?.group || ''),
    });
  }

  return {
    targets: Array.isArray(targets) ? targets.map((x) => String(x || '')) : [],
    total_before: source.length,
    total_after: cleaned.length,
    removed: removedSteps.length,
    removed_summary: summarizeRemovedSteps(removedSteps),
    removed_steps: removedSteps,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'RECORDER_START') {
      const startUrl = await getActiveTabUrl();
      const state = await getState();
      const ir = defaultIr(isRecordableStartUrl(startUrl) ? startUrl : '');
      await chrome.storage.local.set({
        [STATE_KEY]: true,
        [DATA_KEY]: ir,
      });
      await broadcastRecorderState(true);
      sendResponse(buildStatusPayload({ recording: true, ir, options: state.options }, 'Recording started'));
      return;
    }

    if (msg?.type === 'RECORDER_STOP') {
      await chrome.storage.local.set({ [STATE_KEY]: false });
      await broadcastRecorderState(false);
      const state = await getState();
      sendResponse(buildStatusPayload(state, 'Recording stopped'));
      return;
    }

    if (msg?.type === 'RECORDER_CLEAR') {
      const ir = defaultIr('');
      await chrome.storage.local.set({
        [STATE_KEY]: false,
        [DATA_KEY]: ir,
      });
      await broadcastRecorderState(false);
      sendResponse(buildStatusPayload({ recording: false, ir }, 'IR cleared'));
      return;
    }

    if (msg?.type === 'RECORDER_IS_RECORDING') {
      const state = await getState();
      sendResponse({ ok: true, recording: Boolean(state.recording) });
      return;
    }

    if (msg?.type === 'RECORDER_GET_OPTIONS') {
      const state = await getState();
      sendResponse({ ok: true, options: state.options });
      return;
    }

    if (msg?.type === 'RECORDER_SET_OPTIONS') {
      const state = await getState();
      const raw = msg?.options && typeof msg.options === 'object' ? msg.options : {};
      const nextOptions = {
        ...state.options,
        record_hover: raw.record_hover === true,
      };
      await chrome.storage.local.set({ [OPTIONS_KEY]: nextOptions });
      const nextState = await getState();
      await broadcastRecorderState(nextState.recording);
      sendResponse(buildStatusPayload(nextState, 'Options updated'));
      return;
    }

    if (msg?.type === 'RECORDER_STATUS') {
      const state = await getState();
      sendResponse(buildStatusPayload(state));
      return;
    }

    if (msg?.type === 'RECORDER_SAVE') {
      const state = await getState();
      if (!state.ir) {
        sendResponse({ ok: false, message: 'No IR data' });
        return;
      }
      await downloadIr(state.ir);
      sendResponse(buildStatusPayload(state, `Saved ${state.ir.steps.length} steps`));
      return;
    }

    if (msg?.type === 'RECORDER_APPEND_STEP') {
      const state = await getState();
      if (!state.recording) {
        sendResponse({ ok: false, ignored: true });
        return;
      }
      const ir = state.ir || defaultIr(msg?.pageUrl || '');
      const step = msg.step || null;
      if (!step) {
        sendResponse({ ok: false, message: 'Missing step' });
        return;
      }
      const appended = appendStepsToIr(ir, [step]);
      if (appended <= 0) {
        sendResponse({ ok: true, steps: ir.steps.length, deduped: true, recording: true });
        return;
      }
      await chrome.storage.local.set({ [DATA_KEY]: ir });
      sendResponse({ ok: true, steps: ir.steps.length, recording: true });
      return;
    }

    if (msg?.type === 'RECORDER_APPEND_STEPS') {
      const state = await getState();
      if (!state.recording) {
        sendResponse({ ok: false, ignored: true });
        return;
      }
      const ir = state.ir || defaultIr(msg?.pageUrl || '');
      const steps = Array.isArray(msg?.steps) ? msg.steps : [];
      if (!steps.length) {
        sendResponse({ ok: false, message: 'Missing steps' });
        return;
      }
      const appended = appendStepsToIr(ir, steps);
      if (appended <= 0) {
        sendResponse({ ok: true, steps: ir.steps.length, deduped: true, recording: true });
        return;
      }
      await chrome.storage.local.set({ [DATA_KEY]: ir });
      sendResponse({ ok: true, steps: ir.steps.length, appended, recording: true });
      return;
    }

    if (msg?.type === 'RECORDER_STEP_DELETE') {
      const state = await getState();
      const ir = state.ir || defaultIr('');
      const idx = findStepIndex(ir.steps, msg?.stepId);
      if (idx < 0) {
        sendResponse({ ok: false, message: 'Step not found' });
        return;
      }
      ir.steps.splice(idx, 1);
      await chrome.storage.local.set({ [DATA_KEY]: ir });
      sendResponse(buildStatusPayload({ recording: state.recording, ir }, 'Step deleted'));
      return;
    }

    if (msg?.type === 'RECORDER_STEP_MOVE') {
      const state = await getState();
      const ir = state.ir || defaultIr('');
      const idx = findStepIndex(ir.steps, msg?.stepId);
      if (idx < 0) {
        sendResponse({ ok: false, message: 'Step not found' });
        return;
      }
      const dir = String(msg?.direction || '').toLowerCase();
      const targetIdx = dir === 'up' ? idx - 1 : dir === 'down' ? idx + 1 : idx;
      if (targetIdx < 0 || targetIdx >= ir.steps.length || targetIdx === idx) {
        sendResponse(buildStatusPayload({ recording: state.recording, ir }, 'Step unchanged'));
        return;
      }
      const [item] = ir.steps.splice(idx, 1);
      ir.steps.splice(targetIdx, 0, item);
      await chrome.storage.local.set({ [DATA_KEY]: ir });
      sendResponse(buildStatusPayload({ recording: state.recording, ir }, `Step moved ${dir}`));
      return;
    }

    if (msg?.type === 'RECORDER_STEP_UPDATE') {
      const state = await getState();
      const ir = state.ir || defaultIr('');
      const idx = findStepIndex(ir.steps, msg?.stepId);
      if (idx < 0) {
        sendResponse({ ok: false, message: 'Step not found' });
        return;
      }
      const patch = msg?.patch && typeof msg.patch === 'object' ? msg.patch : null;
      if (!patch) {
        sendResponse({ ok: false, message: 'Missing patch' });
        return;
      }
      ir.steps[idx] = normalizeStepPatch(ir.steps[idx], patch);
      await chrome.storage.local.set({ [DATA_KEY]: ir });
      sendResponse(buildStatusPayload({ recording: state.recording, ir }, 'Step updated'));
      return;
    }

    if (msg?.type === 'RECORDER_GROUP_SET_ENABLED') {
      const state = await getState();
      const ir = state.ir || defaultIr('');
      const groupRaw = String(msg?.group || '').trim();
      const group = normalizeGroupToken(groupRaw);
      const enabled = Boolean(msg?.enabled);
      if (!groupRaw) {
        sendResponse({ ok: false, message: 'Missing group' });
        return;
      }
      let changed = 0;
      for (let i = 0; i < ir.steps.length; i += 1) {
        const step = ir.steps[i];
        if (groupNameOf(step) !== group) continue;
        ir.steps[i] = { ...step, enabled, ts: nowIso() };
        changed += 1;
      }
      await chrome.storage.local.set({ [DATA_KEY]: ir });
      sendResponse(buildStatusPayload({ recording: state.recording, ir }, `Group ${group}: ${enabled ? 'enabled' : 'disabled'} (${changed})`));
      return;
    }

    if (msg?.type === 'RECORDER_GROUP_DELETE') {
      const state = await getState();
      const ir = state.ir || defaultIr('');
      const group = normalizeGroupToken(msg?.group);
      if (String(msg?.group || '').trim() === '') {
        sendResponse({ ok: false, message: 'Missing group' });
        return;
      }
      const before = ir.steps.length;
      ir.steps = ir.steps.filter(step => groupNameOf(step) !== group);
      const removed = before - ir.steps.length;
      await chrome.storage.local.set({ [DATA_KEY]: ir });
      sendResponse(buildStatusPayload({ recording: state.recording, ir }, `Group ${group}: deleted ${removed}`));
      return;
    }

    if (msg?.type === 'RECORDER_GROUP_RENAME' || msg?.type === 'RECORDER_GROUP_MERGE') {
      const state = await getState();
      const ir = state.ir || defaultIr('');
      const fromRaw = String(msg?.fromGroup || '').trim();
      const toRaw = String(msg?.toGroup || '').trim();
      if (!fromRaw) {
        sendResponse({ ok: false, message: 'Missing fromGroup' });
        return;
      }
      const fromGroup = normalizeGroupToken(fromRaw);
      const toGroup = normalizeGroupToken(toRaw);
      let changed = 0;
      for (let i = 0; i < ir.steps.length; i += 1) {
        const step = ir.steps[i];
        if (groupNameOf(step) !== fromGroup) continue;
        ir.steps[i] = { ...step, group: toGroup, ts: nowIso() };
        changed += 1;
      }
      await chrome.storage.local.set({ [DATA_KEY]: ir });
      const actionName = msg.type === 'RECORDER_GROUP_MERGE' ? 'merged' : 'renamed';
      const fromLabel = fromGroup || '__ungrouped__';
      const toLabel = toGroup || '__ungrouped__';
      sendResponse(buildStatusPayload({ recording: state.recording, ir }, `Group ${fromLabel} ${actionName} -> ${toLabel} (${changed})`));
      return;
    }

    if (msg?.type === 'RECORDER_STEP_INSERT') {
      const state = await getState();
      const ir = state.ir || defaultIr('');
      const stepType = String(msg?.stepType || '').trim();
      const pageUrl = String(msg?.pageUrl || ir.meta?.start_url || '');
      const draft = defaultStepByType(stepType, pageUrl);
      if (!draft) {
        sendResponse({ ok: false, message: `Unsupported step type: ${stepType}` });
        return;
      }

      const afterStepId = String(msg?.afterStepId || '').trim();
      const afterIdx = findStepIndex(ir.steps, afterStepId);
      const insertAt = afterIdx >= 0 ? afterIdx + 1 : ir.steps.length;
      ir.steps.splice(insertAt, 0, draft);
      await chrome.storage.local.set({ [DATA_KEY]: ir });
      sendResponse(buildStatusPayload({ recording: state.recording, ir }, `Step inserted: ${stepType}`));
      return;
    }

    if (msg?.type === 'RECORDER_EXPORT_SCRIPT') {
      const state = await getState();
      if (!state.ir) {
        sendResponse({ ok: false, message: 'No IR data' });
        return;
      }
      const target = String(msg?.target || '').toLowerCase();
      const script = globalThis.AutomaExporters.generateScriptByTarget(target, state.ir);
      const ext = target === 'seleniumbase' ? 'py' : 'js';
      const fileName = `automa-recorder/${state.ir.meta?.name || 'recording'}.${target}.${ext}`;
      await downloadTextFile(fileName, script, 'text/plain');
      sendResponse(buildStatusPayload(state, `Exported ${target} script`));
      return;
    }

    if (msg?.type === 'RECORDER_EXPORT_PREVIEW') {
      const state = await getState();
      if (!state.ir) {
        sendResponse({ ok: false, message: 'No IR data' });
        return;
      }
      const target = String(msg?.target || '').toLowerCase();
      const script = globalThis.AutomaExporters.generateScriptByTarget(target, state.ir);
      sendResponse({
        ...buildStatusPayload(state, `Preview generated for ${target}`),
        target,
        script,
      });
      return;
    }

    if (msg?.type === 'RECORDER_CLEAN_STEPS') {
      const state = await getState();
      const ir = state.ir || defaultIr('');
      const { steps, removed } = cleanupSteps(ir.steps, msg?.targets);
      ir.steps = steps;
      await chrome.storage.local.set({ [DATA_KEY]: ir });
      sendResponse(buildStatusPayload({ recording: state.recording, ir, options: state.options }, `Cleanup removed ${removed} steps`));
      return;
    }

    if (msg?.type === 'RECORDER_CLEAN_PREVIEW') {
      const state = await getState();
      const ir = state.ir || defaultIr('');
      const result = cleanupSteps(ir.steps, msg?.targets);
      const preview = buildCleanupPreviewPayload(ir.steps, result.steps, msg?.targets);
      sendResponse({
        ok: true,
        preview,
      });
      return;
    }
  })().catch((error) => {
    sendResponse({ ok: false, message: String(error?.message || error) });
  });

  return true;
});
