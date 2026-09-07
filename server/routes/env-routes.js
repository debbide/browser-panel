const express = require('express');

function createEnvRouter({ db, normalizeEnvEntriesPayload } = {}) {
  if (!db) throw new Error('db is required');
  if (typeof normalizeEnvEntriesPayload !== 'function') {
    throw new Error('normalizeEnvEntriesPayload is required');
  }

  const router = express.Router();

  router.get('/', (req, res) => {
    try {
      const scope = String(req.query.scope || 'global');
      const ownerId = req.query.owner_id !== undefined ? Number(req.query.owner_id) : null;
      const data = db.listEnvEntriesPublic(scope, ownerId);
      res.json({ data, githubCompat: db.isGithubCompatEnabled() });
    } catch (error) {
      res.status(400).json({ message: error.message || 'Failed to list env' });
    }
  });

  router.put('/', (req, res) => {
    try {
      const payload = req.body || {};
      const scope = String(payload.scope || 'global');
      const ownerId = payload.owner_id !== undefined ? payload.owner_id : null;
      const entries = normalizeEnvEntriesPayload(payload.env || payload.entries || []);
      const data = db.replaceEnvEntries(scope, ownerId, entries);
      if (scope === 'task' && ownerId) db.syncTaskParamsJsonFromEnv(Number(ownerId));
      if (payload.githubCompat !== undefined) {
        db.setGithubCompatEnabled(Boolean(payload.githubCompat));
      }
      res.json({ data, githubCompat: db.isGithubCompatEnabled() });
    } catch (error) {
      res.status(400).json({ message: error.message || 'Failed to save env' });
    }
  });

  return router;
}

module.exports = { createEnvRouter };
