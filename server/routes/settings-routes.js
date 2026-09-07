const express = require('express');

function createSettingsRouter({ db, getRunningTaskIds } = {}) {
  if (!db) throw new Error('db is required');
  if (typeof getRunningTaskIds !== 'function') throw new Error('getRunningTaskIds is required');

  const router = express.Router();

  router.get('/scheduler', (req, res) => {
    res.json({
      data: {
        allowParallel: db.isTaskParallelAllowed(),
        runningTaskIds: getRunningTaskIds(),
      },
    });
  });

  router.post('/scheduler', (req, res) => {
    try {
      const body = req.body || {};
      const updated = db.setTaskParallelAllowed(Boolean(body.allowParallel));
      console.log(`[scheduler] allowParallel=${updated ? '1' : '0'}`);
      res.json({
        data: {
          allowParallel: updated,
          runningTaskIds: getRunningTaskIds(),
        },
      });
    } catch (error) {
      res.status(400).json({ message: error.message || 'Failed to save scheduler settings' });
    }
  });

  return router;
}

module.exports = { createSettingsRouter };
