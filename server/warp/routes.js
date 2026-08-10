const express = require('express');
const { manager, cleanError } = require('./manager');

function statusForError(error) {
  if (['operation_in_progress', 'active_warp_sessions'].includes(error && error.code)) return 409;
  if (error && error.code === 'warp_not_ready') return 409;
  return 400;
}

function createWarpRouter(warpManager = manager) {
  const router = express.Router();

  router.get('/status', (req, res) => {
    res.json({ data: warpManager.status() });
  });

  router.get('/settings', (req, res) => {
    res.json({ data: warpManager.status().policy });
  });

  router.put('/settings', (req, res) => {
    try {
      res.json({ data: warpManager.updateSettings(req.body || {}) });
    } catch (error) {
      const safe = cleanError(error);
      res.status(statusForError(error)).json({ message: safe.message, code: safe.code });
    }
  });

  const operation = (method) => (req, res) => {
    try {
      const job = warpManager[method]();
      res.status(202).json({ data: job, jobId: job.id });
    } catch (error) {
      const safe = cleanError(error);
      res.status(statusForError(error)).json({ message: safe.message, code: safe.code });
    }
  };

  router.post('/enable', operation('enable'));
  router.post('/disable', operation('disable'));
  router.post('/probe', operation('probeNow'));
  router.post('/reconnect', operation('reconnect'));
  router.post('/rotate', operation('rotate'));

  router.get('/jobs/:id', (req, res) => {
    const job = warpManager.getJob(Number(req.params.id));
    if (!job) {
      res.status(404).json({ message: 'WARP job not found', code: 'job_not_found' });
      return;
    }
    res.json({ data: job });
  });

  return router;
}

module.exports = { createWarpRouter, statusForError };
