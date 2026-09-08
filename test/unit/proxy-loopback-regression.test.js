const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { applyProxyAliases } = require('../../server/runtime/env-builder');
const fs = require('node:fs');

test('browser proxy keeps all loopback control endpoints direct', () => {
  const env = {
    BROWSER_PROXY: 'http://proxy.test:8080',
    NO_PROXY: 'internal.test,localhost',
  };

  applyProxyAliases(env, { overwrite: true });

  assert.equal(env.HTTP_PROXY, 'http://proxy.test:8080');
  assert.equal(env.HTTPS_PROXY, 'http://proxy.test:8080');
  assert.equal(env.ALL_PROXY, 'http://proxy.test:8080');
  assert.deepEqual(env.NO_PROXY.split(','), [
    'internal.test',
    'localhost',
    '127.0.0.1',
    '::1',
  ]);
  assert.equal(env.no_proxy, env.NO_PROXY);
});

test('RuyiPage adapter forces local browser control traffic direct', () => {
  const adapterPath = path.resolve(__dirname, '../../server/runtime/ruyipage_adapter.py');
  const result = spawnSync('python3', ['-c', [
    'import importlib.util, os, sys',
    'spec = importlib.util.spec_from_file_location("adapter", sys.argv[1])',
    'adapter = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(adapter)',
    'os.environ["NO_PROXY"] = "internal.test"',
    'os.environ.pop("no_proxy", None)',
    'adapter.force_loopback_direct()',
    'print(os.environ["NO_PROXY"])',
    'print(os.environ["no_proxy"])',
  ].join('; '), adapterPath], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  const values = result.stdout.trim().split('\n');
  assert.deepEqual(values, [
    'internal.test,localhost,127.0.0.1,::1',
    'internal.test,localhost,127.0.0.1,::1',
  ]);
});

test('browser launcher exports loopback bypass to direct Python scripts', () => {
  const launcherPath = path.resolve(__dirname, '../../server/runtime/browser-launcher.js');
  const source = fs.readFileSync(launcherPath, 'utf8');

  assert.match(source, /\['NO_PROXY', proxyAliasEnv\.NO_PROXY/);
  assert.match(source, /\['no_proxy', proxyAliasEnv\.no_proxy/);
});
