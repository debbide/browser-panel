const express = require('express');

function createTaskStorageRouter({ fs, path, tasksDir, listTasks }) {
  const router = express.Router();
  const config = { paths: { tasksDir } };
  const db = { listTasks };

const TASKS_TEXT_EXTS = new Set([
  '.js', '.py', '.php', '.json', '.txt', '.md', '.env', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.sh', '.css', '.html', '.xml', '.csv',
]);
const TASKS_MAX_TEXT = 2 * 1024 * 1024;
const TASKS_MAX_UPLOAD = 15 * 1024 * 1024;

function resolveUnderTasks(relPath = '') {
  const raw = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/^tasks\//, '');
  if (raw.split('/').some((p) => p === '..')) {
    throw new Error('Invalid path');
  }
  const abs = path.resolve(config.paths.tasksDir, raw);
  const root = path.resolve(config.paths.tasksDir);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('Path escapes tasks directory');
  }
  return { abs, rel: raw.replace(/\\/g, '/'), root };
}

function isTextExt(name) {
  const ext = path.extname(name || '').toLowerCase();
  if (!ext) return true;
  return TASKS_TEXT_EXTS.has(ext);
}

function listTasksBoundToPath(relFromTasks) {
  const needle = `tasks/${String(relFromTasks || '').replace(/\\/g, '/')}`;
  return db.listTasks().filter((t) => {
    const sp = String(t.script_path || '').replace(/\\/g, '/');
    return sp === needle || sp.startsWith(`${needle}/`);
  });
}

// Task picker: entry scripts only.
// Default: top-level tasks/*.js|*.py (subfolders like host2play_dp/ are libraries, not task entries).
// Optional: ?recursive=1 to include nested files (file manager / advanced).
router.get('/scripts', (req, res) => {
  const allowedExts = new Set(['.js', '.py', '.php', '.sh']);
  const recursive = ['1', 'true', 'yes', 'on'].includes(
    String(req.query.recursive || '').trim().toLowerCase()
  );
  // Never offer package internals as runnable task scripts
  const skipNames = new Set([
    '__init__.py',
    '__main__.py',
    'conftest.py',
    'setup.py',
  ]);
  const out = [];
  function pushFile(rel, name) {
    if (skipNames.has(name)) return;
    if (name.startsWith('.') || name.endsWith('.pyc')) return;
    const ext = path.extname(name).toLowerCase();
    if (!allowedExts.has(ext)) return;
    out.push({
      name: rel,
      path: `tasks/${rel}`,
        type: ext === '.py' ? 'python' : ext === '.php' ? 'php' : ext === '.sh' ? 'shell' : 'javascript',
    });
  }
  function walk(dirAbs, relBase) {
    let entries = [];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '__pycache__' || entry.name.startsWith('.')) continue;
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      const abs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      pushFile(rel, entry.name);
    }
  }
  // Top-level only by default
  walk(config.paths.tasksDir, '');
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  res.json({ data: out });
});

// Recursive-aware file manager for tasks/
router.get('/tasks-fs', (req, res) => {
  try {
    const dirRel = String(req.query.path || '');
    const { abs, rel } = resolveUnderTasks(dirRel);
    if (!fs.existsSync(abs)) return res.status(404).json({ message: 'Directory not found' });
    if (!fs.statSync(abs).isDirectory()) return res.status(400).json({ message: 'Not a directory' });

    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.name !== '.' && e.name !== '..' && e.name !== '__pycache__' && !e.name.endsWith('.pyc'))
      .map((e) => {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        const childAbs = path.join(abs, e.name);
        let size = 0;
        let mtime = null;
        try {
          const st = fs.statSync(childAbs);
          size = st.isFile() ? st.size : 0;
          mtime = st.mtime.toISOString();
        } catch {
          // ignore
        }
        return {
          name: e.name,
          path: childRel,
          type: e.isDirectory() ? 'dir' : 'file',
          size,
          mtime,
          text: e.isFile() ? isTextExt(e.name) : false,
        };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });

    res.json({ data: { path: rel, entries } });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to list' });
  }
});

router.get('/tasks-fs/read', (req, res) => {
  try {
    const { abs, rel } = resolveUnderTasks(req.query.path || '');
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return res.status(404).json({ message: 'File not found' });
    }
    const st = fs.statSync(abs);
    if (st.size > TASKS_MAX_TEXT) {
      return res.status(400).json({ message: 'File too large to edit in browser' });
    }
    if (!isTextExt(path.basename(abs))) {
      return res.status(400).json({ message: 'Binary file — use download' });
    }
    const content = fs.readFileSync(abs, 'utf8');
    res.json({ data: { path: rel, name: path.basename(abs), content, size: st.size } });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to read' });
  }
});

