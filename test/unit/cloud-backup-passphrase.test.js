// Must be set before config/db are first required (fresh process per test file).
process.env.PANEL_RUNTIME_ROOT = require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'browser-panel-f7pw-')
);

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const db = require('../../server/db');
const { createCloudBackupRouter } = require('../../server/cloud/routes');

const app = express();
app.use(express.json());
// The router only needs ensureScheduled for the settings route.
app.use('/api/cloud-backup', createCloudBackupRouter({ ensureScheduled() {} }));

let server;
let base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/cloud-backup`;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
});

async function postSettings(body) {
  const res = await fetch(`${base}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('F7: saving a short new passphrase is rejected with 400', async () => {
  const { status, body } = await postSettings({ passphrase: 'short' });
  assert.equal(status, 400);
  assert.match(body.message || '', /12/);
  assert.equal(db.getS3BackupSettings().passphrase || '', '', 'short password must not be saved');
});

test('F7: a 12+ char passphrase saves; empty keeps the old one', async () => {
  const longPw = 'long-enough-passphrase-123';
  let r = await postSettings({ passphrase: longPw });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.hasPassphrase, true);
  assert.equal(db.getS3BackupSettings().passphrase, longPw);

  // Empty = keep existing (must not be treated as "new short password").
  r = await postSettings({ passphrase: '' });
  assert.equal(r.status, 200);
  assert.equal(db.getS3BackupSettings().passphrase, longPw);

  // Omitting the field also keeps the old value.
  r = await postSettings({ bucket: 'bkt' });
  assert.equal(r.status, 200);
  assert.equal(db.getS3BackupSettings().passphrase, longPw);
});

test('F7: exactly 11 chars is rejected, 12 chars is accepted', async () => {
  assert.equal((await postSettings({ passphrase: 'a'.repeat(11) })).status, 400);
  assert.equal((await postSettings({ passphrase: 'a'.repeat(12) })).status, 200);
  assert.equal(db.getS3BackupSettings().passphrase, 'a'.repeat(12));
});

test('F7: restore-upload accepts an old short passphrase (decrypt key, not a new password)', async () => {
  // 上传恢复的密码是待恢复快照的原密码：旧短密码必须仍能恢复，只警告不拦截。
  // 12 位强制只针对“新保存”的密码（POST /settings）。
  const seen = {};
  const stubService = {
    async restoreFromUpload(filePath, passphrase) {
      seen.passphrase = passphrase;
      seen.fileExists = require('node:fs').existsSync(filePath);
      return { ok: true, preRestoreDir: 'data/pre-restore-20200101000000', restartMode: 'manual' };
    },
  };
  const app2 = express();
  app2.use('/api/cloud-backup', createCloudBackupRouter(stubService));
  const server2 = app2.listen(0, '127.0.0.1');
  await new Promise((r) => server2.on('listening', r));
  try {
    const base2 = `http://127.0.0.1:${server2.address().port}/api/cloud-backup`;
    const res = await fetch(`${base2}/restore-upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'x-backup-passphrase': 'oldshort' },
      body: Buffer.from('fake-snapshot-bytes'),
    });
    const body = await res.json().catch(() => ({}));
    assert.equal(res.status, 200, `short restore passphrase must not be rejected, got ${res.status}: ${body.message}`);
    assert.equal(body.data && body.data.ok, true);
    assert.equal(seen.passphrase, 'oldshort', 'short passphrase must reach the service untouched');
    assert.equal(seen.fileExists, true, 'uploaded bytes must be staged for the service');

    // 空密码仍然 400。
    const res2 = await fetch(`${base2}/restore-upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('fake-snapshot-bytes'),
    });
    assert.equal(res2.status, 400);
  } finally {
    await new Promise((r) => server2.close(r));
  }
});
