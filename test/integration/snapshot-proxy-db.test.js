const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '../..');

// Regression test for the 2026-11-05 restore crash loop: proxy upstream URLs
// live in a separate proxy-manager.db, while their encryption key lives in
// app.db's app_settings. Snapshots used to pack only app.db + tasks/ +
// .master_key, so a cross-machine restore swapped the key but left the old
// proxy db behind — startup verification then failed GCM auth and the panel
// crash-looped (Restart=always) with port 3210 never listening.
// A snapshot must therefore carry proxy-manager.db, and a restore must swap
// it together with app.db. An old snapshot without it must archive the local
// proxy db away, leaving a clean "no proxies" state instead of a stale,
// wrong-key database.
test('snapshot carries proxy-manager.db and restore swaps it with app.db', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-snapproxy-'));
  try {
    const script = String.raw`
      (async () => {
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const os = require('node:os');
        const path = require('node:path');
        const { spawnSync } = require('node:child_process');
        const Database = require('better-sqlite3');

        const runtimeRoot = process.env.PANEL_RUNTIME_ROOT;
        const config = require('./config');
        const db = require('./server/db');
        const { createProxyCrypto } = require('./server/proxy-manager/proxy-crypto');
        const { createSnapshot, restoreSnapshot } = require('./server/cloud/snapshot');
        const { swapDataDir } = require('./server/cloud/backup-service');

        const KEY_SETTING = 'proxy_manager_encryption_key';
        const PROXY_URI = 'socks5://user:pass@127.0.0.1:1080';
        const KEY1 = 'snapshot-key-0123456789abcdef';
        const KEY2 = 'local-key-0123456789abcdef';
        const proxyDbPath = path.join(config.paths.dataDir, 'proxy-manager.db');

        function writeProxyDb(dbPath, key, uri) {
          fs.mkdirSync(path.dirname(dbPath), { recursive: true });
          const pdb = new Database(dbPath);
          try {
            pdb.pragma('journal_mode = WAL');
            pdb.exec('CREATE TABLE IF NOT EXISTS proxies (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, uri TEXT NOT NULL, local_port INTEGER NOT NULL UNIQUE, is_running INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
            pdb.prepare('DELETE FROM proxies').run();
            pdb.prepare('INSERT INTO proxies (name, uri, local_port) VALUES (?, ?, ?)').run('node-1', createProxyCrypto(key).encrypt(uri), 19001);
          } finally {
            pdb.close();
          }
        }
        function readProxyUri(dbPath, key) {
          const pdb = new Database(dbPath, { readonly: true });
          try {
            const row = pdb.prepare('SELECT uri FROM proxies ORDER BY id DESC LIMIT 1').get();
            return row ? createProxyCrypto(key).decrypt(row.uri) : null;
          } finally {
            pdb.close();
          }
        }

        fs.mkdirSync(config.paths.tasksDir, { recursive: true });

        // 1) Live state: app.db key KEY1 + proxy db encrypted with KEY1.
        db.setSetting(KEY_SETTING, KEY1);
        writeProxyDb(proxyDbPath, KEY1, PROXY_URI);

        // 2) createSnapshot packs proxy-manager.db and lists it in the manifest.
        const outPath = path.join(runtimeRoot, 'snap.bpsnap');
        const created = await createSnapshot({ outPath, passphrase: 'test-passphrase-123' });
        assert.ok(created.manifest.includes.includes('proxy-manager.db'),
          'manifest missing proxy-manager.db: ' + JSON.stringify(created.manifest.includes));

        // 3) restoreSnapshot unpacks it and the staged copy decrypts with KEY1.
        const restored = await restoreSnapshot({ filePath: outPath, passphrase: 'test-passphrase-123' });
        try {
          const tarList = spawnSync('tar', ['-tzf', path.join(restored.stagingRoot, 'snapshot.tar.gz')], { encoding: 'utf8' });
          assert.ok(tarList.stdout.split('\n').some((l) => l.trim() === './proxy-manager.db' || l.trim() === 'proxy-manager.db'),
            'tar missing proxy-manager.db:\n' + tarList.stdout);
          const stagedProxyDb = path.join(restored.stagingDir, 'proxy-manager.db');
          assert.ok(fs.existsSync(stagedProxyDb), 'staged proxy-manager.db missing');
          assert.equal(readProxyUri(stagedProxyDb, KEY1), PROXY_URI, 'staged proxy db must decrypt with the snapshot key');
        } finally {
          // Keep the staging dir: it becomes the swap input below.
        }

        // 4) Simulate the crashed state: local proxy db + key now belong to
        // another machine (KEY2). Swapping the staged content must install
        // the KEY1 proxy db and archive the KEY2 one into pre-restore.
        db.setSetting(KEY_SETTING, KEY2);
        writeProxyDb(proxyDbPath, KEY2, 'socks5://other:other@127.0.0.1:1081');
        const preRestore = swapDataDir(restored.stagingDir);
        fs.rmSync(restored.stagingRoot, { recursive: true, force: true });
        assert.equal(readProxyUri(proxyDbPath, KEY1), PROXY_URI, 'live proxy db must decrypt with the restored key');
        assert.equal(readProxyUri(path.join(preRestore, 'proxy-manager.db'), KEY2), 'socks5://other:other@127.0.0.1:1081', 'old proxy db must be archived to pre-restore');

        // 5) Old snapshot without a proxy db: swap must archive the local
        // proxy db away and leave none behind (clean "no proxies" state,
        // never a stale wrong-key database that crash-loops startup).
        const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-swap-noproxy-'));
        try {
          await db.db.backup(path.join(staging, 'app.db'));
          fs.mkdirSync(path.join(staging, 'tasks'), { recursive: true });
          swapDataDir(staging);
          assert.ok(!fs.existsSync(proxyDbPath), 'local proxy db must not survive a restore whose snapshot has none');
        } finally {
          fs.rmSync(staging, { recursive: true, force: true });
        }

        console.log('SNAPPROXY-OK');
      })().catch((e) => { console.error('SNAPPROXY-FAIL', e); process.exit(1); });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: projectRoot,
      env: { ...process.env, PANEL_RUNTIME_ROOT: runtimeRoot },
      encoding: 'utf8',
      timeout: 120000,
    });
    assert.ok(
      result.status === 0 && /SNAPPROXY-OK/.test(result.stdout),
      `snapshot proxy-db subprocess failed:\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    );
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
