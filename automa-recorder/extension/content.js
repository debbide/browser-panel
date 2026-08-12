function initAutomaRecorderContent() {
if (globalThis.__AUTOMA_RECORDER_CONTENT_LOADED__) {
  return;
}
globalThis.__AUTOMA_RECORDER_CONTENT_LOADED__ = true;

const DEDUP_WINDOW_MS = 700;
const HOVER_THROTTLE_MS = 1000;
const SCROLL_THROTTLE_MS = 450;
const NOISY_TAGS = new Set(['svg', 'use', 'path']);
const CONTAINER_TAGS = new Set(['html', 'body', 'header', 'main', 'section', 'article', 'nav', 'footer']);

let isRecording = false;
let listenersMounted = false;
let hoverListenerMounted = false;
let lastHoverAt = 0;
let lastScrollAt = 0;
let lastStepDigest = '';
let lastStepAt = 0;
let recorderOptions = {
  record_hover: false,
};
let turnstileObserver = null;
let turnstilePollTimer = null;
let turnstileSolvedEmitted = false;

function tagNameOf(el) {
  if (!el || !(el instanceof Element)) return '';
  return String(el.tagName || '').toLowerCase();
}

function closestUsefulElement(rawTarget) {
  let node = rawTarget;
  while (node && node instanceof Element && NOISY_TAGS.has(tagNameOf(node))) {
    node = node.parentElement;
  }
  return node instanceof Element ? node : null;
}

function resolveInteractionTarget(rawTarget, mode = 'generic') {
  let target = closestUsefulElement(rawTarget);
  if (!target) return null;

  if (mode === 'click') {
    const interactive = target.closest([
      'a[href]',
      'button',
      '[role="button"]',
      '[role="link"]',
      'input[type="button"]',
      'input[type="submit"]',
      'label',
      'summary',
      '[data-testid]',
      '[data-action]',
      '[onclick]',
    ].join(','));
    if (interactive) target = interactive;
  }

  if (mode === 'press') {
    const inputLike = target.closest('input, textarea, [contenteditable=""], [contenteditable="true"], [role="textbox"]');
    if (inputLike) target = inputLike;
  }

  if (mode === 'check') {
    const checkLike = target.closest('input[type="checkbox"], input[type="radio"]');
    if (checkLike) target = checkLike;
  }

  const tag = tagNameOf(target);
  if (tag === 'html' || tag === 'body') return null;
  if (mode === 'hover' && CONTAINER_TAGS.has(tag)) return null;
  return target;
}

function isTextEntryElement(el) {
  if (!el || !(el instanceof Element)) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    const type = String(el.type || '').toLowerCase();
    return [
      '',
      'text',
      'email',
      'password',
      'search',
      'tel',
      'url',
      'number',
      'date',
      'time',
      'datetime-local',
      'month',
      'week',
    ].includes(type);
  }
  const editable = String(el.getAttribute('contenteditable') || '').toLowerCase();
  return editable === '' || editable === 'true';
}

function isSubmitControlElement(el) {
  if (!el || !(el instanceof Element)) return false;
  if (el instanceof HTMLButtonElement) {
    const btnType = String(el.type || 'submit').toLowerCase();
    return btnType === 'submit' || btnType === '';
  }
  if (el instanceof HTMLInputElement) {
    const inputType = String(el.type || '').toLowerCase();
    return inputType === 'submit' || inputType === 'image' || inputType === 'button';
  }
  const role = String(el.getAttribute('role') || '').toLowerCase();
  return role === 'button';
}

function cssPath(el) {
  if (!el || el.nodeType !== 1) return '';
  if (el.id) return `#${el.id}`;

  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html') {
    let part = node.tagName.toLowerCase();
    if (node.classList && node.classList.length > 0) {
      const classBits = Array.from(node.classList).filter(Boolean).slice(0, 2);
      if (classBits.length) part += `.${classBits.join('.')}`;
    }

    const parent = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
      if (siblings.length > 1) {
        const idx = siblings.indexOf(node) + 1;
        part += `:nth-of-type(${idx})`;
      }
    }
    parts.unshift(part);
    node = parent;
  }

  return parts.join(' > ');
}

