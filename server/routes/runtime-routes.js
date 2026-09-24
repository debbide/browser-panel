'use strict';

const express = require('express');

function createRuntimeRouter(dependencies) {
  const {
    triggerTaskExecution,
    stopTask,
    listRunsByTask,
    listRuns,
  } = dependencies;
  const router = express.Router();

  router.post('/tasks/:id/run', async (req, res) => {
    try {
      const profileId = req.body && req.body.profile_id ? Number(req.body.profile_id) : null;
      // ?wait=1 keeps the legacy blocking semantics; default is 202 + runId.
      const wait = req.query && (req.query.wait === '1' || req.query.wait === 'true');
      const response = await triggerTaskExecution(Number(req.params.id), { profileId, wait });
      res.status(response.status).json(response.payload);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  });

  router.post('/tasks/:id/stop', (req, res) => {
    if (!stopTask(Number(req.params.id))) {
      return res.status(404).json({ message: 'No running task can be stopped right now' });
    }
    res.json({ ok: true, stopped: true });
  });

  router.get('/tasks/:id/runs', (req, res) => {
    res.json({ data: listRunsByTask(Number(req.params.id)) });
  });

  router.get('/runs', (req, res) => {
    res.json({ data: listRuns(100) });
  });

  return router;
}

module.exports = { createRuntimeRouter };
