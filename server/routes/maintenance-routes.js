'use strict';

const express = require('express');

function createMaintenanceRouter(dependencies) {
  const {
    backup,
    cleanupStorage,
    normalizeRetentionDays,
    normalizeCategories,
    db,
    getRunningTaskIds,
    reloadJobs,
    executeTask,
    emit,
    meta,
  } = dependencies;
  const router = express.Router();

  router.get('/storage/cleanup/preview', (req, res) => {
    try {
      const categories = req.query.categories
        ? normalizeCategories(String(req.query.categories).split(',').filter(Boolean))
        : undefined;
      const data = cleanupStorage(db, {
        dryRun: true,
        retentionDays: normalizeRetentionDays(req.query.retentionDays),
        categories,
        runningTaskIds: getRunningTaskIds(),
      });
      res.json({ data });
    } catch (error) {
      res.status(400).json({ message: error.message || '生成存储清理预览失败' });
    }
  });

  router.post('/storage/cleanup', (req, res) => {
    try {
      const body = req.body || {};
      const data = cleanupStorage(db, {
        dryRun: body.dryRun === true,
        retentionDays: normalizeRetentionDays(body.retentionDays),
        categories: normalizeCategories(body.categories),
        runningTaskIds: getRunningTaskIds(),
      });
      emit('runs', { cleanup: true });
      res.json({ data });
    } catch (error) {
      res.status(400).json({ message: error.message || '存储清理失败' });
    }
  });

  router.post('/backup/export', (req, res) => {
    try {
      const body = req.body || {};
      const passphrase = typeof body.passphrase === 'string' && body.passphrase.trim().length
        ? body.passphrase
        : null;
      const result = backup.exportBackup({
        taskIds: backup.normalizeTaskIds(body.task_ids),
        passphrase,
      });
      const exportDate = new Date();
      const filename = backup.buildExportFilename(exportDate, result.header);
      const fallbackFilename = backup.buildExportFilename(exportDate, {
        ...result.header,
        taskName: result.header.taskName ? 'task' : '',
      });
      res.setHeader('Content-Type', result.header.encrypted
        ? 'application/octet-stream'
        : 'application/json; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${fallbackFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      res.send(result.data);
    } catch (error) {
      res.status(400).json({ message: error.message || '导出备份失败' });
    }
  });

  router.post('/backup/preview', (req, res) => {
    try {
      const body = req.body || {};
      const parsed = backup.parseBackup(
        body.backup !== undefined ? body.backup : body,
        { passphrase: body.passphrase },
      );
      const plan = backup.analyze(parsed, {
        script_strategy: body.script_strategy,
        task_strategy: body.task_strategy,
      });
      res.json({ data: backup.toPreview(plan) });
    } catch (error) {
      res.status(400).json({ message: error.message || '解析备份文件失败' });
    }
  });

  router.post('/backup/import', (req, res) => {
    try {
      const body = req.body || {};
      const data = backup.importBackup(body.backup !== undefined ? body.backup : body, {
        script_strategy: body.script_strategy,
        task_strategy: body.task_strategy,
        passphrase: body.passphrase,
      });
      reloadJobs(executeTask);
      emit('tasks', { imported: true });
      res.json({ data });
    } catch (error) {
      res.status(400).json({ message: error.message || '导入备份失败' });
    }
  });

  router.get('/meta', (_req, res) => {
    res.json({ data: meta });
  });

  return router;
}

module.exports = { createMaintenanceRouter };