router.get('/tasks-fs/download', (req, res) => {
  try {
    const { abs } = resolveUnderTasks(req.query.path || '');
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return res.status(404).json({ message: 'File not found' });
    }
    res.download(abs, path.basename(abs));
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to download' });
  }
});

router.put('/api/tasks-fs/write', (req, res) => {
  try {
    const payload = req.body || {};
    const { abs, rel } = resolveUnderTasks(payload.path || '');
    if (!rel) return res.status(400).json({ message: 'path required' });
    const content = payload.content == null ? '' : String(payload.content);
    if (Buffer.byteLength(content, 'utf8') > TASKS_MAX_TEXT) {
      return res.status(400).json({ message: 'Content too large' });
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    res.json({ ok: true, data: { path: rel, name: path.basename(abs) } });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to write' });
  }
});

router.put('/tasks-fs/write', (req, res) => {
  try {
    const payload = req.body || {};
    const { abs, rel } = resolveUnderTasks(payload.path || '');
    if (!rel) return res.status(400).json({ message: 'path required' });
    const content = payload.content == null ? '' : String(payload.content);
    if (Buffer.byteLength(content, 'utf8') > TASKS_MAX_TEXT) {
      return res.status(400).json({ message: 'Content too large' });
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    res.json({ ok: true, data: { path: rel, name: path.basename(abs) } });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to write' });
  }
});

router.post('/tasks-fs/mkdir', (req, res) => {
  try {
    const payload = req.body || {};
    const parent = String(payload.parent || payload.path || '');
    const name = String(payload.name || '').trim();
    if (!name || name.includes('/') || name.includes('\\') || name === '..') {
      return res.status(400).json({ message: 'Invalid folder name' });
    }
    const { abs: parentAbs, rel: parentRel } = resolveUnderTasks(parent);
    if (!fs.existsSync(parentAbs)) fs.mkdirSync(parentAbs, { recursive: true });
    if (!fs.statSync(parentAbs).isDirectory()) {
      return res.status(400).json({ message: 'Parent is not a directory' });
    }
    const target = path.join(parentAbs, name);
    if (fs.existsSync(target)) return res.status(409).json({ message: 'Already exists' });
    fs.mkdirSync(target, { recursive: false });
    const rel = parentRel ? `${parentRel}/${name}` : name;
    res.json({ ok: true, data: { path: rel, name, type: 'dir' } });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to mkdir' });
  }
});

router.post('/tasks-fs/create-file', (req, res) => {
  try {
    const payload = req.body || {};
    const parent = String(payload.parent || payload.path || '');
    let name = String(payload.name || '').trim();
    if (!name || name.includes('/') || name.includes('\\') || name === '..') {
      return res.status(400).json({ message: 'Invalid file name' });
    }
    if (!path.extname(name)) name = `${name}.py`;
    const { abs: parentAbs, rel: parentRel } = resolveUnderTasks(parent);
    fs.mkdirSync(parentAbs, { recursive: true });
    const target = path.join(parentAbs, name);
    if (fs.existsSync(target)) return res.status(409).json({ message: 'Already exists' });
    const content = payload.content != null ? String(payload.content) : '';
    fs.writeFileSync(target, content, 'utf8');
    const rel = parentRel ? `${parentRel}/${name}` : name;
    res.json({ ok: true, data: { path: rel, name, type: 'file' } });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to create file' });
  }
});

router.post('/tasks-fs/upload', (req, res) => {
  try {
    const payload = req.body || {};
    const parent = String(payload.parent || '');
    // Relative path under parent, e.g. "pkg/util.py" or just "a.py".
    // Folder upload sends webkitRelativePath-style paths so we mkdir -p.
    const rawRel = String(payload.relativePath || payload.path || payload.name || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .trim();
    if (!rawRel) return res.status(400).json({ message: 'Invalid file name' });
    const parts = rawRel.split('/').filter(Boolean);
    if (!parts.length || parts.some((p) => p === '..' || p === '.' || !p)) {
      return res.status(400).json({ message: 'Invalid relative path' });
    }
    // Skip junk that browsers sometimes include from folder pick
    if (parts.some((p) => p === '__pycache__' || p === '.git' || p === 'node_modules')) {
      return res.status(400).json({ message: 'Skipped system/cache path' });
    }
    const fileName = parts[parts.length - 1];
    if (!fileName || fileName === '..') {
      return res.status(400).json({ message: 'Invalid file name' });
    }
    const encoding = String(payload.encoding || 'utf8').toLowerCase();
    let buf;
    if (encoding === 'base64') {
      buf = Buffer.from(String(payload.content || ''), 'base64');
    } else {
      buf = Buffer.from(String(payload.content || ''), 'utf8');
    }
    if (buf.length > TASKS_MAX_UPLOAD) {
      return res.status(400).json({ message: `File too large (max ${TASKS_MAX_UPLOAD} bytes)` });
    }
    const { rel: parentRel } = resolveUnderTasks(parent);
    // Full path under tasks/: parent + relativePath (with intermediate dirs)
    const underParent = parts.join('/');
    const fullRel = parentRel ? `${parentRel}/${underParent}` : underParent;
    const { abs: target } = resolveUnderTasks(fullRel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buf);
    res.json({
      ok: true,
      data: {
        path: fullRel.replace(/\\/g, '/'),
        name: fileName,
        size: buf.length,
        relativePath: underParent,
      },
    });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to upload' });
  }
});

router.post('/tasks-fs/rename', (req, res) => {
  try {
    const payload = req.body || {};
    const { abs: fromAbs, rel: fromRel } = resolveUnderTasks(payload.path || '');
    const newName = path.basename(String(payload.newName || payload.name || '').trim());
    if (!newName || newName === '..') return res.status(400).json({ message: 'Invalid name' });
    if (!fs.existsSync(fromAbs)) return res.status(404).json({ message: 'Not found' });
    const toAbs = path.join(path.dirname(fromAbs), newName);
    const root = path.resolve(config.paths.tasksDir);
    if (!toAbs.startsWith(root + path.sep) && toAbs !== root) {
      return res.status(400).json({ message: 'Invalid target' });
    }
    if (fs.existsSync(toAbs)) return res.status(409).json({ message: 'Target exists' });
    const bound = listTasksBoundToPath(fromRel);
    if (bound.length) {
      return res.status(409).json({
        message: `仍被 ${bound.length} 个任务引用，请先改任务脚本路径`,
        tasks: bound.map((t) => ({ id: t.id, name: t.name })),
      });
    }
    fs.renameSync(fromAbs, toAbs);
    const parentRel = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/')) : '';
    const toRel = parentRel ? `${parentRel}/${newName}` : newName;
    res.json({ ok: true, data: { path: toRel, name: newName } });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to rename' });
  }
});

router.delete('/tasks-fs', (req, res) => {
  try {
    const raw = String((req.body && req.body.path) || req.query.path || '').trim();
    const { abs, rel } = resolveUnderTasks(raw);
    if (!rel) return res.status(400).json({ message: 'Cannot delete tasks root' });
    if (!fs.existsSync(abs)) return res.status(404).json({ message: 'Not found' });
    const bound = listTasksBoundToPath(rel);
    if (bound.length) {
      return res.status(409).json({
        message: `仍被 ${bound.length} 个任务使用，请先改任务或删任务`,
        tasks: bound.map((t) => ({ id: t.id, name: t.name })),
      });
    }
    fs.rmSync(abs, { recursive: true, force: true });
    res.json({ ok: true, data: { path: rel } });
  } catch (error) {
    res.status(400).json({ message: error.message || 'Failed to delete' });
  }
});


router.delete('/scripts', (req, res) => {
  try {
    const raw = String((req.body && (req.body.path || req.body.name)) || req.query.path || req.query.name || '').trim();
    if (!raw) return res.status(400).json({ message: 'Script path is required' });
    const fileName = path.basename(raw.replace(/^tasks[\\/]/, ''));
    const ext = path.extname(fileName).toLowerCase();
    if (!['.js', '.py', '.php', '.sh'].includes(ext)) {
      return res.status(400).json({ message: 'Only .js, .py, .php and .sh scripts can be deleted' });
    }
    const target = path.join(config.paths.tasksDir, fileName);
    if (!fs.existsSync(target)) {
      return res.status(404).json({ message: 'Script not found' });
    }
    const rel = `tasks/${fileName}`;
    const bound = db.listTasks().filter((t) => String(t.script_path || '').replace(/\\/g, '/') === rel);
    if (bound.length) {
      return res.status(409).json({
        message: `脚本仍被 ${bound.length} 个任务使用，请先改任务脚本或删任务`,
        tasks: bound.map((t) => ({ id: t.id, name: t.name })),
      });
    }
    fs.unlinkSync(target);
    res.json({ ok: true, data: { name: fileName, path: rel } });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Failed to delete script' });
  }
});


  return router;
}

module.exports = { createTaskStorageRouter };
