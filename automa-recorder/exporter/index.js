const { generatePlaywright } = require('./targets/playwright');
const { generateSeleniumBase } = require('./targets/seleniumbase');

function generateFromIr(ir, target) {
  if (!ir || typeof ir !== 'object') {
    throw new Error('Invalid IR payload');
  }
  if (!Array.isArray(ir.steps)) {
    throw new Error('IR.steps must be an array');
  }

  switch (target) {
    case 'playwright':
      return generatePlaywright(ir);
    case 'seleniumbase':
      return generateSeleniumBase(ir);
    default:
      throw new Error(`Unsupported target: ${target}`);
  }
}

module.exports = {
  generateFromIr,
};
