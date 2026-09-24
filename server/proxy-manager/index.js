'use strict';

// Integration layer that embeds the standalone Proxy Manager
// (E:\ck\ProxyManager) into the panel.
//
// Everything below the adapter is the original project code, copied verbatim:
//   database.js     -> ProxyDatabase (encrypted upstream storage)
//   port-manager.js -> PortManager (proxy-chain + VLESS listeners, port pool)
//   proxy-crypto.js -> AES-256-GCM at-rest encryption for upstream URLs
//   vless/*         -> native VLESS-over-WebSocket-over-TLS client
//
// What this file replaces is only Proxy Manager's *shell*: its own JWT login,
// its own HTTP server and its self-updater. Inside the panel those are already
// provided, so the API is mounted behind the panel's own session auth instead.
//
// Two deliberate isolation choices:
//   * a separate SQLite file, so the `proxies` table can never collide with the
//     panel schema and the encryption key stays independent;
//   * the encryption key lives in the panel's app_settings, generated once.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

const { ProxyDatabase } = require('./database');
const { PortManager, parseProxyUri, sanitizeProxy, normalizeNodeName, validateUpstreamAllowlist } = require('./port-manager');
const { createProxyCrypto } = require('./proxy-crypto');
const { parseVlessLink, isVlessLink } = require('./vless/link');
const { badRequest, notFound, serviceUnavailable } = require('./http-error');

const ENCRYPTION_KEY_SETTING = 'proxy_manager_encryption_key';

// Port Manager's validation helpers throw plain Errors carrying client-facing
// Chinese messages; this tags them as safe 400s, exactly like the original
// server.js did, without changing behaviour for direct callers.
function validate(run) {
  try {
    return run();
  } catch (error) {
    if (error.statusCode) throw error;
    throw badRequest(error.message);
  }
}

