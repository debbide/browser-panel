const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { spawn } = require('child_process');
const paths = require('./paths');
const { resolveRelease } = require('./release-manifest');

const ALLOWED_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const MAX_REDIRECTS = 5;

function warpError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

async function ensureDirectories() {
  await fsp.mkdir(paths.root, { recursive: true, mode: 0o700 });
  await fsp.mkdir(paths.bin, { recursive: true, mode: 0o755 });
  await fsp.mkdir(paths.state, { recursive: true, mode: 0o700 });
  await fsp.mkdir(paths.staging, { recursive: true, mode: 0o700 });
  await Promise.all([
    fsp.chmod(paths.root, 0o700),
    fsp.chmod(paths.bin, 0o755),
    fsp.chmod(paths.state, 0o700),
    fsp.chmod(paths.staging, 0o700),
  ]);
}

function downloadToFile(url, outputPath, expectedSize, redirects = 0) {
  if (redirects > MAX_REDIRECTS) {
    return Promise.reject(warpError('download_failed', 'Too many component download redirects'));
  }
  const target = new URL(url);
  if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) {
    return Promise.reject(warpError('download_failed', `Blocked component download host: ${target.hostname}`));
  }
  return new Promise((resolve, reject) => {
    const request = https.get(target, { headers: { 'User-Agent': 'browser-panel-warp-installer/1' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, target).toString();
        downloadToFile(next, outputPath, expectedSize, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(warpError('download_failed', `Component download returned HTTP ${response.statusCode}`));
        return;
      }
      const declared = Number(response.headers['content-length'] || 0);
      if (declared && declared !== expectedSize) {
        response.resume();
        reject(warpError('download_failed', `Unexpected component size: ${declared}`));
        return;
      }
      let received = 0;
      const file = fs.createWriteStream(outputPath, { mode: 0o600, flags: 'wx' });
      const fail = (error) => {
        file.destroy();
        fsp.rm(outputPath, { force: true }).finally(() => reject(error));
      };
      response.on('data', (chunk) => {
        received += chunk.length;
        if (received > expectedSize) {
          response.destroy(warpError('download_failed', 'Component download exceeded expected size'));
        }
      });
      response.on('error', (error) => fail(warpError('download_failed', error.message, error)));
      file.on('error', (error) => fail(warpError('download_failed', error.message, error)));
      file.on('finish', () => {
        file.close(() => {
          if (received !== expectedSize) {
            fsp.rm(outputPath, { force: true }).finally(() => reject(
              warpError('download_failed', `Incomplete component download: ${received}/${expectedSize}`)
            ));
            return;
          }
          resolve();
        });
      });
      response.pipe(file);
    });
    request.setTimeout(60000, () => request.destroy(warpError('download_failed', 'Component download timed out')));
    request.on('error', (error) => reject(error.code ? error : warpError('download_failed', error.message, error)));
  });
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(filePath);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', resolve);
    input.on('error', reject);
  });
  return hash.digest('hex');
}

function runTar(archivePath, outputDir) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archivePath, '-C', outputDir], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => reject(warpError('install_failed', error.message, error)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(warpError('install_failed', `Unable to extract wireproxy: ${stderr.trim() || `exit ${code}`}`));
    });
  });
}

async function syncFile(filePath) {
  const handle = await fsp.open(filePath, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function installComponent(component, options = {}) {
  const release = resolveRelease(component, options.arch || process.arch);
  await ensureDirectories();
  const token = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const stageDir = path.join(paths.staging, `${component}-${token}`);
  const archivePath = path.join(stageDir, release.asset);
  await fsp.mkdir(stageDir, { mode: 0o700 });
  try {
    await (options.download || downloadToFile)(release.url, archivePath, release.size);
    const digest = await sha256File(archivePath);
    if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(release.sha256))) {
      throw warpError('checksum_mismatch', `Checksum mismatch for ${component}`);
    }
    let binaryPath = archivePath;
    if (release.archive) {
      await (options.extract || runTar)(archivePath, stageDir);
      binaryPath = path.join(stageDir, release.binaryName);
    }
    const stat = await fsp.stat(binaryPath);
    if (!stat.isFile() || stat.size < 1024) throw warpError('install_failed', `Invalid ${component} executable`);
    await fsp.chmod(binaryPath, 0o755);
    await syncFile(binaryPath);
    const destination = options.destinationPath || paths[component];
    await fsp.rename(binaryPath, destination);
    await fsp.chmod(destination, 0o755);
    return { ...release, installedAt: new Date().toISOString() };
  } finally {
    await fsp.rm(stageDir, { recursive: true, force: true });
  }
}

async function readInstalledManifest() {
  try {
    return JSON.parse(await fsp.readFile(paths.manifest, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function componentsReady() {
  const manifest = await readInstalledManifest();
  if (!manifest || manifest.arch !== process.arch) return false;
  const expected = ['wgcf', 'wireproxy'];
  for (const component of expected) {
    if (!manifest.components || manifest.components[component].version !== resolveRelease(component).version) return false;
    try { await fsp.access(paths[component], fs.constants.X_OK); } catch { return false; }
  }
  return true;
}

async function installAll(options = {}) {
  await ensureDirectories();
  if (await componentsReady()) return readInstalledManifest();

  const token = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const bundleDir = path.join(paths.staging, `bundle-${token}`);
  const backupDir = path.join(bundleDir, 'previous');
  const components = {};
  const replaced = [];
  let previousManifest = null;
  await fsp.mkdir(backupDir, { recursive: true, mode: 0o700 });

  try {
    for (const component of ['wgcf', 'wireproxy']) {
      if (options.onProgress) options.onProgress({ step: `install_${component}`, progress: component === 'wgcf' ? 15 : 50 });
      const stagedPath = path.join(bundleDir, component);
      components[component] = await installComponent(component, { ...options, destinationPath: stagedPath });
    }

    try { previousManifest = await fsp.readFile(paths.manifest); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    for (const component of ['wgcf', 'wireproxy']) {
      const destination = paths[component];
      const backupPath = path.join(backupDir, component);
      try { await fsp.rename(destination, backupPath); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      try {
        await fsp.rename(path.join(bundleDir, component), destination);
        replaced.push(component);
      } catch (error) {
        try { await fsp.rename(backupPath, destination); } catch { /* restored below when available */ }
        throw error;
      }
    }

    const manifest = { arch: process.arch, installedAt: new Date().toISOString(), components };
    const tempManifest = path.join(bundleDir, 'component-manifest.json');
    await fsp.writeFile(tempManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await syncFile(tempManifest);
    await fsp.rename(tempManifest, paths.manifest);
    return manifest;
  } catch (error) {
    for (const component of replaced.reverse()) {
      await fsp.rm(paths[component], { force: true });
      try { await fsp.rename(path.join(backupDir, component), paths[component]); } catch { /* no previous binary */ }
    }
    if (previousManifest) {
      await fsp.writeFile(paths.manifest, previousManifest, { mode: 0o600 });
    } else {
      await fsp.rm(paths.manifest, { force: true });
    }
    throw error;
  } finally {
    await fsp.rm(bundleDir, { recursive: true, force: true });
  }
}

module.exports = {
  ALLOWED_HOSTS,
  ensureDirectories,
  downloadToFile,
  sha256File,
  installComponent,
  installAll,
  componentsReady,
  readInstalledManifest,
  warpError,
};
