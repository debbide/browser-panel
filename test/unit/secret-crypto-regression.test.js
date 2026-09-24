const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '../..');

// S4: secrets are stored as versioned AES-256-GCM envelopes, never plaintext,
// once PANEL_MASTER_KEY is configured. Legacy plaintext stays readable and is
// lazily re-encrypted; without a master key, new secret writes are refused.
test('S4: secret at-rest encryption envelope and compat behavior', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-s4-'));
  try {
    const script = String.raw`
      (async () => {
        const assert = require('node:assert/strict');
        const MASTER = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
        const fail = (m) => { throw new Error(m); };

        // --- Part 1: no master key ---
        delete process.env.PANEL_MASTER_KEY;
        const crypto1 = require('./server/secret-crypto');
        assert.equal(crypto1.describeMasterKey().state, 'missing');
        assert.equal(crypto1.isEncryptedEnvelope('plain'), false);
        assert.equal(crypto1.decryptSecret('plain-legacy'), 'plain-legacy');
        assert.throws(() => crypto1.encryptSecret('x'), /PANEL_MASTER_KEY/);

        const db = require('./server/db');
        // Legacy plaintext stays readable without a key, and is NOT migrated.
        db.setSetting('telegram_bot_token', 'legacy-token-plain');
        assert.equal(db.getSecretSetting('telegram_bot_token'), 'legacy-token-plain');
        assert.equal(db.getSetting('telegram_bot_token'), 'legacy-token-plain');
        // New secret writes are refused instead of silently stored plaintext.
        assert.throws(() => db.setSecretSetting('telegram_bot_token', 'brand-new-token'), /PANEL_MASTER_KEY/);
        // Re-saving the unchanged legacy value is a no-op (unrelated edits keep working).
        assert.doesNotThrow(() => db.setSecretSetting('telegram_bot_token', 'legacy-token-plain'));
        // Clearing still works without a key.
        db.setSecretSetting('telegram_bot_token', '');
        assert.equal(db.getSetting('telegram_bot_token'), null);

        // --- Part 2: with master key ---
        process.env.PANEL_MASTER_KEY = MASTER;
        const crypto = require('./server/secret-crypto');
        assert.equal(crypto.describeMasterKey().state, 'ok');
        const env = crypto.encryptSecret('hello-secret');
        assert.ok(env.startsWith('enc:v1:'), 'envelope prefix, got: ' + env);
        assert.equal(crypto.decryptSecret(env), 'hello-secret');
        assert.throws(() => crypto.decryptSecret(env.slice(0, -4) + 'AAAA'), /./); // tampered
        process.env.PANEL_MASTER_KEY = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
        assert.throws(() => crypto.decryptSecret(env), /./); // wrong key
        process.env.PANEL_MASTER_KEY = MASTER;

        // Secret settings land encrypted on disk, read back plaintext.
        db.setSecretSetting('telegram_bot_token', 'bot-token-123');
        const rawToken = db.getSetting('telegram_bot_token');
        assert.ok(rawToken.startsWith('enc:v1:'), 'token not encrypted: ' + rawToken);
        assert.ok(!rawToken.includes('bot-token-123'));
        assert.equal(db.getSecretSetting('telegram_bot_token'), 'bot-token-123');
        assert.equal(db.getTelegramSettings().botToken, 'bot-token-123');
        // Non-secret settings are untouched.
        db.setSetting('telegram_chat_id', '42');
        assert.equal(db.getSetting('telegram_chat_id'), '42');

        // Legacy plaintext migrates lazily on read.
        db.setSetting('s3_backup_secret_key', 'legacy-s3-plain');
        assert.equal(db.getS3BackupSettings().secretKey, 'legacy-s3-plain');
        const migrated = db.getSetting('s3_backup_secret_key');
        assert.ok(migrated.startsWith('enc:v1:'), 'not migrated: ' + migrated);
        // Secret fields of setS3BackupSettings encrypt; plain fields do not.
        db.setS3BackupSettings({ endpoint: 'https://s3.test', secretKey: 'new-s3-key', proxy: 'http://u:p@h:8080' });
        assert.ok(db.getSetting('s3_backup_secret_key').startsWith('enc:v1:'));
        assert.ok(db.getSetting('s3_backup_proxy').startsWith('enc:v1:'));
        assert.equal(db.getSetting('s3_backup_endpoint'), 'https://s3.test');
        const s3 = db.getS3BackupSettings();
        assert.equal(s3.secretKey, 'new-s3-key');
        assert.equal(s3.proxy, 'http://u:p@h:8080');

        // TOTP secret round-trips encrypted.
        const user = db.createUser('s4user', 'hash');
        db.setUserTotpSecret(user.id, 'JBSWY3DPEHPK3PXP');
        const rawTotp = db.db.prepare('SELECT totp_secret FROM panel_users WHERE id = ?').get(user.id).totp_secret;
        assert.ok(String(rawTotp).startsWith('enc:v1:'), 'totp not encrypted');
        assert.equal(db.getUserTotpSecret(user.id), 'JBSWY3DPEHPK3PXP');

        // Task secret env values: encrypted at rest, plaintext at runtime.
        const taskId = db.db.prepare("INSERT INTO tasks (name, type, script_path) VALUES ('s4task', 'python', 'tasks/a.py')").run().lastInsertRowid;
        const task = { id: taskId };
        db.replaceEnvEntries('task', taskId, [
          { name: 'API_TOKEN', value: 'super-secret-value', is_secret: 1 },
          { name: 'PLAIN_VAR', value: 'visible', is_secret: 0 },
        ]);
        const rawRows = db.db.prepare("SELECT name, value FROM env_entries WHERE scope = 'task'").all();
        const tokenRow = rawRows.find((r) => r.name === 'API_TOKEN');
        assert.ok(tokenRow.value.startsWith('enc:v1:'), 'env secret not encrypted: ' + tokenRow.value);
        assert.ok(!tokenRow.value.includes('super-secret-value'));
        const plainRow = rawRows.find((r) => r.name === 'PLAIN_VAR');
        assert.equal(plainRow.value, 'visible');
        const envMap = db.getTaskEnvMap({ id: taskId });
        assert.equal(envMap.API_TOKEN, 'super-secret-value');
        assert.equal(envMap.PLAIN_VAR, 'visible');
        // Public listing still masks.
        const listed = db.listEnvEntriesPublic('task', taskId);
        const listedToken = listed.find((e) => e.name === 'API_TOKEN');
        assert.equal(listedToken.value, '');
        assert.ok(listedToken.valueMasked && !listedToken.valueMasked.includes('super-secret'));

        // Legacy plaintext env secret migrates on read.
        db.db.prepare("INSERT INTO env_entries (scope, owner_id, name, value, is_secret) VALUES ('task', ?, 'OLD_KEY', 'old-plain-secret', 1)").run(taskId);
        assert.equal(db.getTaskEnvMap({ id: taskId }).OLD_KEY, 'old-plain-secret');
        const migratedEnv = db.db.prepare("SELECT value FROM env_entries WHERE scope='task' AND name='OLD_KEY'").get().value;
        assert.ok(String(migratedEnv).startsWith('enc:v1:'), 'env not migrated');

        // Browser profile proxy_value: encrypted at rest, plaintext via getter.
        const profile = db.createBrowserProfile({ name: 's4prof', proxy_mode: 'launch', proxy_value: 'http://u:pw@proxy:8080' });
        const rawProfile = db.db.prepare('SELECT proxy_value FROM browser_profiles WHERE id = ?').get(profile.id).proxy_value;
        assert.ok(String(rawProfile).startsWith('enc:v1:'), 'profile proxy not encrypted');
        assert.equal(db.getBrowserProfile(profile.id).proxy_value, 'http://u:pw@proxy:8080');

        // Global proxy value setting.
        db.setBrowserRuntimeSettings({ proxyMode: 'launch', proxyValue: 'http://g:pw@gw:8080' });
        assert.ok(String(db.getSetting('browser_proxy_value')).startsWith('enc:v1:'));
        assert.equal(db.getBrowserRuntimeSettings().proxyValue, 'http://g:pw@gw:8080');

        console.log('S4-OK');
      })().catch((e) => { console.error('S4-FAIL', e); process.exit(1); });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: projectRoot,
      env: { ...process.env, PANEL_RUNTIME_ROOT: runtimeRoot },
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.ok(
      result.status === 0 && /S4-OK/.test(result.stdout),
      `S4 subprocess failed:\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    );
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
