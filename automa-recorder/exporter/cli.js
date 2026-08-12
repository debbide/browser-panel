const fs = require('fs');
const path = require('path');
const { generateFromIr } = require('./index');

function parseArgs(argv) {
  const bag = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '1';
      bag[key] = val;
    }
  }
  return bag;
}

function main() {
  const args = parseArgs(process.argv);
  const target = args.target;
  const inPath = args.in;
  const outPath = args.out;

  if (!target || !inPath || !outPath) {
    console.error('Usage: node exporter/cli.js --target playwright|seleniumbase --in input.ir.json --out output.file');
    process.exit(1);
  }

  const inAbs = path.resolve(inPath);
  const outAbs = path.resolve(outPath);
  const ir = JSON.parse(fs.readFileSync(inAbs, 'utf8'));
  const code = generateFromIr(ir, target);

  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, code, 'utf8');
  console.log(`Exported ${target} script => ${outAbs}`);
}

main();
