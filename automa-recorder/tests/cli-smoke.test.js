const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function runCli(args) {
  const result = spawnSync('node', ['exporter/cli.js', ...args], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    throw new Error(`CLI failed (${result.status}): ${output}`);
  }
  return result;
}

function main() {
  const root = path.resolve(__dirname, '..');
  const inPath = path.join(root, 'examples', 'sample.ir.json');
  const outDir = path.join(root, 'tests', '.tmp');
  const outPw = path.join(outDir, 'cli-smoke.playwright.js');
  const outPy = path.join(outDir, 'cli-smoke.seleniumbase.py');

  fs.mkdirSync(outDir, { recursive: true });
  for (const filePath of [outPw, outPy]) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  runCli(['--target', 'playwright', '--in', inPath, '--out', outPw]);
  runCli(['--target', 'seleniumbase', '--in', inPath, '--out', outPy]);

  assert.ok(fs.existsSync(outPw), 'playwright output file should exist');
  assert.ok(fs.existsSync(outPy), 'seleniumbase output file should exist');

  const pwCode = fs.readFileSync(outPw, 'utf8');
  const pyCode = fs.readFileSync(outPy, 'utf8');

  assert.ok(pwCode.includes("const { chromium } = require('playwright');"), 'playwright header missing');
  assert.ok(pyCode.includes('from seleniumbase import SB'), 'seleniumbase header missing');
  assert.ok(!/invalid\s+[\w()]+:\s+missing selector/i.test(pwCode), 'playwright has invalid selector output');
  assert.ok(!/invalid\s+[\w()]+:\s+missing selector/i.test(pyCode), 'seleniumbase has invalid selector output');

  console.log('cli-smoke tests passed');
}

main();