// Mirrors Proxy Manager's parseProxyInput: accepts a pasted link with optional
// leading label, normalizes socks:// to socks5:// and derives a default name.
function parseProxyInput(input, fallbackName = '') {
  const value = typeof input === 'string' ? input.trim() : '';
  const match = value.match(/(?:^|\s)((?:https?|socks|socks5|socks5h|vless):\/\/\S+)/i);
  if (!match) {
    throw new Error('请输入包含 http、https、socks、socks5、socks5h 或 vless 协议的代理地址');
  }

  const uri = match[1].replace(/^socks:\/\//i, 'socks5://');
  parseProxyUri(uri);
  const suppliedName = value.replace(match[0], ' ').trim() || String(fallbackName || '').trim();
  const generatedName = isVlessLink(uri)
    ? (parseVlessLink(uri).name || `节点-${Math.random().toString(36).slice(2, 7).toUpperCase()}`)
    : `节点-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  return { name: normalizeNodeName(suppliedName || generatedName), uri };
}

function parseProxyId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function resolveEncryptionKey(db) {
  let key = db.getSetting(ENCRYPTION_KEY_SETTING);
  if (!key || key.length < 16) {
    key = crypto.randomBytes(32).toString('base64url');
    db.setSetting(ENCRYPTION_KEY_SETTING, key);
  }
  return key;
}

/**
 * Builds the embedded Proxy Manager runtime: database, port manager and router.
 * Returns `{ router, portManager, database, close }`.
 */
function createProxyManager({ panelDb, dataDir, host = '127.0.0.1' }) {
  const databasePath = path.join(dataDir, 'proxy-manager.db');
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  const proxyCrypto = createProxyCrypto(resolveEncryptionKey(panelDb));
  const database = new ProxyDatabase(databasePath, proxyCrypto);
  // Fails loudly when the stored key no longer matches the data, instead of
  // letting every later request fail with an opaque crypto error.
  database.verifyEncryptionKey();

  const portManager = new PortManager({
    database,
    host,
    getSetting: (key) => panelDb.getSetting(key),
  });

  const router = express.Router();

  router.get('/proxies', (req, res) => {
    res.json(database.listProxies().map(sanitizeProxy));
  });

  // 上游白名单（SSRF 防护）：默认拒绝内网/回环/link-local 上游，如确需内网
  // 上游，在此显式放行。逗号分隔，支持域名、IP、IPv4 CIDR；默认空。
  router.get('/settings/upstream-allowlist', (req, res) => {
    res.json({ allowlist: panelDb.getSetting('proxy_upstream_allowlist') || '' });
  });

  router.put('/settings/upstream-allowlist', (req, res, next) => {
    try {
      const normalized = validate(() => validateUpstreamAllowlist(req.body && req.body.allowlist));
      panelDb.setSetting('proxy_upstream_allowlist', normalized || null);
      return res.json({ allowlist: panelDb.getSetting('proxy_upstream_allowlist') || '' });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/proxies', async (req, res, next) => {
    try {
      const legacyUri = typeof req.body?.uri === 'string' ? req.body.uri.trim() : '';
      const input = typeof req.body?.input === 'string' ? req.body.input : legacyUri;
      const fallbackName = typeof req.body?.name === 'string' ? req.body.name : '';
      const { name, uri } = validate(() => parseProxyInput(input, fallbackName));
      // reservePort writes the row itself, so the UNIQUE constraint arbitrates
      // concurrent allocations instead of a check-then-insert race.
      const proxy = await portManager.reservePort({ name, uri });
      if (!proxy) throw serviceUnavailable('没有可分配的本地端口');
      return res.status(201).json(sanitizeProxy(proxy));
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/proxies/:id', (req, res, next) => {
    try {
      const id = parseProxyId(req.params.id);
      const proxy = id ? database.getProxy(id) : null;
      if (!proxy) throw notFound('代理不存在');
      const name = validate(() => normalizeNodeName(req.body?.name));
      return res.json(sanitizeProxy(database.updateName(id, name)));
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/proxies/:id', async (req, res, next) => {
    try {
      const id = parseProxyId(req.params.id);
      const proxy = id ? database.getProxy(id) : null;
      if (!proxy) throw notFound('代理不存在');
      if (proxy.is_running || portManager.servers.has(proxy.id)) {
        await portManager.stop(proxy);
      }
      database.deleteProxy(proxy.id);
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  router.post('/toggle-port', async (req, res, next) => {
    try {
      const id = parseProxyId(req.body?.id);
      const proxy = id ? database.getProxy(id) : null;
      if (!proxy) throw notFound('代理不存在');
      const updated = proxy.is_running
        ? await portManager.stop(proxy)
        : await portManager.start(proxy);
      return res.json(sanitizeProxy(updated));
    } catch (error) {
      return next(error);
    }
  });

  router.post('/test-proxy', async (req, res, next) => {
    try {
      const id = parseProxyId(req.body?.id);
      const proxy = id ? database.getProxy(id) : null;
      const uri = proxy?.uri || (typeof req.body?.uri === 'string' ? req.body.uri.trim() : '');
      if (!uri) throw badRequest('必须提供代理 id 或 uri');
      const result = await portManager.testProxy(uri, 'https://api.ipify.org?format=json', 15000);
      return res.json(result);
    } catch (error) {
      return next(error);
    }
  });

  // Unknown routes must 404 as JSON rather than falling through to the panel's
  // SPA catch-all, which would answer with index.html and hide client mistakes.
  router.use((req, res) => {
    res.status(404).json({ error: '接口不存在' });
  });

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const statusCode = Number.isInteger(error.statusCode) && error.statusCode >= 400
      ? error.statusCode
      : 500;
    const safeMessage = error.safeMessage === true || (statusCode < 500 && error.safeMessage !== false);
    if (statusCode >= 500 && !safeMessage) console.error('[proxy-manager] request failed:', error);
    const message = safeMessage
      ? (error.message || '请求处理失败')
      : (statusCode >= 500 ? '服务器内部错误' : '请求内容无效');
    return res.status(statusCode).json({ error: message });
  });

  return {
    router,
    database,
    portManager,
    async restore() {
      const results = await portManager.restore();
      for (const item of results.filter((entry) => !entry.restored)) {
        console.error(`[proxy-manager] restore ${item.id} failed: ${item.error}`);
      }
      return results;
    },
    async close() {
      await portManager.closeAll();
      database.close();
    },
  };
}

module.exports = { createProxyManager, parseProxyInput, parseProxyId };
