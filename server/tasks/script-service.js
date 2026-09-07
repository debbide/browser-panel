'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EXTENSION_BY_TYPE = {
  javascript: '.js',
  python: '.py',
  php: '.php',
  shell: '.sh',
};

const TYPE_BY_EXTENSION = {
  '.js': 'javascript',
  '.py': 'python',
  '.php': 'php',
  '.sh': 'shell',
};

function createScriptService(dependencies) {
  const {
    tasksDir,
    listTasks,
    scanTaskDependencies,
    normalizeExtraPaths,
  } = dependencies;

  function reserveUniqueFilename(name, type) {
    const extension = EXTENSION_BY_TYPE[type];
    const base = path.basename(String(name || '')).replace(/\.[^./]+$/i, '');
    for (let index = 1; index < 1000; index += 1) {
      const filename = index === 1 ? `${base}${extension}` : `${base}-${index}${extension}`;
      const owner = listTasks().find((task) => task.script_path === `tasks/${filename}`);
      if (!owner && !fs.existsSync(path.join(tasksDir, filename))) return filename;
    }
    throw new Error('Unable to allocate an available script filename');
  }

  function importScript(payload = {}) {
    let name = path.basename(String(payload.name || '')).trim();
    const content = String(payload.content || '');
    if (!name) throw Object.assign(new Error('Script name is required'), { status: 400 });

    let requestedType = String(payload.type || '').trim().toLowerCase();
    if (!requestedType && !path.extname(name) && /^\s*<\?php\b/i.test(content)) requestedType = 'php';
    const requestedExtension = EXTENSION_BY_TYPE[requestedType];
    if (requestedExtension) name = name.replace(/\.[^./]+$/i, '') + requestedExtension;

    const extension = path.extname(name).toLowerCase();
    const type = TYPE_BY_EXTENSION[extension];
    if (!type) {
      throw Object.assign(new Error(`Only .js, .py, .php and .sh scripts are supported (received name=${JSON.stringify(name)}, type=${JSON.stringify(requestedType)})`), { status: 400 });
    }
    if (!content.trim()) throw Object.assign(new Error('Script content is required'), { status: 400 });

    fs.mkdirSync(tasksDir, { recursive: true });
    const overwrite = !(payload.overwrite === false || payload.overwrite === 0 || payload.overwrite === '0');
    const finalName = overwrite ? name : reserveUniqueFilename(name, type);
    const target = path.join(tasksDir, finalName);
    const existed = fs.existsSync(target);
    fs.writeFileSync(target, content, 'utf8');
    return {
      name: finalName,
      path: `tasks/${finalName}`,
      type,
      overwritten: Boolean(existed),
    };
  }

  function scanAssets(task) {
    const declared = normalizeExtraPaths(task.extra_paths);
    let found = [];
    let error = null;
    try {
      found = scanTaskDependencies(task.script_path).map((item) => item.path);
    } catch (scanError) {
      error = scanError.message || '扫描失败';
    }
    return {
      id: task.id,
      name: task.name,
      script_path: task.script_path,
      declared,
      found,
      paths: [...new Set([...declared, ...found])].sort(),
      error,
    };
  }

  return { importScript, reserveUniqueFilename, scanAssets };
}

module.exports = { createScriptService };
