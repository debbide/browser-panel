'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const ENCRYPTED_PREFIX = 'enc:v1:';

function isPortConflict(error) {
  return Boolean(error)
    && String(error.code || '').startsWith('SQLITE_CONSTRAINT')
    && /local_port/i.test(String(error.message || ''));
}

class ProxyDatabase {
  constructor(databasePath, proxyCrypto) {
    const resolvedPath = path.resolve(databasePath);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.proxyCrypto = proxyCrypto;
    this.initialize();
    this.migrateProxyUris();
  }

  migrateProxyUris() {
    if (!this.proxyCrypto) return;
    const update = this.db.prepare('UPDATE proxies SET uri = ? WHERE id = ?');
    const migrate = this.db.transaction(() => {
      for (const proxy of this.db.prepare('SELECT id, uri FROM proxies').all()) {
        if (!this.proxyCrypto.isEncrypted(proxy.uri)) {
          update.run(this.proxyCrypto.encrypt(proxy.uri), proxy.id);
        }
      }
    });
    migrate();
  }

  // Fails loudly when the encryption key no longer matches the stored data,
  // instead of letting every later request fail with an opaque crypto error.
  verifyEncryptionKey() {
    if (!this.proxyCrypto) return;
    const encrypted = this.db.prepare(
      `SELECT id FROM proxies WHERE uri LIKE '${ENCRYPTED_PREFIX}%' LIMIT 1`
    ).get();
    if (!encrypted) return;
    this.getProxy(encrypted.id);
  }

  hydrateProxy(proxy) {
    if (!proxy || !this.proxyCrypto) return proxy;
    return { ...proxy, uri: this.proxyCrypto.decrypt(proxy.uri) };
  }

  initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS proxies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        uri TEXT NOT NULL,
        local_port INTEGER NOT NULL UNIQUE,
        is_running INTEGER NOT NULL DEFAULT 0 CHECK (is_running IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  listProxies() {
    return this.db.prepare('SELECT * FROM proxies ORDER BY id DESC').all().map((proxy) => this.hydrateProxy(proxy));
  }

  listRunningProxies() {
    return this.db.prepare('SELECT * FROM proxies WHERE is_running = 1 ORDER BY id').all().map((proxy) => this.hydrateProxy(proxy));
  }

  getProxy(id) {
    return this.hydrateProxy(this.db.prepare('SELECT * FROM proxies WHERE id = ?').get(id));
  }

  getUsedPorts() {
    return new Set(this.db.prepare('SELECT local_port FROM proxies').all().map((row) => row.local_port));
  }

  getPortConflicts() {
    return this.db.prepare(
      'SELECT local_port, COUNT(*) AS count FROM proxies GROUP BY local_port HAVING count > 1'
    ).all();
  }

  createProxy({ name, uri, localPort }) {
    const result = this.db.prepare(
      'INSERT INTO proxies (name, uri, local_port, is_running) VALUES (?, ?, ?, 0)'
    ).run(name, this.proxyCrypto ? this.proxyCrypto.encrypt(uri) : uri, localPort);
    return this.getProxy(result.lastInsertRowid);
  }

  setRunning(id, isRunning) {
    this.db.prepare('UPDATE proxies SET is_running = ? WHERE id = ?').run(isRunning ? 1 : 0, id);
    return this.getProxy(id);
  }

  updateName(id, name) {
    this.db.prepare('UPDATE proxies SET name = ? WHERE id = ?').run(name, id);
    return this.getProxy(id);
  }

  deleteProxy(id) {
    return this.db.prepare('DELETE FROM proxies WHERE id = ?').run(id).changes > 0;
  }

  close() {
    this.db.close();
  }
}

module.exports = { ProxyDatabase, isPortConflict };
