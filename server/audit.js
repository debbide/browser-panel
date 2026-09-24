'use strict';
// P2 轻量审计：记录"谁在什么时候干了什么"，供事后追查。
//
// 约定（防 P0 S2/S3 重演）：
// - detail 只放动作名、ID、名称等非敏感字段，绝不放密钥/密码/token 明文；
//   需要表达"改了密钥"时只记布尔（如 token_changed: true）。
// - auditAction 永远不抛异常：审计失败只打日志，不能影响主流程。
const db = require('./db');

function auditAction(req, action, detail) {
  try {
    const actor = (req && req.panelUser && req.panelUser.username) || '';
    db.recordAudit(action, actor, detail || {});
  } catch (error) {
    console.error('[audit] 记录失败:', error && error.message);
  }
}

module.exports = { auditAction };
