const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '../..');

// S5: bot token / proxy password / S3 auth must never appear in a child
// process argv (visible via `ps aux`). They travel in a curl --config
// document piped over stdin instead.
test('S5: curl argv carries no secrets for telegram and s3', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-s5-'));
  try {
    const script = String.raw`
      (async () => {
        const { EventEmitter } = require('node:events');
        const childProcess = require('node:child_process');
        const fs = require('node:fs');

        const BOT_TOKEN = 'FAKE_BOT_TOKEN_ABC123';
        const TG_PROXY_PASS = 'TGPROXYPASS456';
        const S3_PROXY_PASS = 'S3PROXYPASS789';
        const S3_SESSION_TOKEN = 'FAKE_SESSION_TOKEN_XYZ';

        const spawns = [];
        const stdinTexts = [];
        childProcess.spawn = (cmd, args = [], opts = {}) => {
          spawns.push({ cmd, args: [...args] });
          const child = new EventEmitter();
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.stdin = new EventEmitter();
          let buffered = '';
          child.stdin.write = (d) => { buffered += String(d); };
          child.stdin.end = (d) => {
            if (d) buffered += String(d);
            stdinTexts.push(buffered);
            const oIdx = args.indexOf('-o');
            if (oIdx >= 0 && args[oIdx + 1]) fs.writeFileSync(args[oIdx + 1], 'x');
            process.nextTick(() => {
              child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, result: true })));
              child.emit('close', 0);
            });
          };
          child.kill = () => {};
          return child;
        };
        childProcess.spawnSync = () => ({ status: 0 }); // pretend curl exists

        process.env.TG_PROXY = 'http://tgproxyuser:' + TG_PROXY_PASS + '@127.0.0.1:18080';

        const telegram = require('./server/telegram');
        await telegram.deleteTelegramWebhook(BOT_TOKEN);
        await telegram.sendTelegramMessage(BOT_TOKEN, '12345', 'hello');
        const pngPath = require('node:path').join(require('node:os').tmpdir(), 's5-photo.png');
        fs.writeFileSync(pngPath, Buffer.from([137, 80, 78, 71]));
        await telegram.sendTelegramPhoto(BOT_TOKEN, '12345', pngPath, 'cap <b>x</b>');

        const { createS3Client } = require('./server/cloud/s3-client');
        const s3 = createS3Client({
          endpoint: 'https://s3.example.test',
          bucket: 'bkt',
          accessKey: 'AKID',
          secretKey: 'SECRET',
          token: S3_SESSION_TOKEN,
          proxy: 'http://s3proxyuser:' + S3_PROXY_PASS + '@127.0.0.1:18080',
        });
        const upFile = require('node:path').join(require('node:os').tmpdir(), 's5-up.bin');
        fs.writeFileSync(upFile, 'data');
        await s3.putObject({ key: 'k1', filePath: upFile });
        await s3.listObjects({ prefix: 'k' });
        const dest = require('node:path').join(require('node:os').tmpdir(), 's5-down.bin');
        await s3.getObject({ key: 'k1', destPath: dest });
        await s3.deleteObject({ key: 'k1' });

        if (spawns.length < 7) throw new Error('expected curl spawns, got ' + spawns.length);
        const secrets = [BOT_TOKEN, TG_PROXY_PASS, S3_PROXY_PASS, S3_SESSION_TOKEN];
        for (const s of spawns) {
          if (s.cmd !== 'curl') throw new Error('unexpected spawn: ' + s.cmd);
          const argvText = s.args.join(' ');
          if (!s.args.includes('--config') || !s.args.includes('-')) {
            throw new Error('curl not using --config -: ' + argvText);
          }
          for (const secret of secrets) {
            if (argvText.includes(secret)) throw new Error('secret leaked into argv: ' + argvText);
          }
          if (/authorization:/i.test(argvText)) throw new Error('Authorization header in argv: ' + argvText);
        }
        // The secrets must still reach curl — via the stdin config document.
        const stdinAll = stdinTexts.join('\n');
        for (const secret of secrets) {
          if (!stdinAll.includes(secret)) throw new Error('secret missing from stdin config: ' + secret);
        }
        console.log('S5-OK spawns=' + spawns.length);
      })().catch((e) => { console.error('S5-FAIL', e); process.exit(1); });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: projectRoot,
      env: { ...process.env, PANEL_RUNTIME_ROOT: runtimeRoot },
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.ok(
      result.status === 0 && /S5-OK/.test(result.stdout),
      `S5 subprocess failed:\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    );
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
