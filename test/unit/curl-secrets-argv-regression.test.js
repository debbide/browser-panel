const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '../..');

// S5: secrets must never appear in a child process argv (visible via `ps aux`).
// - Telegram: no child process at all (Node https + proxy agent, secrets stay in-memory).
// - S3: secrets travel in a curl --config temp file (0600), never argv.
test('S5: no secrets in child argv for telegram and s3', () => {
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
        const configTexts = [];
        childProcess.spawn = (cmd, args = [], opts = {}) => {
          spawns.push({ cmd, args: [...args] });
          // 密钥走 --config 临时文件（0600）：从 argv 里取出文件路径读内容断言。
          const cIdx = args.indexOf('--config');
          if (cIdx >= 0 && args[cIdx + 1] && args[cIdx + 1] !== '-') {
            try { configTexts.push(fs.readFileSync(args[cIdx + 1], 'utf8')); } catch (_) {}
          }
          const child = new EventEmitter();
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.stdin = new EventEmitter();
          let buffered = '';
          child.stdin.write = (d) => { buffered += String(d); };
          child.stdin.end = (d) => {
            if (d) buffered += String(d);
            configTexts.push(buffered);
            const oIdx = args.indexOf('-o');
            if (oIdx >= 0 && args[oIdx + 1]) fs.writeFileSync(args[oIdx + 1], 'x');
          };
          child.kill = () => {};
          // 模拟 curl 成功返回（新代码走 --config 临时文件，不再调 stdin.end）。
          // -o <dest> 的下载文件也要模拟出来。
          const oIdx = args.indexOf('-o');
          if (oIdx >= 0 && args[oIdx + 1]) fs.writeFileSync(args[oIdx + 1], 'x');
          process.nextTick(() => {
            child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, result: true })));
            child.emit('close', 0);
          });
          return child;
          return child;
        };
        childProcess.spawnSync = () => ({ status: 0 }); // pretend curl exists

        process.env.TG_PROXY = 'http://tgproxyuser:' + TG_PROXY_PASS + '@127.0.0.1:18080';

        // Mock https.request: telegram must go through Node https (with proxy agent),
        // never spawn a child process. Capture the request for secret-flow assertions.
        const https = require('node:https');
        const httpsRequests = [];
        const origRequest = https.request;
        https.request = (url, opts, cb) => {
          httpsRequests.push({ url: String(url), opts });
          const { EventEmitter } = require('node:events');
          const req = new EventEmitter();
          req.write = () => {}; req.end = () => {
            const res = new EventEmitter();
            res.statusCode = 200;
            process.nextTick(() => {
              cb(res);
              res.emit('data', Buffer.from(JSON.stringify({ ok: true, result: true })));
              res.emit('end');
            });
          };
          req.destroy = () => {};
          req.on = req.addListener.bind(req);
          return req;
        };

        const spawnsBeforeTelegram = spawns.length;
        const telegram = require('./server/telegram');
        await telegram.deleteTelegramWebhook(BOT_TOKEN);
        await telegram.sendTelegramMessage(BOT_TOKEN, '12345', 'hello');
        const pngPath = require('node:path').join(require('node:os').tmpdir(), 's5-photo.png');
        fs.writeFileSync(pngPath, Buffer.from([137, 80, 78, 71]));
        await telegram.sendTelegramPhoto(BOT_TOKEN, '12345', pngPath, 'cap <b>x</b>');
        https.request = origRequest;

        // Telegram must not spawn any child process (no curl, no argv leak surface).
        if (spawns.length !== spawnsBeforeTelegram) {
          throw new Error('telegram spawned a child process: ' + JSON.stringify(spawns.slice(spawnsBeforeTelegram)));
        }
        // Telegram must have made https requests carrying the token in-URL (in-memory only).
        if (httpsRequests.length < 3) throw new Error('expected telegram https requests, got ' + httpsRequests.length);
        for (const r of httpsRequests) {
          if (!r.url.includes(BOT_TOKEN)) throw new Error('bot token missing from telegram URL');
          // proxy agent must be set (requests honor TG_PROXY)
          if (!r.opts || !r.opts.agent) throw new Error('telegram https request missing proxy agent');
        }

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

        if (spawns.length !== 4) throw new Error('expected 4 s3 curl spawns, got ' + spawns.length);
        const secrets = [S3_PROXY_PASS, S3_SESSION_TOKEN];
        for (const s of spawns) {
          if (s.cmd !== 'curl') throw new Error('unexpected spawn: ' + s.cmd);
          const argvText = s.args.join(' ');
          const cIdx = s.args.indexOf('--config');
          if (cIdx < 0 || !s.args[cIdx + 1] || s.args[cIdx + 1] === '-') {
            throw new Error('curl not using --config <tmpfile>: ' + argvText);
          }
          for (const secret of secrets) {
            if (argvText.includes(secret)) throw new Error('secret leaked into argv: ' + argvText);
          }
          if (/authorization:/i.test(argvText)) throw new Error('Authorization header in argv: ' + argvText);
        }
        // The S3 secrets must still reach curl — via the --config temp file.
        const configAll = configTexts.join('\n');
        for (const secret of secrets) {
          if (!configAll.includes(secret)) throw new Error('secret missing from --config file: ' + secret);
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
