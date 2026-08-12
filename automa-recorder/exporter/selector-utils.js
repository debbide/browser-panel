function sanitizeSelectorValue(value) {
  return String(value || '').trim();
}

function normalizeSelectorInput(selector) {
  if (typeof selector === 'string') {
    return {
      primary: 'css',
      value: sanitizeSelectorValue(selector),
      fallbacks: [],
    };
  }
  if (!selector || typeof selector !== 'object') {
    return {
      primary: 'css',
      value: '',
      fallbacks: [],
    };
  }

  const fallbacks = Array.isArray(selector.fallbacks)
    ? selector.fallbacks
      .filter(item => item && typeof item === 'object')
      .map(item => ({
        type: String(item.type || 'css').trim().toLowerCase(),
        value: sanitizeSelectorValue(item.value),
      }))
      .filter(item => item.value)
    : [];

  return {
    primary: String(selector.primary || 'css').trim().toLowerCase(),
    value: sanitizeSelectorValue(selector.value),
    fallbacks,
  };
}

function selectorCandidates(selector) {
  const s = normalizeSelectorInput(selector);
  const list = [];

  if (s.value) {
    list.push({
      type: s.primary || 'css',
      value: s.value,
    });
  }

  for (const item of s.fallbacks) {
    if (!item.value) continue;
    list.push(item);
  }

  return list.filter(Boolean);
}

function hasUsableSelectorCandidate(selector) {
  return selectorCandidates(selector).length > 0;
}

module.exports = {
  sanitizeSelectorValue,
  normalizeSelectorInput,
  selectorCandidates,
  hasUsableSelectorCandidate,
};
