const assert = require('assert');
const core = require('../extension/shared/export-core');
const { analyzeIrSupport } = require('../exporter/step-catalog');

function irForSelector(selector, stepId) {
  return {
    version: '1.0',
    meta: {
      name: `selector-mapping-${stepId}`,
      created_at: '2026-05-04T00:00:00.000Z',
      start_url: 'https://example.com',
    },
    steps: [
      {
        id: stepId,
        type: 'click',
        selector,
      },
    ],
  };
}

function assertValid(ir, name) {
  const pw = analyzeIrSupport(ir, 'playwright');
  const py = analyzeIrSupport(ir, 'seleniumbase');
  assert.strictEqual(pw.invalid.length, 0, `${name}: playwright invalid`);
  assert.strictEqual(py.invalid.length, 0, `${name}: seleniumbase invalid`);
}

function main() {
  const cases = [
    {
      name: 'css',
      selector: { primary: 'css', value: '.submit-btn', fallbacks: [] },
      pwExpected: 'page.locator(".submit-btn").click();',
      pyExpected: 'sb.click(".submit-btn")',
    },
    {
      name: 'xpath',
      selector: { primary: 'xpath', value: "//button[@type='submit']", fallbacks: [] },
      pwExpected: 'page.locator("xpath=//button[@type=\'submit\']").click();',
      pyExpected: 'sb.click("xpath=//button[@type=\'submit\']")',
    },
    {
      name: 'text',
      selector: { primary: 'text', value: '提交', fallbacks: [] },
      pwExpected: 'page.getByText("提交").click();',
      pyExpected: 'sb.click("xpath=//*[contains(normalize-space(.), \'提交\')]")',
    },
    {
      name: 'testid',
      selector: { primary: 'testid', value: 'submit-btn', fallbacks: [] },
      pwExpected: 'page.getByTestId("submit-btn").click();',
      pyExpected: "sb.click(\"[data-testid='submit-btn']\")",
    },
    {
      name: 'role-with-name',
      selector: { primary: 'role', value: 'button:提交', fallbacks: [] },
      pwExpected: 'page.getByRole("button", { name: "提交" }).click();',
      pyExpected: "sb.click(\"[role='button']\")",
    },
  ];

  for (const [index, item] of cases.entries()) {
    const ir = irForSelector(item.selector, `case-${index + 1}`);
    assertValid(ir, item.name);
    const pwCode = core.generatePlaywrightScript(ir);
    const pyCode = core.generateSeleniumBaseScript(ir);
    assert.ok(pwCode.includes(item.pwExpected), `${item.name}: playwright mapping mismatch`);
    assert.ok(pyCode.includes(item.pyExpected), `${item.name}: seleniumbase mapping mismatch`);
  }

  console.log('selector-mapping tests passed');
}

main();
