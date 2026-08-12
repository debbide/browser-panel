const core = require('../../extension/shared/export-core');
const { analyzeIrSupport } = require('../step-catalog');

function generateSeleniumBase(ir) {
  const steps = Array.isArray(ir?.steps) ? ir.steps : [];
  const support = analyzeIrSupport({ steps }, 'seleniumbase');
  const code = core.generateSeleniumBaseScript(ir);

  if (!support.unsupported.length && !support.invalid.length) {
    return code;
  }

  const lines = code.split('\n');
  const insertIndex = lines.findIndex((line) => line.includes('sb.open('));
  if (insertIndex < 0) return code;

  const warnings = [];
  warnings.push('        # export warnings:');
  for (const item of support.unsupported) {
    warnings.push(`        # - unsupported [${item.index}] type=${item.type} id=${item.id}`);
  }
  for (const item of support.invalid) {
    warnings.push(`        # - invalid [${item.index}] type=${item.type} missing=${item.missingFields.join(',')} id=${item.id}`);
  }

  lines.splice(insertIndex + 1, 0, ...warnings);
  return lines.join('\n');
}

module.exports = {
  generateSeleniumBase,
};
