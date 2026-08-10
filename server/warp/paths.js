const path = require('path');
const config = require('../../config');

const ROOT = path.join(config.paths.root, 'runtime-data', 'warp');

module.exports = Object.freeze({
  root: ROOT,
  bin: path.join(ROOT, 'bin'),
  state: path.join(ROOT, 'state'),
  active: path.join(ROOT, 'state', 'active'),
  candidate: path.join(ROOT, 'state', 'candidate'),
  previous: path.join(ROOT, 'state', 'previous'),
  staging: path.join(ROOT, '.staging'),
  manifest: path.join(ROOT, 'component-manifest.json'),
  wgcf: path.join(ROOT, 'bin', 'wgcf'),
  wireproxy: path.join(ROOT, 'bin', 'wireproxy'),
});