function xpathOf(el) {
  if (!el || el.nodeType !== 1) return '';
  if (el.id) return `//*[@id='${el.id}']`;

  const segments = [];
  let node = el;
  while (node && node.nodeType === 1) {
    const tag = node.tagName.toLowerCase();
    const siblings = node.parentElement
      ? Array.from(node.parentElement.children).filter((child) => child.tagName === node.tagName)
      : [];
    const index = siblings.length > 1 ? `[${siblings.indexOf(node) + 1}]` : '';
    segments.unshift(`${tag}${index}`);
    node = node.parentElement;
    if (tag === 'html') break;
  }
  return `/${segments.join('/')}`;
}

function visibleText(el, maxLen = 60) {
  if (!el || !(el instanceof Element)) return '';
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  return text.slice(0, maxLen);
}

function roleSelectorOf(el) {
  if (!el || !(el instanceof Element)) return '';
  const role = el.getAttribute('role');
  const label = el.getAttribute('aria-label') || el.getAttribute('title') || visibleText(el, 40);
  if (!role) return '';
  if (!label) return role;
  return `${role}:${label}`;
}

function cssEscapeIdent(value) {
  const raw = String(value || '');
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(raw);
  return raw.replace(/([^\w-])/g, '\\$1');
}

function cssEscapeAttr(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function isLikelyDynamicToken(value) {
  const v = String(value || '').trim();
  if (!v) return true;
  if (v.length > 80) return true;
  if (/[a-f0-9]{10,}/i.test(v) && /\d/.test(v)) return true;
  if (/\d{4,}/.test(v)) return true;
  if (/[_-](?:\d{4,}|[a-f0-9]{8,})/i.test(v)) return true;
  return false;
}

function isUniqueCssSelector(selector, el) {
  if (!selector || !(el instanceof Element)) return false;
  try {
    const matches = document.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === el;
  } catch (error) {
    return false;
  }
}

function countCssSelector(selector) {
  if (!selector) return Number.POSITIVE_INFINITY;
  try {
    return document.querySelectorAll(selector).length;
  } catch (error) {
    return Number.POSITIVE_INFINITY;
  }
}

function stableClassNames(el, maxCount = 2) {
  if (!el || !(el instanceof Element) || !el.classList) return [];
  const list = [];
  for (const cls of Array.from(el.classList)) {
    const name = String(cls || '').trim();
    if (!name) continue;
    if (name.length > 40) continue;
    if (isLikelyDynamicToken(name)) continue;
    list.push(name);
    if (list.length >= maxCount) break;
  }
  return list;
}

function pushCandidate(list, type, value) {
  const t = String(type || '').trim().toLowerCase();
  const v = String(value || '').trim();
  if (!t || !v) return;
  if (list.some((item) => item.type === t && item.value === v)) return;
  list.push({ type: t, value: v });
}

function buildShortCssCandidate(el) {
  const tag = tagNameOf(el);
  if (!tag) return '';
  const classes = stableClassNames(el, 2);
  const classSuffix = classes.length ? `.${classes.map(cssEscapeIdent).join('.')}` : '';
  const selector = `${tag}${classSuffix}`;
  if (isUniqueCssSelector(selector, el)) return selector;
  return '';
}

function buildAnchoredCssCandidate(el) {
  const base = buildShortCssCandidate(el) || tagNameOf(el);
  if (!base) return '';
  let current = el.parentElement;
  let chain = [base];
  let depth = 0;
  while (current && depth < 4) {
    depth += 1;
    const id = String(current.id || '').trim();
    if (id && !isLikelyDynamicToken(id)) {
      chain.unshift(`#${cssEscapeIdent(id)}`);
      const selector = chain.join(' > ');
      if (isUniqueCssSelector(selector, el)) return selector;
      break;
    }

    const tag = tagNameOf(current);
    if (!tag) {
      current = current.parentElement;
      continue;
    }
    const classes = stableClassNames(current, 1);
    const segment = classes.length ? `${tag}.${classes.map(cssEscapeIdent).join('.')}` : tag;
    chain.unshift(segment);
    const selector = chain.join(' > ');
    if (isUniqueCssSelector(selector, el)) return selector;
    current = current.parentElement;
  }
  return '';
}

function bestDataSelector(el) {
  if (!el || !(el instanceof Element)) return null;
  const tag = tagNameOf(el) || '*';
  const attrs = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa', 'data-action'];
  for (const attr of attrs) {
    const raw = String(el.getAttribute(attr) || '').trim();
    if (!raw || isLikelyDynamicToken(raw)) continue;
    const attrSelector = `${tag}[${attr}="${cssEscapeAttr(raw)}"]`;
    const bareSelector = `[${attr}="${cssEscapeAttr(raw)}"]`;
    const chosen = isUniqueCssSelector(attrSelector, el) ? attrSelector : (isUniqueCssSelector(bareSelector, el) ? bareSelector : '');
    if (!chosen) continue;
    if (attr === 'data-testid') return { type: 'testid', value: raw };
    return { type: 'css', value: chosen };
  }
  return null;
}

function bestAttributeCssCandidate(el) {
  if (!el || !(el instanceof Element)) return '';
  const tag = tagNameOf(el) || '*';

  const id = String(el.id || '').trim();
  if (id && !isLikelyDynamicToken(id)) {
    const selector = `#${cssEscapeIdent(id)}`;
    if (isUniqueCssSelector(selector, el)) return selector;
  }

  const nameAttr = String(el.getAttribute('name') || '').trim();
  if (nameAttr && !isLikelyDynamicToken(nameAttr)) {
    const selector = `${tag}[name="${cssEscapeAttr(nameAttr)}"]`;
    if (isUniqueCssSelector(selector, el)) return selector;
  }

  const ariaLabel = String(el.getAttribute('aria-label') || '').trim();
  if (ariaLabel && ariaLabel.length <= 80 && !isLikelyDynamicToken(ariaLabel)) {
    const selector = `${tag}[aria-label="${cssEscapeAttr(ariaLabel)}"]`;
    if (isUniqueCssSelector(selector, el)) return selector;
  }

  const titleAttr = String(el.getAttribute('title') || '').trim();
  if (titleAttr && titleAttr.length <= 80 && !isLikelyDynamicToken(titleAttr)) {
    const selector = `${tag}[title="${cssEscapeAttr(titleAttr)}"]`;
    if (isUniqueCssSelector(selector, el)) return selector;
  }

  return '';
}

function bestTextCandidate(el) {
  const text = visibleText(el, 40);
  if (!text || text.length < 2) return '';
  const selector = `*:not(script):not(style)`;
  const matchCount = countCssSelector(selector);
  if (matchCount > 5000) return '';
  return text;
}

function selectorOf(el) {
  const candidates = [];
  const dataCandidate = bestDataSelector(el);
  if (dataCandidate) pushCandidate(candidates, dataCandidate.type, dataCandidate.value);

  const attrCss = bestAttributeCssCandidate(el);
  if (attrCss) pushCandidate(candidates, 'css', attrCss);

  const role = roleSelectorOf(el);
  if (role) pushCandidate(candidates, 'role', role);

  const shortCss = buildShortCssCandidate(el);
  if (shortCss) pushCandidate(candidates, 'css', shortCss);

  const anchoredCss = buildAnchoredCssCandidate(el);
  if (anchoredCss) pushCandidate(candidates, 'css', anchoredCss);

  const text = bestTextCandidate(el);
  if (text) pushCandidate(candidates, 'text', text);

  const fullCss = cssPath(el);
  if (fullCss) pushCandidate(candidates, 'css', fullCss);

  const xpath = xpathOf(el);
  if (xpath) pushCandidate(candidates, 'xpath', xpath);

  if (!candidates.length) {
    return {
      primary: 'css',
      value: '',
      fallbacks: [],
    };
  }

  const [primary, ...fallbacks] = candidates;
  return {
    primary: primary.type,
    value: primary.value,
    fallbacks,
  };
}

function getFrameContext() {
  if (window.top === window.self) return null;

  const context = {
    in_iframe: true,
    url: location.href,
    name: window.name || '',
    depth: 0,
    selector: '',
    selector_primary: 'css',
    selector_fallbacks: [],
  };

  let current = window;
  while (current && current !== current.top) {
    context.depth += 1;
    try {
      const frameEl = current.frameElement;
      if (frameEl && !context.selector) {
        const sel = selectorOf(frameEl);
        context.selector = sel.value || '';
        context.selector_primary = sel.primary || 'css';
        context.selector_fallbacks = Array.isArray(sel.fallbacks) ? sel.fallbacks : [];
      }
    } catch (error) {
      // Keep best-effort context only.
    }
    try {
      current = current.parent;
    } catch (error) {
      break;
    }
  }

  return context;
}

function randomId() {
  return Math.floor(Math.random() * 100000).toString(36);
}

function stepId() {
  return `step-${Date.now()}-${randomId()}`;
}

function isSensitiveInput(el) {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
  const type = String(el.type || '').toLowerCase();
  const name = String(el.name || '').toLowerCase();
  const id = String(el.id || '').toLowerCase();
  const placeholder = String(el.placeholder || '').toLowerCase();
  const key = `${type}|${name}|${id}|${placeholder}`;

  if (type === 'password') return true;
  if (/pass|password|pwd|otp|code|token|secret|2fa|auth/i.test(key)) return true;
  return false;
}

function sanitizeValue(el, value) {
  if (isSensitiveInput(el)) return '{{SECRET}}';
  return String(value === undefined || value === null ? '' : value);
}

function buildStep(type, payload = {}) {
  return {
    id: stepId(),
    type,
    ts: new Date().toISOString(),
    page_url: location.href,
    page_title: document.title || '',
    frame: getFrameContext(),
    ...payload,
  };
}

function isLikelyNavigationClick(target) {
  if (!(target instanceof Element)) return false;
  const anchor = target.closest('a[href]');
  if (anchor) {
    const href = String(anchor.getAttribute('href') || '').trim();
    if (href && !href.startsWith('#') && !href.toLowerCase().startsWith('javascript:')) return true;
  }
  if (target instanceof HTMLButtonElement) {
    const btnType = String(target.type || '').toLowerCase();
    if (btnType === 'submit') return true;
  }
  const role = String(target.getAttribute?.('role') || '').toLowerCase();
  if (role === 'link') return true;
  return false;
}

function digestStep(step) {
  const selectorValue = step?.selector?.value || '';
  const value = step?.value || '';
  const key = step?.key || '';
  return `${step?.type || ''}|${selectorValue}|${value}|${key}|${step?.x || ''},${step?.y || ''}`;
}

function shouldDropStep(step) {
  const now = Date.now();
  const digest = digestStep(step);
  const sameDigest = digest === lastStepDigest;
  const withinWindow = now - lastStepAt <= DEDUP_WINDOW_MS;
  if (sameDigest && withinWindow) return true;
  lastStepDigest = digest;
  lastStepAt = now;
  return false;
}

function appendStep(step) {
  if (!isRecording) return;
  if (!step || shouldDropStep(step)) return;
  chrome.runtime.sendMessage({
    type: 'RECORDER_APPEND_STEP',
    pageUrl: location.href,
    step,
  });
}

function appendSteps(steps) {
  if (!isRecording) return;
  if (!Array.isArray(steps) || !steps.length) return;
  const accepted = [];
  for (const step of steps) {
    if (!step) continue;
    if (shouldDropStep(step)) continue;
    accepted.push(step);
  }
  if (!accepted.length) return;
  chrome.runtime.sendMessage({
    type: 'RECORDER_APPEND_STEPS',
    pageUrl: location.href,
    steps: accepted,
  });
}

function onClick(event) {
  const rawTarget = closestUsefulElement(event.target);
  if (isTextEntryElement(rawTarget)) return;
  const target = resolveInteractionTarget(event.target, 'click');
  if (!target) return;
  appendStep(buildStep('click', { selector: selectorOf(target) }));
  if (isLikelyNavigationClick(target)) {
    appendStep(
      buildStep('wait', {
        wait_for: 'url_change',
        timeout_ms: 12000,
        fallback_ms: 1200,
        ms: 1200,
        group: 'post-navigation',
        comment: 'auto wait(url_change) after navigation-like click',
      }),
    );
  }
}

function onSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  const tokenLen = readTurnstileTokenLength();
  if (tokenLen > 20) {
    emitTurnstileSolvedOnce('submit-precheck');
  }

  const submitterRaw = event && event.submitter instanceof Element ? event.submitter : null;
  let submitSource = submitterRaw;
  if (!submitSource && document.activeElement instanceof Element && form.contains(document.activeElement)) {
    submitSource = document.activeElement;
  }
  if (!submitSource) {
    const local = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
    if (local) {
      submitSource = local;
    } else {
      const globalCandidates = document.querySelectorAll('button[type="submit"], input[type="submit"], button:not([type])');
      for (const candidate of globalCandidates) {
        if (!(candidate instanceof Element)) continue;
        if (candidate instanceof HTMLButtonElement || candidate instanceof HTMLInputElement) {
          if (candidate.form === form) {
            submitSource = candidate;
            break;
          }
        }
      }
    }
  }

  const submitter = submitSource ? resolveInteractionTarget(submitSource, 'click') : null;
  const submitSelector = submitter ? selectorOf(submitter) : null;
  const submitHasSelector = Boolean(submitSelector && submitSelector.value);
  const submitSteps = [];

  if (submitter && submitHasSelector && isSubmitControlElement(submitter)) {
    submitSteps.push(buildStep('click', {
      selector: submitSelector,
      group: 'form-submit',
      comment: 'captured from submit event',
    }));
  } else {
    const keyTarget = resolveInteractionTarget(form, 'press') || form;
    const keySelector = selectorOf(keyTarget);
    if (keySelector && keySelector.value) {
      submitSteps.push(buildStep('press', {
        selector: keySelector,
        key: 'Enter',
        group: 'form-submit',
        comment: 'submit event without submitter',
      }));
    }
  }

  submitSteps.push(buildStep('wait', {
    wait_for: 'url_change',
    timeout_ms: 12000,
    fallback_ms: 1200,
    ms: 1200,
    group: 'post-navigation',
    comment: 'auto wait(url_change) after form submit',
  }));

  appendSteps(submitSteps);
}

