const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../../server/db');
const telegram = require('../../server/telegram');

const { notifyAutoBackupFailure } = telegram;

// Save/restore raw setting values so the dev DB is untouched afterwards.
function snapshotTelegramSettings() {
  return {
    token: db.getSetting('telegram_bot_token'),
    chatId: db.getSetting('telegram_chat_id'),
    mode: db.getSetting('telegram_notify_mode'),
  };
}

function restoreTelegramSettings(prev) {
  db.setSetting('telegram_bot_token', prev.token);
  db.setSetting('telegram_chat_id', prev.chatId);
  db.setSetting('telegram_notify_mode', prev.mode);
}

function clearTelegramSettings() {
  db.setSetting('telegram_bot_token', null);
  db.setSetting('telegram_chat_id', null);
}

function configureTelegram() {
  db.setSecretSetting('telegram_bot_token', 'test-bot-token');
  db.setSetting('telegram_chat_id', '12345');
}

test('unconfigured Telegram: silently skip, sender never called', async () => {
  const prev = snapshotTelegramSettings();
  clearTelegramSettings();
  try {
    let called = 0;
    const ok = await notifyAutoBackupFailure(new Error('boom'), async () => { called++; });
    assert.equal(ok, false);
    assert.equal(called, 0, 'must not attempt to send without configuration');
  } finally {
    restoreTelegramSettings(prev);
  }
});

test('notify mode off: skip even when configured', async () => {
  const prev = snapshotTelegramSettings();
  configureTelegram();
  db.setSetting('telegram_notify_mode', 'off');
  try {
    let called = 0;
    const ok = await notifyAutoBackupFailure(new Error('boom'), async () => { called++; });
    assert.equal(ok, false);
    assert.equal(called, 0);
  } finally {
    restoreTelegramSettings(prev);
  }
});

test('configured: sends an alert reusing the normal channel, error HTML-escaped', async () => {
  const prev = snapshotTelegramSettings();
  configureTelegram();
  db.setSetting('telegram_notify_mode', null);
  try {
    const calls = [];
    const ok = await notifyAutoBackupFailure(
      new Error('connect <script> timed out'),
      async (token, chatId, text) => { calls.push({ token, chatId, text }); }
    );
    assert.equal(ok, true);
    assert.equal(calls.length, 1);
    // token goes through the normal (token, chatId, text) channel, never argv
    assert.equal(calls[0].token, 'test-bot-token');
    assert.equal(calls[0].chatId, '12345');
    assert.match(calls[0].text, /自动云备份失败/);
    assert.ok(calls[0].text.includes('&lt;script&gt;'), 'error text must be HTML-escaped');
    assert.ok(!calls[0].text.includes('<script>'), 'raw HTML must not leak into the message');
  } finally {
    restoreTelegramSettings(prev);
  }
});

test('sender failure is swallowed, never throws', async () => {
  const prev = snapshotTelegramSettings();
  configureTelegram();
  try {
    const ok = await notifyAutoBackupFailure(new Error('x'), async () => {
      throw new Error('network down');
    });
    assert.equal(ok, false);
  } finally {
    restoreTelegramSettings(prev);
  }
});
