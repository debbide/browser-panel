const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('../config');
const { getBrowserWorkDir } = require('./browser');
const { isPanelTempProfileDir, shouldCleanupTmpEntry } = require('./runtime/browser-launcher');

const CATEGORY_KEYS = Object.freeze([
  'runArtifacts',
  'orphanLogs',
  'orphanScreenshots',
  'tempProfiles',
  'workerArtifacts',
  'tmpArtifacts',
]);

const CATEGORY_LABELS = Object.freeze({
  runArtifacts: '旧运行记录及产物',
  orphanLogs: '孤立日志',
  orphanScreenshots: '孤立截图',
  tempProfiles: '过期临时浏览器配置',
  workerArtifacts: 'Worker 重复产物',
  tmpArtifacts: '已知应用临时产物',
});

function isInside(root, candidate) {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  return target !== base && target.startsWith(`${base}${path.sep}`);
}

function normalizeRetentionDays(value, fallback = 30) {
  const days = Number(value);
  if (!Number.isFinite(days)) return fallback;
  return Math.min(3650, Math.max(1, Math.floor(days)));
}

function normalizeCategories(value) {
  if (value === undefined || value === null) return [...CATEGORY_KEYS];
  if (!Array.isArray(value)) throw new Error('categories 必须是固定类别数组');
  const invalid = value.find((key) => !CATEGORY_KEYS.includes(key));
  if (invalid) throw new Error(`不支持的清理类别: ${invalid}`);
  return [...new Set(value)];
}

// Cooperative multitasking: every N filesystem ops we yield to the event loop
// so a huge tree can never starve HTTP/SSE traffic. The awaits on fsp calls
// already yield between syscalls; the tick covers CPU-bound tight loops.
function createBudget() {
  return { ops: 0 };
}