function onChange(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) {
    return;
  }

  if (target instanceof HTMLSelectElement) {
    appendStep(buildStep('select', { selector: selectorOf(target), value: target.value }));
    return;
  }

  appendStep(buildStep('input', { selector: selectorOf(target), value: sanitizeValue(target, target.value) }));
}

function onKeyDown(event) {
  const target = resolveInteractionTarget(event.target, 'press');
  if (!target) return;
  const key = String(event.key || '').trim();
  if (!key) return;
  if (key === 'Enter' || key === 'Tab' || key === 'Escape') {
    appendStep(buildStep('press', { selector: selectorOf(target), key }));
  }
}

function onMouseOver(event) {
  if (!recorderOptions.record_hover) return;
  const now = Date.now();
  if (now - lastHoverAt < HOVER_THROTTLE_MS) return;
  lastHoverAt = now;
  const target = resolveInteractionTarget(event.target, 'hover');
  if (!target) return;
  appendStep(buildStep('hover', { selector: selectorOf(target) }));
}

function onCheckChange(event) {
  const target = resolveInteractionTarget(event.target, 'check');
  if (!(target instanceof HTMLInputElement)) return;
  const type = String(target.type || '').toLowerCase();
  if (type !== 'checkbox' && type !== 'radio') return;
  appendStep(buildStep(target.checked ? 'check' : 'uncheck', { selector: selectorOf(target) }));
}

