const express = require('express');

function createTaskGroupRouter(db) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json({ data: db.listTaskGroups() });
  });

  router.post('/', (req, res) => {
    try {
      res.json({ data: db.createTaskGroup((req.body || {}).name) });
    } catch (error) {
      res.status(400).json({ message: error.message || 'Failed to create task group' });
    }
  });

  router.put('/order', (req, res) => {
    try {
      res.json({ data: db.updateTaskGroupOrder((req.body || {}).ids) });
    } catch (error) {
      res.status(400).json({ message: error.message || 'Failed to reorder task groups' });
    }
  });

  router.put('/:id', (req, res) => {
    try {
      const group = db.updateTaskGroup(Number(req.params.id), (req.body || {}).name);
      if (!group) return res.status(404).json({ message: 'Task group not found' });
      res.json({ data: group });
    } catch (error) {
      res.status(400).json({ message: error.message || 'Failed to update task group' });
    }
  });

  router.delete('/:id', (req, res) => {
    try {
      const group = db.deleteTaskGroup(Number(req.params.id));
      if (!group) return res.status(404).json({ message: 'Task group not found' });
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ message: error.message || 'Failed to delete task group' });
    }
  });

  return router;
}

module.exports = { createTaskGroupRouter };
