const fs = require('fs');

const WORKER_NODE_PATH = '/tmp/browser-automation-panel-node';
const WORKER_NODE_META_PATH = `${WORKER_NODE_PATH}.meta.json`;
const LEGACY_WORKER_NODE_PATH = '/tmp/node-openclaw';

function getSourceSignature(sourcePath) {
  const stat = fs.statSync(sourcePath);
  return {
    sourcePath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function readPreparedSignature() {
  try {
    return JSON.parse(fs.readFileSync(WORKER_NODE_META_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function signaturesMatch(left, right) {
  return Boolean(
    left
    && right
    && left.sourcePath === right.sourcePath
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
  );
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function ensureWorkerNodeBinary() {
  const sourceNode = process.execPath;
  if (!sourceNode || !fs.existsSync(sourceNode)) {
    throw new Error(`Node binary not found: ${sourceNode || '(empty)'}`);
  }

  const sourceSignature = getSourceSignature(sourceNode);
  if (
    isExecutable(WORKER_NODE_PATH)
    && signaturesMatch(readPreparedSignature(), sourceSignature)
  ) {
    return WORKER_NODE_PATH;
  }

  const suffix = `${process.pid}.${Date.now()}`;
  const tempNodePath = `${WORKER_NODE_PATH}.${suffix}.tmp`;
  const tempMetaPath = `${WORKER_NODE_META_PATH}.${suffix}.tmp`;

  try {
    fs.copyFileSync(sourceNode, tempNodePath);
    fs.chmodSync(tempNodePath, 0o755);
    fs.writeFileSync(tempMetaPath, JSON.stringify(sourceSignature));
    fs.renameSync(tempNodePath, WORKER_NODE_PATH);
    fs.renameSync(tempMetaPath, WORKER_NODE_META_PATH);

    // Remove the obsolete OpenClaw-era pathname. Processes already using the
    // old executable keep their open inode and are not interrupted.
    try { fs.rmSync(LEGACY_WORKER_NODE_PATH, { force: true }); } catch { /* ignore */ }

    return WORKER_NODE_PATH;
  } catch (error) {
    try { fs.rmSync(tempNodePath, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(tempMetaPath, { force: true }); } catch { /* ignore */ }
    throw new Error(
      `Failed to prepare worker node (${sourceNode} -> ${WORKER_NODE_PATH}): ${error.message}`
    );
  }
}

module.exports = {
  WORKER_NODE_PATH,
  WORKER_NODE_META_PATH,
  ensureWorkerNodeBinary,
};
