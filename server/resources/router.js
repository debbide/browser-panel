const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const express = require('express');

const ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.tar.gz', '.tgz'];

function normalizeRelativePath(value = '') {
  const raw = String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const parts = raw.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..' || part.includes('\0'))) {
    throw new Error('路径不合法');
  }
  return parts.join('/');
}

function resolveInside(rootDir, value = '') {
  const root = path.resolve(rootDir);
  const rel = normalizeRelativePath(value);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) {
    throw new Error('路径超出允许目录');
  }
  return { root, rel, abs };
}

function validateName(value) {
  const name = String(value || '').trim();
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error('名称不合法');
  }
  return name;
}

function isArchive(name) {
  const lower = String(name || '').toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function archiveBaseName(name) {
  const lower = String(name || '').toLowerCase();
  const ext = ARCHIVE_EXTENSIONS.find((candidate) => lower.endsWith(candidate));
  return ext ? String(name).slice(0, -ext.length) : String(name);
}

function runArchiveCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stderr || ''}\n${result.stdout || ''}`.trim().slice(-2000);
    throw new Error(detail || `解压命令失败，退出码 ${result.status}`);
  }
  return result;
}

function listArchiveEntries(archivePath) {
  const lower = archivePath.toLowerCase();
  const result = lower.endsWith('.zip')
    ? runArchiveCommand('unzip', ['-Z1', archivePath])
    : runArchiveCommand('tar', ['-tf', archivePath]);
  return String(result.stdout || '').split(/\r?\n/).filter(Boolean);
}

function validateArchiveEntries(entries) {
  if (entries.length > 100000) throw new Error('压缩包文件数量过多');
  for (const entry of entries) {
    const normalized = String(entry || '').replace(/\\/g, '/');
    if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) {
      throw new Error(`压缩包包含绝对路径: ${entry}`);
    }
    if (normalized.split('/').some((part) => part === '..')) {
      throw new Error(`压缩包包含越界路径: ${entry}`);
    }
  }
}

function extractArchive(archivePath, destination) {
  const lower = archivePath.toLowerCase();
  if (lower.endsWith('.zip')) {
    runArchiveCommand('unzip', ['-q', archivePath, '-d', destination]);
    return;
  }
  runArchiveCommand('tar', ['-xf', archivePath, '-C', destination, '--no-same-owner', '--no-same-permissions']);
}

function ensureNoSymlinks(rootDir) {
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error(`压缩包包含符号链接: ${entry.name}`);
      if (stat.isDirectory()) stack.push(target);
    }
  }
}

function copyExtractedTree(source, destination, overwrite) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (fs.existsSync(to) && !overwrite) {
      throw new Error(`目标已存在: ${entry.name}`);
    }
    fs.cpSync(from, to, { recursive: true, force: overwrite, errorOnExist: !overwrite });
  }
}

function createResourceRouter({ rootDir, label, isBusy = () => false }) {
  const router = express.Router();
  fs.mkdirSync(rootDir, { recursive: true });

  router.get('/', (req, res) => {
    try {
      const { abs, rel } = resolveInside(rootDir, req.query.path || '');
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
        return res.status(404).json({ message: '目录不存在' });
      }
      const entries = fs.readdirSync(abs, { withFileTypes: true }).map((entry) => {
        const childAbs = path.join(abs, entry.name);
        const stat = fs.lstatSync(childAbs);
        return {
          name: entry.name,
          path: rel ? `${rel}/${entry.name}` : entry.name,
          type: entry.isDirectory() ? 'dir' : 'file',
          size: entry.isFile() ? stat.size : 0,
          mtime: stat.mtime.toISOString(),
          archive: entry.isFile() && isArchive(entry.name),
          symlink: stat.isSymbolicLink(),
        };
      }).sort((a, b) => a.type === b.type
        ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
        : (a.type === 'dir' ? -1 : 1));
      res.json({ data: { path: rel, label, entries } });
    } catch (error) {
      res.status(400).json({ message: error.message || '读取目录失败' });
    }
  });

  router.post('/mkdir', (req, res) => {
    try {
      const name = validateName(req.body && req.body.name);
      const { abs: parentAbs, rel: parentRel } = resolveInside(rootDir, req.body && req.body.parent);
      if (isBusy(parentRel)) return res.status(409).json({ message: '目标目录正在被浏览器使用' });
      fs.mkdirSync(parentAbs, { recursive: true });
      const target = path.join(parentAbs, name);
      if (fs.existsSync(target)) return res.status(409).json({ message: '目标已存在' });
      fs.mkdirSync(target);
      res.json({ ok: true, data: { path: parentRel ? `${parentRel}/${name}` : name } });
    } catch (error) {
      res.status(400).json({ message: error.message || '创建目录失败' });
    }
  });

  router.post('/upload', (req, res) => {
    let target = '';
    let settled = false;

    function fail(status, message) {
      if (settled) return;
      settled = true;
      if (target) fs.rmSync(target, { force: true });
      if (!res.headersSent) res.status(status).json({ message });
    }

    try {
      const name = validateName(req.query.name);
      const { abs: parentAbs, rel: parentRel } = resolveInside(rootDir, req.query.parent || '');
      if (isBusy(parentRel)) return res.status(409).json({ message: '目标目录正在被浏览器使用' });
      fs.mkdirSync(parentAbs, { recursive: true });
      target = path.join(parentAbs, name);
      const overwrite = ['1', 'true', 'yes'].includes(String(req.query.overwrite || '').toLowerCase());
      const uploadId = String(req.query.uploadId || '').replace(/[^a-zA-Z0-9_-]/g, '');
      const chunkIndex = Number(req.query.chunkIndex);
      const chunkCount = Number(req.query.chunkCount);
      if (!uploadId || !Number.isInteger(chunkIndex) || !Number.isInteger(chunkCount)
        || chunkIndex < 0 || chunkCount < 1 || chunkIndex >= chunkCount) {
        return res.status(400).json({ message: '分片参数不合法' });
      }

      const tempTarget = path.join(parentAbs, `.${name}.${uploadId}.uploading`);
      target = tempTarget;
      if (chunkIndex === 0) {
        if (fs.existsSync(path.join(parentAbs, name)) && !overwrite) {
          return res.status(409).json({ message: '同名文件已存在' });
        }
        fs.rmSync(tempTarget, { force: true });
      } else if (!fs.existsSync(tempTarget)) {
        return res.status(409).json({ message: '上传会话不存在，请重新上传' });
      }

      const output = fs.createWriteStream(tempTarget, { flags: chunkIndex === 0 ? 'wx' : 'a' });
      output.on('error', (error) => fail(error.code === 'EEXIST' ? 409 : 500, error.message || '上传失败'));
      req.on('error', (error) => fail(400, error.message || '上传中断'));
      req.on('aborted', () => fail(400, '上传已中断'));
      output.on('finish', () => {
        if (settled) return;
        settled = true;
        const size = fs.statSync(tempTarget).size;
        const complete = chunkIndex === chunkCount - 1;
        if (complete) {
          const finalTarget = path.join(parentAbs, name);
          if (overwrite) fs.rmSync(finalTarget, { force: true });
          fs.renameSync(tempTarget, finalTarget);
          target = '';
        }
        res.json({
          ok: true,
          data: {
            path: parentRel ? `${parentRel}/${name}` : name,
            size,
            chunkIndex,
            chunkCount,
            complete,
          },
        });
      });
      req.pipe(output);
    } catch (error) {
      fail(400, error.message || '上传失败');
    }
  });

  router.post('/extract', (req, res) => {
    let staging = null;
    try {
      const payload = req.body || {};
      const archive = resolveInside(rootDir, payload.path || '');
      if (!archive.rel || !fs.existsSync(archive.abs) || !fs.statSync(archive.abs).isFile() || !isArchive(archive.abs)) {
        return res.status(400).json({ message: '请选择 ZIP、TAR、TAR.GZ 或 TGZ 文件' });
      }
      const parent = path.dirname(archive.rel) === '.' ? '' : path.dirname(archive.rel).replace(/\\/g, '/');
      const destinationRel = payload.mode === 'folder'
        ? (parent ? `${parent}/${validateName(archiveBaseName(path.basename(archive.rel)))}` : validateName(archiveBaseName(path.basename(archive.rel))))
        : parent;
      if (isBusy(destinationRel)) return res.status(409).json({ message: '目标目录正在被浏览器使用' });
      const destination = resolveInside(rootDir, destinationRel);
      const entries = listArchiveEntries(archive.abs);
      validateArchiveEntries(entries);
      staging = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-extract-'));
      extractArchive(archive.abs, staging);
      ensureNoSymlinks(staging);
      copyExtractedTree(staging, destination.abs, Boolean(payload.overwrite));
      res.json({ ok: true, data: { path: destination.rel, files: entries.length } });
    } catch (error) {
      res.status(400).json({ message: error.message || '解压失败' });
    } finally {
      if (staging) fs.rmSync(staging, { recursive: true, force: true });
    }
  });

  router.post('/rename', (req, res) => {
    try {
      const source = resolveInside(rootDir, req.body && req.body.path);
      if (!source.rel) return res.status(400).json({ message: '不能重命名根目录' });
      if (isBusy(source.rel)) return res.status(409).json({ message: '目录正在被浏览器使用' });
      const name = validateName(req.body && req.body.newName);
      const target = path.join(path.dirname(source.abs), name);
      resolveInside(rootDir, path.relative(rootDir, target));
      if (!fs.existsSync(source.abs)) return res.status(404).json({ message: '目标不存在' });
      if (fs.existsSync(target)) return res.status(409).json({ message: '新名称已存在' });
      fs.renameSync(source.abs, target);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ message: error.message || '重命名失败' });
    }
  });

  router.delete('/', (req, res) => {
    try {
      const target = resolveInside(rootDir, (req.body && req.body.path) || req.query.path || '');
      if (!target.rel) return res.status(400).json({ message: '不能删除根目录' });
      if (isBusy(target.rel)) return res.status(409).json({ message: '目录正在被浏览器使用' });
      if (!fs.existsSync(target.abs)) return res.status(404).json({ message: '目标不存在' });
      fs.rmSync(target.abs, { recursive: true, force: true });
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ message: error.message || '删除失败' });
    }
  });

  return router;
}

module.exports = { createResourceRouter };