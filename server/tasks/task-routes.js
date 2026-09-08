'use strict';

const express = require('express');

function createTaskRouter(taskService) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json({ data: taskService.list() });
  });

  router.post('/', (req, res) => {
    try {
      res.json({ data: taskService.create(req.body || {}) });
    } catch (error) {
      res.status(400).json({ message: error.message || 'Failed to save task' });
    }
  });

  router.put('/:id', (req, res) => {
    try {
      const task = taskService.update(Number(req.params.id), req.body || {});
      if (!task) return res.status(404).json({ message: 'Task not found' });
      res.json({ data: task });
    } catch (error) {
      res.status(400).json({ message: error.message || 'Failed to update task' });
    }
  });

  router.delete('/:id', (req, res) => {
    try {
      const result = taskService.remove(Number(req.params.id));
      if (result.reason === 'task_running') {
        return res.status(409).json({
          message: 'Task is currently running and cannot be deleted',
          code: 'task_running',
        });
      }
      if (!result.removed) {
        return res.status(404).json({ message: 'Task not found or already deleted' });
      }
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ message: error.message || 'Failed to delete task' });
    }
  });

  return router;
}

module.exports = { createTaskRouter };