function onScroll() {
  const now = Date.now();
  if (now - lastScrollAt < SCROLL_THROTTLE_MS) return;
  lastScrollAt = now;
  appendStep(buildStep('scroll', { x: window.scrollX, y: window.scrollY }));
}

function readTurnstileTokenLength() {
  const input = document.querySelector('input[name="cf-turnstile-response"]');
  if (!input) return 0;
  const value = String(input.value || '').trim();
  return value.length;
}

function emitTurnstileSolvedStep(source = 'observer') {
  appendStep(buildStep('assert_text', {
    selector: {
      primary: 'css',
      value: 'input[name="cf-turnstile-response"]',
      fallbacks: [],
    },
    value: '__turnstile_token_ready__',
    group: 'anti-bot',
    comment: `turnstile token detected by ${source}`,
  }));
}

function setupTurnstileObserver() {
  teardownTurnstileObserver();
  turnstileSolvedEmitted = false;
  const input = document.querySelector('input[name="cf-turnstile-response"]');
  if (!input) {
    startTurnstilePolling();
    return;
  }

  const firstLen = readTurnstileTokenLength();
  if (firstLen > 20) {
    emitTurnstileSolvedOnce('initial');
    return;
  }

  turnstileObserver = new MutationObserver(() => {
    const len = readTurnstileTokenLength();
    if (len > 20) {
      emitTurnstileSolvedOnce('mutation');
    }
  });

  turnstileObserver.observe(input, {
    attributes: true,
    attributeFilter: ['value'],
    childList: false,
    subtree: false,
  });
  startTurnstilePolling();
}

