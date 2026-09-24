const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { buildOrphanSbChromeCleanupCommands } = require('../../server/runtime/browser-launcher');
const { createBrowserRouteHelpers } = require('../../server/routes/browser-routes');

// Extract the generated is_target_udir() bash function and run it against
// candidate cmdlines in a real bash process.
function runIsTargetUdir(extraUserDataDirs, cmdline) {
  const commands = buildOrphanSbChromeCleanupCommands({ aggressive: false, extraUserDataDirs });
  const start = commands.findIndex((line) => line.includes('is_target_udir() {'));
  assert.ok(start >= 0, 'is_target_udir not found in generated script');
  let end = start + 1;
  while (end < commands.length && commands[end] !== '  }') end++;
  const fn = commands.slice(start, end + 1).join('\n');
  const harness = [
    '#!/usr/bin/env bash',
    fn,
    'if is_target_udir "$1"; then echo MATCH; else echo NOMATCH; fi',
    '',
  ].join('\n');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bap-udir-test-')), 'h.sh');
  fs.writeFileSync(file, harness, { mode: 0o700 });
  const result = spawnSync('/bin/bash', [file, cmdline], { encoding: 'utf8' });
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  assert.equal(result.status, 0, `bash harness failed: ${result.stderr}`);
  return result.stdout.trim();
}

const SENTINEL = '/tmp/bap-s1-injection-sentinel';
const EVIL_DIR = `/x$(touch ${SENTINEL})`;

test('S1: malicious user_data_dir in cleanup script is quoted, never executed', () => {
  try { fs.unlinkSync(SENTINEL); } catch { /* ignore */ }
  const commands = buildOrphanSbChromeCleanupCommands({ aggressive: false, extraUserDataDirs: [EVIL_DIR] });
  const script = commands.join('\n');
  // The hint must appear single-quoted (shellEscape), not raw.
  assert.ok(
    script.includes(`*'--user-data-dir=${EVIL_DIR}'*`),
    'expected shell-escaped hint in case pattern'
  );
  // Functionally: normal cmdline does not match, and nothing is executed.
  assert.equal(runIsTargetUdir([EVIL_DIR], 'chrome --user-data-dir=/home/u/real --x'), 'NOMATCH');
  assert.ok(!fs.existsSync(SENTINEL), 'command substitution must not execute');
});

test('S1: literal hint still matches (cleanup function preserved)', () => {
  try { fs.unlinkSync(SENTINEL); } catch { /* ignore */ }
  assert.equal(
    runIsTargetUdir(['/tmp/myprofile'], 'chrome --user-data-dir=/tmp/myprofile --x'),
    'MATCH'
  );
  assert.equal(runIsTargetUdir([], 'chrome --user-data-dir=/tmp/tmpAbC123 --x'), 'MATCH');
  assert.equal(runIsTargetUdir([], 'chrome --user-data-dir=/home/u/other --x'), 'NOMATCH');
  assert.ok(!fs.existsSync(SENTINEL), 'command substitution must not execute');
});

test('S1: profile API rejects shell metacharacters in user_data_dir', () => {
  const helpers = createBrowserRouteHelpers({ db: {}, proxyModes: [] });
  const evil = [
    '/tmp/x$(id)',
    '/tmp/x`id`',
    '/tmp/x;id',
    '/tmp/x|id',
    '/tmp/x&id',
    '/tmp/x(id)',
    '/tmp/x\nid',
    "/tmp/x'id",
    '/tmp/x"id',
    '/tmp/x\\id',
    '/tmp/x*',
  ];
  for (const value of evil) {
    assert.throws(
      () => helpers.normalizeProfileUserDataDir(value),
      /非法字符/,
      `should reject ${JSON.stringify(value)}`
    );
  }
  assert.equal(helpers.normalizeProfileUserDataDir('/tmp/chrome-profile-1'), '/tmp/chrome-profile-1');
  assert.equal(helpers.normalizeProfileUserDataDir('  /tmp/p  '), '/tmp/p');
  assert.equal(helpers.normalizeProfileUserDataDir(''), '');
});
