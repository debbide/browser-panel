const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { generateFromIr } = require('../exporter');
const { analyzeIrSupport } = require('../exporter/step-catalog');

function listRealSamples(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ir.json'))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function assertNoInvalidSelectorMarkers(code, name, target) {
  const bad = String(code || '')
    .split('\n')
    .filter((line) => /invalid\s+[\w()]+:\s+missing selector/i.test(line));
  assert.strictEqual(
    bad.length,
    0,
    `${name} (${target}) should not include invalid missing-selector markers`
  );
}

function runSample(samplePath) {
  const raw = fs.readFileSync(samplePath, 'utf8');
  const ir = JSON.parse(raw);
  const name = path.basename(samplePath);

  const pwSupport = analyzeIrSupport(ir, 'playwright');
  const pySupport = analyzeIrSupport(ir, 'seleniumbase');
  assert.strictEqual(pwSupport.unsupported.length, 0, `${name}: playwright unsupported should be empty`);
  assert.strictEqual(pySupport.unsupported.length, 0, `${name}: seleniumbase unsupported should be empty`);
  assert.strictEqual(pwSupport.invalid.length, 0, `${name}: playwright invalid should be empty`);
  assert.strictEqual(pySupport.invalid.length, 0, `${name}: seleniumbase invalid should be empty`);

  const pwCode = generateFromIr(ir, 'playwright');
  const pyCode = generateFromIr(ir, 'seleniumbase');

  assert.ok(pwCode.includes("const { chromium } = require('playwright');"), `${name}: playwright header missing`);
  assert.ok(pyCode.includes('from seleniumbase import SB'), `${name}: seleniumbase header missing`);
  assertNoInvalidSelectorMarkers(pwCode, name, 'playwright');
  assertNoInvalidSelectorMarkers(pyCode, name, 'seleniumbase');
}

function main() {
  const root = path.resolve(__dirname, '..');
  const sampleDir = path.join(root, 'examples', 'real-samples');
  const samples = listRealSamples(sampleDir);
  assert.ok(samples.length >= 2, 'real-samples should include at least 2 IR files');

  for (const sample of samples) {
    runSample(sample);
  }

  console.log(`real-samples smoke tests passed (${samples.length} samples)`);
}

main();