function teardownTurnstileObserver() {
  if (turnstileObserver) {
    try {
      turnstileObserver.disconnect();
    } catch (error) {
      // Ignore teardown failures.
    }
    turnstileObserver = null;
  }
  stopTurnstilePolling();
}

function emitTurnstileSolvedOnce(source = 'observer') {
  if (turnstileSolvedEmitted) return;
  turnstileSolvedEmitted = true;
  emitTurnstileSolvedStep(source);
  teardownTurnstileObserver();
}

function startTurnstilePolling() {
  stopTurnstilePolling();
  turnstilePollTimer = window.setInterval(() => {
    const len = readTurnstileTokenLength();
    if (len > 20) {
      emitTurnstileSolvedOnce('polling');
      return;
    }

    // Hidden input may be inserted after initial mount; attach observer lazily.
    if (!turnstileObserver) {
      const input = document.querySelector('input[name="cf-turnstile-response"]');
      if (!input) return;
      turnstileObserver = new MutationObserver(() => {
        const latestLen = readTurnstileTokenLength();
        if (latestLen > 20) {
          emitTurnstileSolvedOnce('mutation-late');
        }
      });
      turnstileObserver.observe(input, {
        attributes: true,
        attributeFilter: ['value'],
        childList: false,
        subtree: false,
      });
    }
  }, 500);
}

