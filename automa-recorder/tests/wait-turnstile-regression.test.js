const assert = require('assert');
const core = require('../extension/shared/export-core');
const { analyzeIrSupport } = require('../exporter/step-catalog');

function buildIr(steps) {
  return {
    version: '1.0',
    meta: {
      name: 'wait-turnstile-regression',
      created_at: '2026-05-04T00:00:00.000Z',
      start_url: 'https://example.com/login',
    },
    steps,
  };
}

function main() {
  const okIr = buildIr([
    {
      id: 'w1',
      type: 'wait',
      wait_for: 'selector',
      selector: {
        primary: 'css',
        value: '',
        fallbacks: [{ type: 'testid', value: 'ready-badge' }],
      },
      timeout_ms: 7000,
      fallback_ms: 900,
    },
    {
      id: 'w2',
      type: 'assert_text',
      value: '__turnstile_token_ready__',
    },
  ]);

  const okPw = analyzeIrSupport(okIr, 'playwright');
  const okPy = analyzeIrSupport(okIr, 'seleniumbase');
  assert.strictEqual(okPw.invalid.length, 0, 'valid wait+turnstile should pass (playwright)');
  assert.strictEqual(okPy.invalid.length, 0, 'valid wait+turnstile should pass (seleniumbase)');

  const okPwCode = core.generatePlaywrightScript(okIr);
  const okPyCode = core.generateSeleniumBaseScript(okIr);
  assert.ok(okPwCode.includes('getByTestId("ready-badge").waitFor({ state: \'visible\', timeout: 7000 });'), 'playwright should use fallback selector in wait(selector)');
  assert.ok(okPyCode.includes("[data-testid='ready-badge']"), 'seleniumbase should use fallback selector in wait(selector)');
  assert.ok(okPwCode.includes('cf-turnstile-response'), 'playwright should include turnstile token wait');
  assert.ok(okPyCode.includes('cf-turnstile-response'), 'seleniumbase should include turnstile token wait');

  const badIr = buildIr([
    {
      id: 'w3',
      type: 'wait',
      wait_for: 'selector',
      selector: {
        primary: 'css',
        value: '   ',
        fallbacks: [],
      },
      timeout_ms: 7000,
    },
  ]);

  const badPw = analyzeIrSupport(badIr, 'playwright');
  const badPy = analyzeIrSupport(badIr, 'seleniumbase');
  assert.deepStrictEqual(
    badPw.invalid.map(item => item.missingFields.join(',')),
    ['selector'],
    'invalid wait(selector) should be flagged (playwright)'
  );
  assert.deepStrictEqual(
    badPy.invalid.map(item => item.missingFields.join(',')),
    ['selector'],
    'invalid wait(selector) should be flagged (seleniumbase)'
  );

  const badPwCode = core.generatePlaywrightScript(badIr);
  const badPyCode = core.generateSeleniumBaseScript(badIr);
  assert.ok(/invalid wait\(selector\): missing selector/i.test(badPwCode), 'playwright invalid wait(selector) marker missing');
  assert.ok(/invalid wait\(selector\): missing selector/i.test(badPyCode), 'seleniumbase invalid wait(selector) marker missing');

  console.log('wait-turnstile-regression tests passed');
}

main();
