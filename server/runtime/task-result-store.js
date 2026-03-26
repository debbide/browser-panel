const fs = require('fs');
const path = require('path');
const config = require('../../config');

const resultDir = path.join(config.paths.dataDir, 'task-results');
fs.mkdirSync(resultDir, { recursive: true });

function getResultPath(runId) {
  return path.join(resultDir, `run-${runId}.json`);
}

function writeResult(runId, payload) {
  fs.writeFileSync(getResultPath(runId), JSON.stringify(payload, null, 2));
}

function readResult(runId) {
  const file = getResultPath(runId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function clearResult(runId) {
  const file = getResultPath(runId);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

module.exports = {
  writeResult,
  readResult,
  clearResult,
  getResultPath,
};
