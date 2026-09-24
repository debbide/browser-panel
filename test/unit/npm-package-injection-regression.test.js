const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createBrowserRouteHelpers } = require('../../server/routes/browser-routes');

const source = fs.readFileSync(
  path.resolve(__dirname, '../../server/routes/browser-routes.js'),
  'utf8'
);

function payloadWithPackages(pluginPackages) {
  return {
    runtimeStack: 'playwright',
    usePlaywrightExtra: false,
    pluginPackages,
    chromePath: '',
    extensionDirs: '',
    ruyiPath: '',
    proxyMode: 'inherit',
    proxyValue: '',
    ruyiFpfile: '',
  };
}

// normalizeBrowserRuntimeSettingsPayload(payload, fallback) — pass an explicit
// fallback so the db is never touched in tests.
const FALLBACK = payloadWithPackages('');

test('S8: package names starting with - are rejected', () => {
  const helpers = createBrowserRouteHelpers({ db: {}, proxyModes: ['inherit'] });
  for (const evil of ['-g', '--force', '--dry-run', '-S']) {
    assert.throws(
      () => helpers.normalizeBrowserRuntimeSettingsPayload(payloadWithPackages(evil), FALLBACK),
      /插件包名不合法/,
      `should reject ${evil}`
    );
  }
});

test('S8: legitimate package names still pass', () => {
  const helpers = createBrowserRouteHelpers({ db: {}, proxyModes: ['inherit'] });
  const settings = helpers.normalizeBrowserRuntimeSettingsPayload(
    payloadWithPackages('puppeteer-extra-plugin-stealth,@scope/pkg-name'),
    FALLBACK
  );
  assert.ok(settings.pluginPackages.includes('puppeteer-extra-plugin-stealth'));
  assert.ok(settings.pluginPackages.includes('@scope/pkg-name'));
});

test('S8: npm install argv separates package list with --', () => {
  assert.match(
    source,
    /'install',\s*'--no-audit',\s*'--no-fund',\s*'--',\s*\.\.\.installList/
  );
});
