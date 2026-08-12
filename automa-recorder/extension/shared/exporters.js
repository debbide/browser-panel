(function initAutomaSharedExporters() {
  const core = globalThis.AutomaExportCore || null;
  if (!core) {
    throw new Error('AutomaExportCore is missing');
  }
  globalThis.AutomaExporters = {
    generatePlaywrightScript: core.generatePlaywrightScript,
    generateSeleniumBaseScript: core.generateSeleniumBaseScript,
    generateScriptByTarget: core.generateScriptByTarget,
  };
})();
