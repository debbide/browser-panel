const assert = require('assert');
const core = require('../extension/shared/export-core');
const { analyzeIrSupport } = require('../exporter/step-catalog');

function collectInvalidSelectorLines(code) {
  return String(code || '')
    .split('\n')
    .filter(line => /invalid\s+[\w()]+:\s+missing selector/i.test(line));
}

function runCase(name, ir, expectedInvalidIndexes = []) {
  const pwSupport = analyzeIrSupport(ir, 'playwright');
  const pySupport = analyzeIrSupport(ir, 'seleniumbase');
  const pwCode = core.generatePlaywrightScript(ir);
  const pyCode = core.generateSeleniumBaseScript(ir);

  const pwInvalid = pwSupport.invalid
    .filter(item => item.missingFields.includes('selector'))
    .map(item => item.index);
  const pyInvalid = pySupport.invalid
    .filter(item => item.missingFields.includes('selector'))
    .map(item => item.index);

  assert.deepStrictEqual(
    pwInvalid,
    expectedInvalidIndexes,
    `${name}: playwright invalid indexes mismatch`
  );
  assert.deepStrictEqual(
    pyInvalid,
    expectedInvalidIndexes,
    `${name}: seleniumbase invalid indexes mismatch`
  );

  const pwInvalidLines = collectInvalidSelectorLines(pwCode);
  const pyInvalidLines = collectInvalidSelectorLines(pyCode);

  if (expectedInvalidIndexes.length === 0) {
    assert.strictEqual(pwInvalidLines.length, 0, `${name}: playwright has unexpected invalid selector output`);
    assert.strictEqual(pyInvalidLines.length, 0, `${name}: seleniumbase has unexpected invalid selector output`);
  } else {
    assert.ok(pwInvalidLines.length >= expectedInvalidIndexes.length, `${name}: playwright invalid output missing`);
    assert.ok(pyInvalidLines.length >= expectedInvalidIndexes.length, `${name}: seleniumbase invalid output missing`);
  }
}

function runDisabledStepCase() {
  const ir = buildBaseIr([
    {
      id: 'disabled-1',
      type: 'click',
      enabled: false,
      selector: {
        primary: 'css',
        value: '',
        fallbacks: [],
      },
    },
  ]);
  const pwSupport = analyzeIrSupport(ir, 'playwright');
  const pySupport = analyzeIrSupport(ir, 'seleniumbase');
  const pwCode = core.generatePlaywrightScript(ir);
  const pyCode = core.generateSeleniumBaseScript(ir);

  assert.deepStrictEqual(
    pwSupport.invalid.filter(item => item.missingFields.includes('selector')).map(item => item.index),
    [],
    'disabled step should be skipped from validation (playwright)'
  );
  assert.deepStrictEqual(
    pySupport.invalid.filter(item => item.missingFields.includes('selector')).map(item => item.index),
    [],
    'disabled step should be skipped from validation (seleniumbase)'
  );

  assert.ok(
    pwCode.includes('// skipped step: click (disabled)'),
    'disabled step should be rendered as skipped in playwright code'
  );
  assert.ok(
    pyCode.includes('# skipped step: click (disabled)'),
    'disabled step should be rendered as skipped in seleniumbase code'
  );
}

function runSmokeDualTargetsCase() {
  const ir = {
    version: '1.0',
    meta: {
      name: 'smoke-dual-target',
      created_at: '2026-05-04T00:00:00.000Z',
      start_url: 'https://example.com/login',
    },
    steps: [
      {
        id: 's1',
        type: 'input',
        selector: {
          primary: 'css',
          value: '',
          fallbacks: [{ type: 'testid', value: 'email-input' }],
        },
        value: 'demo@example.com',
      },
      {
        id: 's2',
        type: 'wait',
        wait_for: 'selector',
        selector: {
          primary: 'css',
          value: '#submit',
          fallbacks: [],
        },
        timeout_ms: 6000,
      },
      {
        id: 's3',
        type: 'assert_text',
        value: '__turnstile_token_ready__',
      },
      {
        id: 's4',
        type: 'screenshot',
        name: 'final',
      },
    ],
  };

  const pwSupport = analyzeIrSupport(ir, 'playwright');
  const pySupport = analyzeIrSupport(ir, 'seleniumbase');
  assert.strictEqual(pwSupport.invalid.length, 0, 'smoke case should be valid for playwright');
  assert.strictEqual(pySupport.invalid.length, 0, 'smoke case should be valid for seleniumbase');

  const pwCode = core.generatePlaywrightScript(ir);
  const pyCode = core.generateSeleniumBaseScript(ir);

  assert.ok(pwCode.includes('getByTestId("email-input")'), 'playwright should use fallback selector candidate');
  assert.ok(pyCode.includes("[data-testid='email-input']"), 'seleniumbase should use fallback selector candidate');
  assert.ok(
    !collectInvalidSelectorLines(pwCode).length && !collectInvalidSelectorLines(pyCode).length,
    'smoke case should not produce invalid selector lines'
  );
}

function buildBaseIr(steps) {
  return {
    version: '1.0',
    meta: {
      name: 'support-consistency',
      created_at: '2026-05-04T00:00:00.000Z',
      start_url: 'https://example.com',
    },
    steps,
  };
}

function main() {
  runCase(
    'valid css selector',
    buildBaseIr([
      { id: 's1', type: 'click', selector: { primary: 'css', value: '#submit', fallbacks: [] } },
    ]),
    []
  );

  runCase(
    'empty primary but valid fallback',
    buildBaseIr([
      {
        id: 's1',
        type: 'click',
        selector: {
          primary: 'css',
          value: '',
          fallbacks: [{ type: 'testid', value: 'submit-btn' }],
        },
      },
    ]),
    []
  );

  runCase(
    'missing selector candidate',
    buildBaseIr([
      {
        id: 's1',
        type: 'input',
        selector: {
          primary: 'css',
          value: '   ',
          fallbacks: [],
        },
        value: 'demo',
      },
    ]),
    [0]
  );

  runCase(
    'wait selector missing candidate',
    buildBaseIr([
      {
        id: 's1',
        type: 'wait',
        wait_for: 'selector',
        selector: {
          primary: 'css',
          value: '',
          fallbacks: [],
        },
        timeout_ms: 5000,
      },
    ]),
    [0]
  );

  runCase(
    'turnstile assert without selector',
    buildBaseIr([
      {
        id: 's1',
        type: 'assert_text',
        value: '__turnstile_token_ready__',
      },
    ]),
    []
  );

  runDisabledStepCase();
  runSmokeDualTargetsCase();

  console.log('support-consistency tests passed');
}

main();
