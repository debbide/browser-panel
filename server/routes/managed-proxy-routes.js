const express = require('express');

function createManagedProxyRouter(manager) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json({ data: manager.list() });
  });

  router.post('/', (req, res) => {
    try {
      const proxy = manager.create(req.body || {});
      res.status(201).json({ data: proxy });
    } catch (error) {
      res.status(400).json({ message: error.message || 'Failed to create proxy' });
    }
  });

  router.post('/:id/start', async (req, res) => {
    try {
      const proxy = await manager.start(req.params.id);
      res.json({ data: proxy });
    } catch (error) {
      const status = manager.get(req.params.id) ? 400 : 404;
      res.status(status).json({ message: error.message || 'Failed to start proxy' });
    }
  });

  router.post('/:id/stop', async (req, res) => {
    try {
      const proxy = await manager.stop(req.params.id, { force: Boolean((req.body || {}).force) });
      res.json({ data: proxy });
    } catch (error) {
      const status = manager.get(req.params.id) ? 400 : 404;
      res.status(status).json({ message: error.message || 'Failed to stop proxy' });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const deleted = await manager.remove(req.params.id);
      if (!deleted) return res.status(404).json({ message: '代理不存在' });
      return res.json({ data: { deleted: true } });
    } catch (error) {
      return res.status(400).json({ message: error.message || 'Failed to delete proxy' });
    }
  });

  return router;
}

module.exports = { createManagedProxyRouter };