async function tick(budget) {
  if (budget && (++budget.ops % 64 === 0)) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function getTreeSize(target, budget) {
  let total = 0;
  let stat;
  try { stat = await fsp.lstat(target); } catch { return 0; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return stat.size || 0;
  let entries = [];
  try { entries = await fsp.readdir(target); } catch { return 0; }
  for (const name of entries) {
    total += await getTreeSize(path.join(target, name), budget);
    await tick(budget);
  }
  return total;
}

async function getMtimeMs(target) {
  try { return Number((await fsp.stat(target)).mtimeMs) || 0; } catch { return 0; }
}

async function pathExists(target) {
  try { await fsp.access(target); return true; } catch { return false; }
}

async function listChildren(root, budget) {
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    await tick(budget);
    return entries.map((entry) => ({
      entry,
      path: path.join(root, entry.name),
    }));
  } catch {
    return [];
  }
}

function createCollector(cutoffMs, budget) {
  const seen = new Set();
  const items = [];
  async function add(category, target, root, detail = {}) {
    const resolved = path.resolve(String(target || ''));
    if (!root || !isInside(root, resolved) || seen.has(resolved)) return;
    if (!await pathExists(resolved)) return;
    const mtimeMs = await getMtimeMs(resolved);
    if (detail.requireStale !== false && (!mtimeMs || mtimeMs >= cutoffMs)) return;
    seen.add(resolved);
    items.push({
      category,
      path: resolved,
      bytes: await getTreeSize(resolved, budget),
      mtime: mtimeMs ? new Date(mtimeMs).toISOString() : null,
      runId: detail.runId || null,
      kind: detail.kind || 'file',
    });
    await tick(budget);
  }
  return { items, add };
}

async function collectCleanupItems(db, options = {}) {
  const retentionDays = normalizeRetentionDays(options.retentionDays);
  const categories = normalizeCategories(options.categories);
  const selected = new Set(categories);
  const cutoffMs = Date.now() - retentionDays * 86400000;
  const budget = createBudget();
  const collector = createCollector(cutoffMs, budget);
  const logsRoot = path.resolve(config.paths.logsDir);
  const screenshotsRoot = path.resolve(config.paths.screenshotsDir);
  const profilesRoot = path.resolve(config.paths.root, 'runtime-data', 'profiles');
  const workerRoot = path.resolve(getBrowserWorkDir());
  const workerScreenshotsRoot = path.join(workerRoot, 'screenshots');
  const workerResultsRoot = path.join(workerRoot, 'task-results');
  const runningTaskIds = new Set((options.runningTaskIds || []).map(Number));
  const allRuns = db.db.prepare('SELECT * FROM task_runs ORDER BY id DESC').all();
  const latestIds = new Set(db.db.prepare('SELECT MAX(id) AS id FROM task_runs GROUP BY task_id').all().map((row) => row.id));
  const referencedLogs = new Set();
  const referencedScreenshots = new Set();

  for (const run of allRuns) {
    if (run.log_path) referencedLogs.add(path.resolve(run.log_path));
    if (run.screenshot_path) referencedScreenshots.add(path.resolve(run.screenshot_path));
    if (run.screenshots_dir) referencedScreenshots.add(path.resolve(run.screenshots_dir));
  }

  const removableRuns = [];
  if (selected.has('runArtifacts')) {
    for (const run of allRuns) {
      const endedMs = Date.parse(run.ended_at || '');
      const oldEnough = Number.isFinite(endedMs) && endedMs < cutoffMs;
      const legacyEligible = Boolean(options.pruneOldRunRows) && !latestIds.has(run.id);
      if (run.status === 'running' || !run.ended_at || runningTaskIds.has(Number(run.task_id))) continue;
      if (!legacyEligible && (!oldEnough || latestIds.has(run.id))) continue;
      removableRuns.push(run);
      await collector.add('runArtifacts', run.log_path, logsRoot, { runId: run.id, kind: 'log', requireStale: false });
      await collector.add('runArtifacts', run.screenshot_path, screenshotsRoot, { runId: run.id, kind: 'screenshot', requireStale: false });
      await collector.add('runArtifacts', run.screenshots_dir, screenshotsRoot, { runId: run.id, kind: 'screenshots_dir', requireStale: false });
    }
  }

  if (selected.has('orphanLogs')) {
    for (const { entry, path: target } of await listChildren(logsRoot, budget)) {
      if (entry.isFile() && /^task-\d+-.*\.log$/i.test(entry.name) && !referencedLogs.has(path.resolve(target))) {
        await collector.add('orphanLogs', target, logsRoot, { kind: 'log' });
      }
    }
  }

  if (selected.has('orphanScreenshots')) {
    const scanScreenshots = async (root) => {
      for (const { entry, path: target } of await listChildren(root, budget)) {
        const resolved = path.resolve(target);
        if (referencedScreenshots.has(resolved)) continue;
        // Run dirs are `task-<id>[-<name slug>]-run-<runId>`; the slug is optional
        // so pre-rename dirs keep matching.
        if (entry.isDirectory() && root === path.join(screenshotsRoot, 'runs') && /^task-\d+-(?:.*-)?run-/i.test(entry.name)) {
          await collector.add('orphanScreenshots', target, screenshotsRoot, { kind: 'screenshots_dir' });
        } else if (entry.isFile() && /^task-\d+-.*\.(png|jpe?g|webp|gif)$/i.test(entry.name)) {
          await collector.add('orphanScreenshots', target, screenshotsRoot, { kind: 'screenshot' });
        }
      }
    };
    await scanScreenshots(screenshotsRoot);
    await scanScreenshots(path.join(screenshotsRoot, 'runs'));
  }

  if (selected.has('tempProfiles')) {
    for (const { entry, path: target } of await listChildren(profilesRoot, budget)) {
      const taskMatch = /^task-(\d+)-/i.exec(entry.name);
      if (taskMatch && runningTaskIds.has(Number(taskMatch[1]))) continue;
      if (entry.isDirectory() && isPanelTempProfileDir(target)) {
        await collector.add('tempProfiles', target, profilesRoot, { kind: 'profile' });
      }
    }
  }

  if (selected.has('workerArtifacts')) {
    for (const { entry, path: target } of await listChildren(workerResultsRoot, budget)) {
      const taskMatch = /^run-(\d+)-/i.exec(entry.name);
      if (taskMatch && runningTaskIds.has(Number(taskMatch[1]))) continue;
      if (entry.isFile() && /^run-[\w.-]+\.json$/i.test(entry.name)) {
        await collector.add('workerArtifacts', target, workerResultsRoot, { kind: 'result' });
      }
    }
    const scanWorkerShots = async (root) => {
      for (const { entry, path: target } of await listChildren(root, budget)) {
        const taskMatch = /^task-(\d+)-/i.exec(entry.name);
        if (taskMatch && runningTaskIds.has(Number(taskMatch[1]))) continue;
        if (entry.isDirectory() && root === path.join(workerScreenshotsRoot, 'runs') && /^task-\d+-run-/i.test(entry.name)) {
          await collector.add('workerArtifacts', target, workerScreenshotsRoot, { kind: 'screenshots_dir' });
        } else if (entry.isFile() && /^task-\d+-.*\.(png|jpe?g|webp|gif)$/i.test(entry.name)) {
          await collector.add('workerArtifacts', target, workerScreenshotsRoot, { kind: 'screenshot' });
        }
      }
    };
    await scanWorkerShots(workerScreenshotsRoot);
    await scanWorkerShots(path.join(workerScreenshotsRoot, 'runs'));
  }

  if (selected.has('tmpArtifacts')) {
    for (const { entry, path: target } of await listChildren('/tmp', budget)) {
      if (
        entry.name === 'browser-automation-panel-node'
        || entry.name === 'browser-automation-panel-node.meta.json'
      ) continue;
      const appSpecific = /^bap-stop-[A-Za-z0-9_-]+$/i.test(entry.name)
        || /^(?:bap|browser-panel)[_-]captcha[_-][A-Za-z0-9_.-]+$/i.test(entry.name)
        || /^dp_chrome_yolo_[A-Za-z0-9_-]+$/i.test(entry.name)
        || /^py-browser-task-[A-Za-z0-9_-]+$/i.test(entry.name);
      const knownBrowserTmp = (entry.isDirectory() || entry.isSymbolicLink())
        && shouldCleanupTmpEntry(entry.name, target, retentionDays * 86400000);
      if (appSpecific || knownBrowserTmp) {
        await collector.add('tmpArtifacts', target, '/tmp', { kind: 'tmp' });
      }
    }
  }

  return { retentionDays, categories, cutoff: new Date(cutoffMs).toISOString(), items: collector.items, removableRuns };
}

function summarize(collected, dryRun, failures = [], removedRunRows = 0) {
  const byCategory = {};
  for (const key of collected.categories) {
    byCategory[key] = { label: CATEGORY_LABELS[key], count: 0, bytes: 0 };
  }
  for (const item of collected.items) {
    const bucket = byCategory[item.category];
    if (bucket) {
      bucket.count += 1;
      bucket.bytes += item.bytes;
    }
  }
  return {
    dryRun,
    retentionDays: collected.retentionDays,
    cutoff: collected.cutoff,
    categories: collected.categories,
    count: collected.items.length,
    bytes: collected.items.reduce((sum, item) => sum + item.bytes, 0),
    runRows: collected.removableRuns.length,
    removedRunRows,
    byCategory,
    items: collected.items,
    failures,
  };
}

async function cleanupStorage(db, options = {}) {
  const dryRun = options.dryRun !== false;
  const collected = await collectCleanupItems(db, options);
  if (dryRun) return summarize(collected, true);

  const failures = [];
  const failedRunIds = new Set();
  let removed = 0;
  for (const item of collected.items) {
    try {
      await fsp.rm(item.path, { recursive: true, force: true });
    } catch (error) {
      failures.push({ path: item.path, category: item.category, message: error.message || String(error) });
      if (item.runId) failedRunIds.add(item.runId);
    }
    // Deletions run in libuv's threadpool, but we still yield regularly so a
    // huge batch cannot monopolize the loop between completions.
    if (++removed % 32 === 0) await new Promise((resolve) => setImmediate(resolve));
  }

  let removedRunRows = 0;
  const deleteRun = db.db.prepare('DELETE FROM task_runs WHERE id = ? AND status != ?');
  for (const run of collected.removableRuns) {
    if (failedRunIds.has(run.id)) continue;
    try {
      removedRunRows += deleteRun.run(run.id, 'running').changes || 0;
    } catch (error) {
      failures.push({ path: `task_runs/${run.id}`, category: 'runArtifacts', message: error.message || String(error) });
    }
  }
  return summarize(collected, false, failures, removedRunRows);
}

module.exports = {
  CATEGORY_KEYS,
  CATEGORY_LABELS,
  normalizeCategories,
  normalizeRetentionDays,
  collectCleanupItems,
  cleanupStorage,
};
