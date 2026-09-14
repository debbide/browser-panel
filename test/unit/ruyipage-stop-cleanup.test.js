const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const launcherPath = path.resolve(__dirname, '../../server/runtime/browser-launcher.js');
const source = fs.readFileSync(launcherPath, 'utf8');

test('manual RuyiPage stop has a guarded executable-path SIGKILL fallback', () => {
  assert.match(source, /taskSnapshot\._forceRuyiBinaryCleanup = !hasOtherRuyiRun/);
  assert.match(source, /runtimeStack === 'ruyipage' && forceRuyiBinaryCleanup && ruyiPath/);
  assert.match(source, /pkill -KILL -f -- \$\{shellEscape\(ruyiPath\)\}/);
});

test('RuyiPage executable fallback is disabled while another RuyiPage run is active', () => {
  assert.match(source, /Number\(id\) !== Number\(taskId\)/);
  assert.match(source, /run\.task && run\.task\._runtimeStack/);
});
