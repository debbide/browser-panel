const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '../..');

// The master key file must travel with cloud snapshots: without it, a restore
// on another machine cannot decrypt the snapshotted database. No env vars.
test('snapshot includes .master_key and it decrypts the snapshotted data', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-snapkey-'));
  try {
    const script = String.raw`
      (async () => {
        const assert = require('node:assert/strict');
        const crypto = require('node:crypto');
        const fs = require('node:fs');
        const os = require('node:os');
        const path = require('node:path');
        const { spawnSync } = require('node:child_process');

        const runtimeRoot = process.env.PANEL_RUNTIME_ROOT;
        const config = require('./config');
        const db = require('./server/db');
        const { masterKeyFilePath, MASTER_KEY_FILE_NAME } = require('./server/secret-crypto');
        const { createSnapshot, restoreSnapshot } = require('./server/cloud/snapshot');
        const { swapDataDir } = require('./server/cloud/backup-service');

        fs.mkdirSync(config.paths.tasksDir, { recursive: true });

        // A secret encrypted with the auto-generated file key.
        db.setSecretSetting('telegram_bot_token', 'snap-secret-xyz');
        const liveKeyBefore = fs.readFileSync(masterKeyFilePath());
        assert.equal(liveKeyBefore.length, 32);

        // 1) createSnapshot packs .master_key (0600) and lists it in the manifest.
        const outPath = path.join(runtimeRoot, 'snap.bpsnap');
        const created = await createSnapshot({ outPath, passphrase: 'test-passphrase-123' });
        assert.ok(created.manifest.includes.includes(MASTER_KEY_FILE_NAME),
          'manifest missing .master_key: ' + JSON.stringify(created.manifest.includes));

        // 2) restoreSnapshot unpacks it with 0600 permissions.
        const restored = await restoreSnapshot({ filePath: outPath, passphrase: 'test-passphrase-123' });
        try {
          const tarList = spawnSync('tar', ['-tzf', path.join(restored.stagingRoot, 'snapshot.tar.gz')], { encoding: 'utf8' });
          assert.ok(tarList.stdout.split('\n').some((l) => l.trim() === './.master_key' || l.trim() === '.master_key'),
            'tar missing .master_key:\n' + tarList.stdout);
          const stagedKeyPath = path.join(restored.stagingDir, MASTER_KEY_FILE_NAME);
          const stagedKey = fs.readFileSync(stagedKeyPath);
          assert.equal(stagedKey.length, 32);
          assert.equal(fs.statSync(stagedKeyPath).mode & 0o777, 0o600, 'staged key must be 0600');
          assert.ok(stagedKey.equals(liveKeyBefore), 'staged key must match the live key');

          // 3) "new machine" check: the staged key alone decrypts the staged db.
          const Database = require('better-sqlite3');
          const sdb = new Database(path.join(restored.stagingDir, 'app.db'), { readonly: true });
          try {
            const row = sdb.prepare("SELECT value FROM app_settings WHERE key = 'telegram_bot_token'").get();
            assert.ok(String(row.value).startsWith('enc:v1:'), 'secret not encrypted in snapshot');
            const parts = String(row.value).slice('enc:v1:'.length).split('.');
            const decipher = crypto.createDecipheriv('aes-256-gcm', stagedKey, Buffer.from(parts[0], 'base64url'));
            decipher.setAuthTag(Buffer.from(parts[1], 'base64url'));
            const plain = Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')), decipher.final()]).toString('utf8');
            assert.equal(plain, 'snap-secret-xyz', 'staged key cannot decrypt snapshotted secret');
          } finally {
            sdb.close();
          }
        } finally {
          fs.rmSync(restored.stagingRoot, { recursive: true, force: true });
        }

        // 4) swapDataDir installs the staged key (normalized to 0600) and
        // rolls the old key back into pre-restore-*.
        const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-swap-'));
        try {
          await db.db.backup(path.join(staging, 'app.db'));
          fs.mkdirSync(path.join(staging, 'tasks'), { recursive: true });
          const newKey = crypto.randomBytes(32);
          fs.writeFileSync(path.join(staging, MASTER_KEY_FILE_NAME), newKey, { mode: 0o644 }); // wrong mode on purpose
          const preRestore = swapDataDir(staging);
          const liveKey = fs.readFileSync(masterKeyFilePath());
          assert.ok(liveKey.equals(newKey), 'live key was not replaced by the staged key');
          assert.equal(fs.statSync(masterKeyFilePath()).mode & 0o777, 0o600, 'live key must be 0600 after restore');
          const rolledBack = fs.readFileSync(path.join(preRestore, MASTER_KEY_FILE_NAME));
          assert.ok(rolledBack.equals(liveKeyBefore), 'old key was not rolled back to pre-restore dir');
        } finally {
          fs.rmSync(staging, { recursive: true, force: true });
        }

        console.log('SNAPKEY-OK');
      })().catch((e) => { console.error('SNAPKEY-FAIL', e); process.exit(1); });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: projectRoot,
      env: { ...process.env, PANEL_RUNTIME_ROOT: runtimeRoot },
      encoding: 'utf8',
      timeout: 120000,
    });
    assert.ok(
      result.status === 0 && /SNAPKEY-OK/.test(result.stdout),
      `snapshot master-key subprocess failed:\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    );
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
