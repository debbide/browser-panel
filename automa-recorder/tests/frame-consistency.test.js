const assert = require('assert');
const core = require('../extension/shared/export-core');
const { analyzeIrSupport } = require('../exporter/step-catalog');

function buildIr(steps) {
  return {
    version: '1.0',
    meta: {
      name: 'frame-consistency',
      created_at: '2026-05-04T00:00:00.000Z',
      start_url: 'https://example.com',
    },
    steps,
  };
}

function main() {
  const ir = buildIr([
    {
      id: 'f1',
      type: 'click',
      selector: { primary: 'css', value: '#inside-frame', fallbacks: [] },
      frame: { in_iframe: true, selector: 'iframe#auth' },
    },
    {
      id: 'f2',
      type: 'input',
      selector: { primary: 'css', value: '#inside-frame-input', fallbacks: [] },
      value: 'demo',
      frame: { in_iframe: true, name: 'auth-frame' },
    },
    {
      id: 'f3',
      type: 'hover',
      selector: { primary: 'css', value: '.outside', fallbacks: [] },
    },
    {
      id: 'f4',
      type: 'wait',
      wait_for: 'selector',
      selector: { primary: 'css', value: '.inside-wait', fallbacks: [] },
      timeout_ms: 4000,
      frame: { in_iframe: true, url: 'https://example.com/frame' },
    },
  ]);

  const pwSupport = analyzeIrSupport(ir, 'playwright');
  const pySupport = analyzeIrSupport(ir, 'seleniumbase');
  assert.strictEqual(pwSupport.invalid.length, 0, 'frame case should be valid for playwright');
  assert.strictEqual(pySupport.invalid.length, 0, 'frame case should be valid for seleniumbase');

  const pw = core.generatePlaywrightScript(ir);
  const py = core.generateSeleniumBaseScript(ir);

  assert.ok(
    pw.includes('page.frameLocator("iframe#auth").locator("#inside-frame").click();'),
    'playwright should use frameLocator with frame selector'
  );
  assert.ok(
    pw.includes('page.frame({ name: "auth-frame" }).locator("#inside-frame-input").fill("demo");'),
    'playwright should use frame(name) scope'
  );
  assert.ok(
    pw.includes('page.frame({ url: "https://example.com/frame" }).locator(".inside-wait").waitFor({ state: \'visible\', timeout: 4000 });'),
    'playwright wait(selector) should respect frame scope'
  );

  assert.ok(
    py.includes('sb.switch_to_frame("iframe#auth")') && py.includes('sb.switch_to_default_content()'),
    'seleniumbase should switch frame and reset'
  );
  assert.ok(
    py.includes('sb.switch_to_frame("auth-frame")'),
    'seleniumbase should support frame name switch'
  );
  assert.ok(
    py.includes('sb.hover(".outside")') && !py.includes('sb.switch_to_frame(".outside")'),
    'non-frame step should not include frame switch noise'
  );

  console.log('frame-consistency tests passed');
}

main();
