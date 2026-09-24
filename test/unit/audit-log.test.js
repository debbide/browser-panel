const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../../server/db');
const { auditAction } = require('../../server/audit');

function uniqueAction(prefix) {
  return `test.${prefix}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
}

test('recordAudit/listAuditLog roundtrip, newest first', () => {
  const action = uniqueAction('roundtrip');
  db.recordAudit(action, 'tester', { id: 7, name: 'job' });
  const rows = db.listAuditLog(50);
  const found = rows.find((r) => r.action === action);
  assert.ok(found, 'recorded entry must be listed');
  assert.equal(found.actor, 'tester');
  assert.deepEqual(JSON.parse(found.detail), { id: 7, name: 'job' });
  assert.ok(found.created_at, 'created_at must be set');
  // newest-first ordering: our entry is at/near the head
  assert.ok(rows.indexOf(found) <= 2, 'audit log must be newest-first');
});

test('recordAudit truncates overlong fields', () => {
  const action = uniqueAction('truncate');
  db.recordAudit(action, 'u'.repeat(500), 'd'.repeat(5000));
  const found = db.listAuditLog(5000).find((r) => r.action === action);
  assert.ok(found);
  assert.ok(found.actor.length <= 120, `actor truncated, got ${found.actor.length}`);
  assert.ok(found.detail.length <= 2000, `detail truncated, got ${found.detail.length}`);
});

test('listAuditLog honors the limit and caps it', () => {
  const rows = db.listAuditLog(3);
  assert.ok(rows.length <= 3);
  const capped = db.listAuditLog(999999);
  assert.ok(capped.length <= 500);
});

test('auditAction extracts the actor from the session and never throws', () => {
  const action = uniqueAction('actor');
  auditAction({ panelUser: { username: '大哥' } }, action, { ok: 1 });
  const found = db.listAuditLog(50).find((r) => r.action === action);
  assert.ok(found);
  assert.equal(found.actor, '大哥');

  const action2 = uniqueAction('actorless');
  auditAction({}, action2, {});
  const found2 = db.listAuditLog(50).find((r) => r.action === action2);
  assert.ok(found2);
  assert.equal(found2.actor, '');

  // even a hostile req shape must not break the caller
  assert.doesNotThrow(() => auditAction(null, uniqueAction('nullreq'), {}));
});

test('P0 regression: secret values never reach auditAction call sites', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '../..');
  const files = [
    'server/routes/telegram-routes.js',
    'server/cloud/routes.js',
    'server/proxy-manager/index.js',
    'server/routes/browser-routes.js',
    'server/routes/task-storage-routes.js',
    'server/tasks/task-routes.js',
  ];
  for (const file of files) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    const calls = src.match(/auditAction\(req,[\s\S]*?\}\);/g) || [];
    assert.ok(calls.length > 0, `${file} should have auditAction call sites`);
    for (const call of calls) {
      // 只允许出现"字段名/是否变更"这类元信息，绝不允许出现密钥变量本身
      assert.ok(!/\bbotToken\b/.test(call), `${file}: botToken value must not be audited`);
    }
  }
  // telegram 设置审计必须只记 token_changed 布尔值
  const tgSrc = fs.readFileSync(path.join(root, 'server/routes/telegram-routes.js'), 'utf8');
  const tgCall = tgSrc.match(/auditAction\(req, 'settings.telegram.update', \{[\s\S]*?\}\);/);
  assert.ok(tgCall, 'telegram audit call site must exist');
  assert.ok(/token_changed/.test(tgCall[0]), 'must record token_changed flag');
});
