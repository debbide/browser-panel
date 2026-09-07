const express = require('express');

function createConditionRouter({
  db,
  listConditionTypes,
  parseConditionJson,
  normalizeConditionPayload,
  evaluateTaskCondition,
  now = () => new Date(),
}) {
  const router = express.Router();

  router.get('/conditions/types', (req, res) => {
    res.json({ data: listConditionTypes() });
  });

  router.post('/tasks/:id/condition/test', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const task = db.getTask(id);
      if (!task) return res.status(404).json({ message: 'Task not found' });

      let evalTask = task;
      if (req.body && (req.body.condition || req.body.condition_json)) {
        const raw = req.body.condition || req.body.condition_json;
        const normalized = normalizeConditionPayload(
          typeof raw === 'string' ? parseConditionJson(raw) : raw
        );
        evalTask = { ...task, condition_enabled: 1, condition_json: JSON.stringify(normalized) };
      } else if (!Number(task.condition_enabled) && req.body && req.body.condition) {
        const normalized = normalizeConditionPayload(req.body.condition);
        evalTask = { ...task, condition_enabled: 1, condition_json: JSON.stringify(normalized) };
      }

      const result = await evaluateTaskCondition(evalTask);
      const testingSaved = !req.body?.condition && !req.body?.condition_json;
      if (testingSaved && Number(task.condition_enabled)) {
        db.updateTask(id, {
          ...task,
          condition_last_status: result.status || null,
          condition_last_detail: String(result.detail || '').slice(0, 500) || null,
          condition_last_checked_at: now().toISOString(),
        });
      }
      res.json({ data: result });
    } catch (error) {
      res.status(400).json({ message: error.message || 'Condition test failed' });
    }
  });

  return router;
}

module.exports = { createConditionRouter };