function stopTurnstilePolling() {
  if (!turnstilePollTimer) return;
  window.clearInterval(turnstilePollTimer);
  turnstilePollTimer = null;
}

function setHoverListenerActive(active) {
  const shouldAttach = Boolean(active);
  if (shouldAttach && !hoverListenerMounted) {
    document.addEventListener('mouseover', onMouseOver, true);
    hoverListenerMounted = true;
    return;
  }
  if (!shouldAttach && hoverListenerMounted) {
    document.removeEventListener('mouseover', onMouseOver, true);
    hoverListenerMounted = false;
  }
}

function mountListeners() {
  if (listenersMounted) return;
  listenersMounted = true;
  document.addEventListener('click', onClick, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('submit', onSubmit, true);
  document.addEventListener('change', onCheckChange, true);
  window.addEventListener('scroll', onScroll, true);
  setHoverListenerActive(recorderOptions.record_hover);
  setupTurnstileObserver();
}

function unmountListeners() {
  if (!listenersMounted) return;
  listenersMounted = false;
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('change', onChange, true);
  document.removeEventListener('keydown', onKeyDown, true);
  document.removeEventListener('submit', onSubmit, true);
  document.removeEventListener('change', onCheckChange, true);
  window.removeEventListener('scroll', onScroll, true);
  setHoverListenerActive(false);
  teardownTurnstileObserver();
}

function setRecordingActive(active) {
  isRecording = Boolean(active);
  if (isRecording) {
    turnstileSolvedEmitted = false;
    mountListeners();
  } else {
    turnstileSolvedEmitted = false;
    unmountListeners();
  }
}

function setRecorderOptions(nextOptions) {
  const safe = nextOptions && typeof nextOptions === 'object' ? nextOptions : {};
  recorderOptions = {
    ...recorderOptions,
    record_hover: safe.record_hover === true,
  };
  if (isRecording) setHoverListenerActive(recorderOptions.record_hover);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'RECORDER_SET_ACTIVE') {
    setRecordingActive(Boolean(msg.recording));
    sendResponse({ ok: true, recording: isRecording });
    return true;
  }
  if (msg?.type === 'RECORDER_SET_OPTIONS') {
    setRecorderOptions(msg.options);
    sendResponse({ ok: true, options: recorderOptions });
    return true;
  }
  return true;
});

chrome.runtime.sendMessage({ type: 'RECORDER_IS_RECORDING' }, (res) => {
  if (chrome.runtime.lastError) return;
  setRecordingActive(Boolean(res?.recording));
});

chrome.runtime.sendMessage({ type: 'RECORDER_GET_OPTIONS' }, (res) => {
  if (chrome.runtime.lastError) return;
  if (res?.ok) setRecorderOptions(res.options);
});
}

initAutomaRecorderContent();
