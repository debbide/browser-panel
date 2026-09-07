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
  let signatureIndex = match.index + match[0].length;
  let parenDepth = 1;
  let signatureQuote = null;
  let signatureEscaped = false;
  for (; signatureIndex < source.length; signatureIndex += 1) {
    const char = source[signatureIndex];
    if (signatureEscaped) {
      signatureEscaped = false;
      continue;
    }
    if (char === '\\') {
      signatureEscaped = true;
      continue;
    }
    if (signatureQuote) {
      if (char === signatureQuote) signatureQuote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      signatureQuote = char;
      continue;
    }
    if (char === '(') parenDepth += 1;
    if (char === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) break;
    }
  }
  const braceStart = source.indexOf('{', signatureIndex + 1);
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

function evaluateFunctions(names, globals = {}, accessors = {}) {
  const source = `${read('public/core/dom.js')}\n${read('public/panel-runtime.js')}`;
  const declarations = names.map((name) => extractFunction(source, name)).join('\n');
  const context = vm.createContext({ URLSearchParams, Error, String, Number, Date, ...globals });
  const accessorDeclarations = Object.entries(accessors)
    .map(([name, expression]) => `${name}: () => (${expression})`)
    .join(', ');
  vm.runInContext(`${declarations}\nthis.exports = { ${names.join(', ')}${accessorDeclarations ? `, ${accessorDeclarations}` : ''} };`, context);
  return context.exports;
}

module.exports = { evaluateFunctions, extractFunction, read };
