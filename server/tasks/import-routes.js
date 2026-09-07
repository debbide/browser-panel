'use strict';

const express = require('express');

function createImportRouter({ scriptService }) {
  const router = express.Router();

  router.post('/scripts/import', (req, res) => {
    try {
      res.json({ data: scriptService.importScript(req.body || {}) });
    } catch (error) {
      res.status(error.status || 500).json({ message: error.message || 'Failed to save script' });
    }
  });

  return router;
}

module.exports = { createImportRouter };
