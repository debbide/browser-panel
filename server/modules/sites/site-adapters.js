const DEFAULT_STEPS = [
  { action: 'open', url: 'https://example.com' },
  { action: 'screenshot' },
];

const adapters = {
  default: {
    key: 'default',
    entryUrl: 'https://example.com',
    steps: DEFAULT_STEPS,
  },
};

function resolveSiteAdapter(task) {
  const key = String(task?.site_adapter || 'default').trim().toLowerCase();
  return adapters[key] || adapters.default;
}

module.exports = {
  resolveSiteAdapter,
};
