const express = require('express');

const auth = require('../auth');

function createSettingsRouter({ db, getRunningTaskIds } = {}) {
  if (!db) throw new Error('db is required');
  if (typeof getRunningTaskIds !== 'function') throw new Error('getRunningTaskIds is required');

  const router = express.Router();

  // 安全设置：登录限流取客户端 IP 时信任的上游反向代理（逗号分隔的 IP / IPv4 CIDR）。
  // 默认空 = 不信任任何代理，直接取 TCP 对端地址，伪造的 X-Forwarded-For 会被忽略。
  router.get('/security', (req, res) => {
    res.json({
      data: {
        trustProxy: db.getSetting('security_trust_proxy') || '',
      },
    });
  });

  router.post('/security', (req, res) => {
    try {
      const trustProxy = auth.validateTrustProxyValue((req.body || {}).trustProxy);
      db.setSetting('security_trust_proxy', trustProxy || null);
      auth.refreshTrustProxyCache();
      res.json({
        data: {
          trustProxy: db.getSetting('security_trust_proxy') || '',
        },
      });
    } catch (error) {
      res.status(400).json({ message: error.message || '保存安全设置失败' });
    }
  });

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
