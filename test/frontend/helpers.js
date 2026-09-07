const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function extractFunction(source, name) {
  const startPattern = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = startPattern.exec(source);
  if (!match) throw new Error(`Function ${name} not found`);
  const braceStart = source.indexOf('{', match.index);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  throw new Error(`Function ${name} is incomplete`);
}

function evaluateFunctions(names, globals = {}) {
  const source = read('public/app.js');
  const declarations = names.map((name) => extractFunction(source, name)).join('\n');
  const context = vm.createContext({ URLSearchParams, Error, String, Number, Date, ...globals });
  vm.runInContext(`${declarations}\nthis.exports = { ${names.join(', ')} };`, context);
  return context.exports;
}

module.exports = { evaluateFunctions, read };
