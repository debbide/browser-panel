const express = require('express');
const { createSettingsRouter } = require('./settings-routes');
const { createEnvRouter } = require('./env-routes');

function normalizeEnvEntriesPayload(input) {
  if (!Array.isArray(input)) {
    throw new Error('env must be an array of {name, value, is_secret}');
  }
  return input.map((item) => ({
    name: item && item.name,
    value: item && item.value !== undefined ? item.value : '',
    is_secret: item && (item.is_secret === true || item.is_secret === 1 || item.is_secret === '1') ? 1 : 0,
  }));
}

function createSettingsEnvRouter({ db, getRunningTaskIds } = {}) {
  const router = express.Router();
  router.use('/api/settings', createSettingsRouter({ db, getRunningTaskIds }));
  router.use('/api/env', createEnvRouter({ db, normalizeEnvEntriesPayload }));
  return router;
}

module.exports = { createSettingsEnvRouter };
