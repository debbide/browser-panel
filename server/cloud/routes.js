/**
 * 云端备份 HTTP 路由。挂在 requireAuth 下方（server/index.js 统一鉴权）。
 *
 * 快照里含全部密钥（代理凭据、面板账号、WARP），所以这些接口绝不能暴露在
 * 鉴权之外 —— 与 /api/warp 同级，都在 app.use(requireAuth) 之后注册。
 *
 * 错误码约定（对齐 warp/routes.js）：
 *   operation_in_progress → 409  一次只允许一个备份/恢复在跑
 *   其余 → 400
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const db = require('../db');
const backupService = require('./backup-service');

// accessKey 也按密钥处理：设置视图里它和 secretKey 一样被遮蔽，传空 = 保持原值。
// 否则前端保存时总带空 accessKey 会把已存的 Key 抹掉。
const SECRET_FIELDS = ['accessKey', 'secretKey', 'token', 'passphrase'];

function statusForError(error) {
  if (error && error.code === 'operation_in_progress') return 409;
  return 400;
}

/** 传空 = 保持原值，只有给新值才覆盖 —— 防止误提交把密钥清掉。 */
function resolveSecretValue(incomingValue, existingValue) {
  const value = String(incomingValue || '').trim();
  if (value) return value;
  return existingValue || null;
}

function maskSecret(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= 8) return `${text.slice(0, 2)}***`;
  return `${text.slice(0, 4)}***${text.slice(-4)}`;
}

/** 给前端的设置视图：密钥一律遮蔽，只暴露「是否已设置」。 */
function toPublicSettings(raw) {
  return {
    enabled: raw.enabled,
    endpoint: raw.endpoint,
    region: raw.region,
    bucket: raw.bucket,
    hasAccessKey: Boolean(raw.accessKey),
    accessKeyMasked: maskSecret(raw.accessKey),
    hasSecretKey: Boolean(raw.secretKey),
    secretKeyMasked: maskSecret(raw.secretKey),
    hasToken: Boolean(raw.token),
    tokenMasked: maskSecret(raw.token),
    proxy: raw.proxy,
    pathStyle: raw.pathStyle,
    prefix: raw.prefix,
    retention: raw.retention,
    schedule: raw.schedule,
    hour: raw.hour,
    minute: raw.minute,
    nextAt: raw.nextAt,
    hasPassphrase: Boolean(raw.passphrase),
  };
}

function createCloudBackupRouter(service = backupService) {
  const router = express.Router();

  // 设置读取
  router.get('/settings', (req, res) => {
    try {
      const raw = db.getS3BackupSettings();
      res.json({ data: toPublicSettings(raw) });
    } catch (error) {
      res.status(400).json({ message: error.message || '读取云端备份设置失败' });
    }
  });

  // 设置保存。密钥字段（secretKey/token/passphrase）传空 = 保持原值。
  router.post('/settings', (req, res) => {
    try {
      const body = req.body || {};
      const raw = db.getS3BackupSettings();

      const patch = {};
      const FIELDS = [
        'enabled', 'endpoint', 'region', 'bucket', 'accessKey', 'secretKey',
        'token', 'proxy', 'pathStyle', 'prefix', 'retention', 'schedule',
        'hour', 'minute', 'passphrase',
      ];
      for (const field of FIELDS) {
        if (body[field] === undefined) continue;
        patch[field] = SECRET_FIELDS.includes(field)
          ? resolveSecretValue(body[field], raw[field])
          : body[field];
      }

      if (patch.enabled !== undefined) patch.enabled = Boolean(patch.enabled);
      if (patch.pathStyle !== undefined) patch.pathStyle = Boolean(patch.pathStyle);
      if (patch.retention !== undefined) {
        const n = Number(patch.retention);
        patch.retention = Number.isFinite(n) ? n : undefined;
        if (patch.retention === undefined) delete patch.retention;
      }

      const saved = db.setS3BackupSettings(patch);
      // 改了启用状态/时间窗后立刻重算下次自动备份时间
      try {
        service.ensureScheduled();
      } catch (error) {
        console.error('[cloud-backup] ensureScheduled:', error.message);
      }
      res.json({ data: toPublicSettings(saved) });
    } catch (error) {
      res.status(statusForError(error)).json({ message: error.message || '保存云端备份设置失败' });
    }
  });

  // 测试连接：写入并删除一个探针对象
  router.post('/test', async (req, res) => {
    try {
      const result = await service.testConnection();
      res.json(result);
    } catch (error) {
      res.status(statusForError(error)).json({ message: error.message || '测试连接失败' });
    }
  });

  // 立即手动备份，label 是用户起的自定义名称（object key 文件名的一部分）
  router.post('/run', async (req, res) => {
    try {
      const label = String((req.body || {}).label || '').trim();
      const result = await service.runCloudBackup('manual', { label });
      res.json({ data: result });
    } catch (error) {
      res.status(statusForError(error)).json({ message: error.message || '备份失败' });
    }
  });

  // 远端备份列表
  router.get('/list', async (req, res) => {
    try {
      const items = await service.listRemoteBackups();
      res.json({ data: items });
    } catch (error) {
      res.status(statusForError(error)).json({ message: error.message || '获取备份列表失败' });
    }
  });

  // 预览某份快照的 manifest（不落盘、不动库）
  router.post('/preview', async (req, res) => {
    try {
      const key = String((req.body || {}).key || '').trim();
      if (!key) {
        res.status(400).json({ message: '缺少 key 参数' });
        return;
      }
      const result = await service.previewRemoteBackup(key);
      res.json({ data: result });
    } catch (error) {
      res.status(statusForError(error)).json({ message: error.message || '预览备份失败' });
    }
  });

  // 恢复某份远端快照。成功返回后进程即将重启（systemd 或手动）。
  router.post('/restore', async (req, res) => {
    try {
      const key = String((req.body || {}).key || '').trim();
      if (!key) {
        res.status(400).json({ message: '缺少 key 参数' });
        return;
      }
      const result = await service.restoreFromRemote(key);
      res.json({ data: result });
    } catch (error) {
      res.status(statusForError(error)).json({ message: error.message || '恢复失败' });
    }
  });

  // 手动上传 .bpsnap 快照恢复（不经 S3，适用于本地已有文件 / 换机还原）。
  // body 是原始文件字节（application/octet-stream），密码走请求头 —— 快照是加密的，
  // 不用设置页里存的那个密码，必须由用户现场提供。
  router.post('/restore-upload',
    express.raw({ type: 'application/octet-stream', limit: '256mb' }),
    async (req, res) => {
      try {
        const passphrase = String(req.get('x-backup-passphrase') || '').trim();
        if (!passphrase) {
          res.status(400).json({ message: '缺少备份密码（请求头 x-backup-passphrase）' });
          return;
        }
        const buffer = req.body;
        if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
          res.status(400).json({ message: '上传内容为空' });
          return;
        }
        const tmpPath = path.join(
          os.tmpdir(),
          `bpsnap-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bpsnap`,
        );
        try {
          fs.writeFileSync(tmpPath, buffer);
          const result = await service.restoreFromUpload(tmpPath, passphrase);
          res.json({ data: result });
        } finally {
          // 上传的明文临时文件立刻清掉
          try { fs.rmSync(tmpPath, { force: true }); } catch { /* 清理失败不阻塞 */ }
        }
      } catch (error) {
        res.status(statusForError(error)).json({ message: error.message || '恢复失败' });
      }
    });

  return router;
}

module.exports = { createCloudBackupRouter, statusForError };
