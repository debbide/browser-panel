const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const launcherPath = path.resolve(__dirname, '../../server/runtime/browser-launcher.js');
const source = fs.readFileSync(launcherPath, 'utf8');

test('manual stop kills Firefox directly on the host operating system', () => {
  assert.match(source, /function killAllFirefoxProcesses\(\)/);
  assert.match(source, /process\.platform === 'win32'/);
  assert.match(source, /spawn\('taskkill\.exe', \['\/F', '\/T', '\/IM', image\]/);
  assert.match(source, /spawn\('pkill', \['-KILL', '-f', processName\]/);
  assert.match(source, /function stopBrowserTask[\s\S]*?killAllFirefoxProcesses\(\)/);
  assert.doesNotMatch(source, /hasOtherRuyiRun/);
  assert.doesNotMatch(source, /_forceRuyiBinaryCleanup/);
});

test('Windows host cleanup does not route Firefox termination through WSL', () => {
  assert.doesNotMatch(source, /commands\.push\('pkill -KILL -f firefox/);
  assert.match(source, /windowsHide: true/);
});
