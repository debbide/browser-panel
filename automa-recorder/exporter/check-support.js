const fs = require('fs');
const path = require('path');
const { analyzeIrSupport } = require('./step-catalog');

function parseArgs(argv) {
  const bag = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '1';
    bag[name] = value;
  }
  return bag;
}

function printSection(title, rows) {
  console.log(`\n[${title}]`);
  if (!rows.length) {
    console.log('  none');
    return;
  }
  for (const row of rows) {
    const missing = row.missingFields ? ` missing=${row.missingFields.join(',')}` : '';
    console.log(`  - idx=${row.index} type=${row.type} id=${row.id}${missing}`);
  }
}

function main() {
  const args = parseArgs(process.argv);
  const inPath = args.in;
  if (!inPath) {
    console.error('Usage: node exporter/check-support.js --in examples/sample.ir.json');
    process.exit(1);
  }
  const ir = JSON.parse(fs.readFileSync(path.resolve(inPath), 'utf8'));

  const pw = analyzeIrSupport(ir, 'playwright');
  const py = analyzeIrSupport(ir, 'seleniumbase');

  console.log('Support Check Summary');
  console.log(`steps: ${Array.isArray(ir?.steps) ? ir.steps.length : 0}`);
  printSection('playwright unsupported', pw.unsupported);
  printSection('playwright invalid', pw.invalid);
  printSection('seleniumbase unsupported', py.unsupported);
  printSection('seleniumbase invalid', py.invalid);

  const hasIssue = pw.unsupported.length || pw.invalid.length || py.unsupported.length || py.invalid.length;
  process.exit(hasIssue ? 2 : 0);
}

main();
