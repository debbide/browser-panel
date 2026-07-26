const db = require('../db');
const config = require('../../config');

const SYSTEM_PROTECTED_KEYS = new Set([
  'TASK_RESULT_PATH',
  'TASK_SCREENSHOT_PATH',
  'TASK_SCREENSHOT_DIR',
  'BROWSER_DISPLAY',
  'BROWSER_XAUTHORITY',
  'BROWSER_USER',
  'BROWSER_USER_DATA_DIR',
  'BROWSER_CHROME_PATH',
  'BROWSER_PROXY',
  'BROWSER_LOCALE',
  'BROWSER_TIMEZONE',
  'BROWSER_HEADLESS',
  'BROWSER_PROFILE_NAME',
  'BROWSER_RUNTIME_STACK',
  'BROWSER_USE_PLAYWRIGHT_EXTRA',
  'BROWSER_PLUGIN_PACKAGES',
  // Temp vs persistent must be system-owned so scripts (DP/SB) don't keep dirty dirs.
  'USE_TEMP_PROFILE',
  'use_temp_profile',
  'DISPLAY',
  'XAUTHORITY',
  'APP_ROOT',
  'LOGS_DIR',
  'SCREENSHOTS_DIR',
]);

const HOST_FORWARD_PREFIXES = ['CF_', 'HCAPTCHA_', 'CTF_'];

function toEnvValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function isTruthyEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function redactEnvValue(key, value) {
  const name = String(key || '').toUpperCase();
  if (/(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE|AUTH)/.test(name)) {
    return db.maskSecret(value);
  }
  const text = String(value || '');
  if (text.length > 120) return `${text.slice(0, 60)}…(${text.length} chars)`;
  return text;
}

function assignMap(target, source, { overwrite = true } = {}) {
  if (!source) return;
  for (const [key, value] of Object.entries(source)) {
    if (!key) continue;
    if (value === null || value === undefined || value === '') continue;
    if (!overwrite && target[key] !== undefined && target[key] !== '') continue;
    target[String(key)] = toEnvValue(value);
  }
}

function collectHostPrefixEnv(prefixes = HOST_FORWARD_PREFIXES) {
  const out = {};
  for (const [key, raw] of Object.entries(process.env || {})) {
    if (!key) continue;
    if (!prefixes.some((p) => key.startsWith(p))) continue;
    if (raw === undefined || raw === null || raw === '') continue;
    out[key] = String(raw);
  }
  return out;
}

function parseTaskParams(task) {
  return db.getTaskEnvMap(task);
}

function resolveUseTempProfile(task, params = parseTaskParams(task)) {
  if (isTruthyEnv(params.USE_TEMP_PROFILE)) return true;
  if (isTruthyEnv(params.use_temp_profile)) return true;
  return !(task && task.use_persistent);
}

function pickNonEmptyString(...values) {
  for (const value of values) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    if (text) return text;
  }
  return '';
}

/**
 * Proxy resolution (task-level first, so temp mode can set proxy without a data-dir profile):
 *   1) task env/params BROWSER_PROXY
 *   2) selected browser profile.proxy
 *   3) config.browser.proxy
 */
function resolveEffectiveProxy(task, profile = null) {
  const params = parseTaskParams(task) || {};
  const resolvedProfile = profile
    || (task && task._profile)
    || (task && task.browser_profile_id ? db.getBrowserProfile(task.browser_profile_id) : null);
  return pickNonEmptyString(
    params.BROWSER_PROXY,
    params.browser_proxy,
    resolvedProfile && resolvedProfile.proxy,
    config.browser.proxy || ''
  );
}

function applyVisionFallbacks(env) {
  const vision = db.getVisionSettings();
  if (vision.baseUrl && !env.VISION_BASE_URL) env.VISION_BASE_URL = vision.baseUrl;
  if (vision.apiKey && !env.VISION_API_KEY) env.VISION_API_KEY = vision.apiKey;
  if (vision.model && !env.VISION_MODEL) env.VISION_MODEL = vision.model;
  if (vision.channels && !env.VISION_CHANNELS) env.VISION_CHANNELS = vision.channels;
}

/** Default ON. Task may set USE_GLOBAL_TELEGRAM=0 to disable injecting panel Telegram into script env. */
function wantsGlobalTelegram(env = {}) {
  const raw = env.USE_GLOBAL_TELEGRAM ?? env.use_global_telegram;
  if (raw === undefined || raw === null || String(raw).trim() === '') return true;
  return isTruthyEnv(raw);
}

/**
 * Inject panel Telegram settings for scripts (TG_TOKEN / TG_CHAT_ID / aliases).
 * force=true: always overwrite (when task opted into global TG).
 * force=false: only fill missing keys.
 */
function applyTelegramFallbacks(env, { force = false } = {}) {
  const telegram = db.getTelegramSettings();
  if (!telegram) return;
  if (telegram.botToken) {
    if (force || !env.TG_BOT_TOKEN) env.TG_BOT_TOKEN = telegram.botToken;
    if (force || !env.TG_TOKEN) env.TG_TOKEN = telegram.botToken;
  }
  if (telegram.chatId) {
    if (force || !env.TG_CHAT_ID) env.TG_CHAT_ID = telegram.chatId;
    if (force || !env.CHAT_ID) env.CHAT_ID = telegram.chatId;
  }
  if (telegram.proxy) {
    if (force || !env.TG_PROXY) env.TG_PROXY = telegram.proxy;
    if (force || !env.TG_PROXY_URL) env.TG_PROXY_URL = telegram.proxy;
  }
}

function applyVisionTelegramFallbacks(env) {
  applyVisionFallbacks(env);
  if (wantsGlobalTelegram(env)) {
    applyTelegramFallbacks(env, { force: false });
  }
}

function applyGithubCompat(env) {
  if (!db.isGithubCompatEnabled()) return;
  if (!env.GITHUB_ACTIONS) env.GITHUB_ACTIONS = 'true';
  if (!env.CI) env.CI = 'true';
}

/** Common proxy env names used by GitHub / SeleniumBase / requests scripts. */
const PROXY_ALIAS_KEYS = [
  'PROXY',
  'proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
];

/**
 * Fill GitHub-style proxy / chrome / artifact aliases without overwriting user values.
 * Source of truth for proxy: BROWSER_PROXY, else PROXY / proxy.
 */
function applyProxyAliases(env, { overwrite = false } = {}) {
  if (!env || typeof env !== 'object') return env;

  const browserProxy = String(env.BROWSER_PROXY || '').trim();
  const legacyProxy = String(env.PROXY || env.proxy || '').trim();
  const effectiveProxy = browserProxy || legacyProxy;

  if (effectiveProxy) {
    if (overwrite || !String(env.BROWSER_PROXY || '').trim()) {
      env.BROWSER_PROXY = effectiveProxy;
    }
    for (const key of PROXY_ALIAS_KEYS) {
      if (overwrite || !String(env[key] || '').trim()) {
        env[key] = effectiveProxy;
      }
    }
  }

  const chrome = String(env.BROWSER_CHROME_PATH || env.CHROME_PATH || env.CHROMIUM_PATH || '').trim();
  if (chrome) {
    if (overwrite || !String(env.BROWSER_CHROME_PATH || '').trim()) {
      env.BROWSER_CHROME_PATH = chrome;
    }
    if (overwrite || !String(env.CHROME_PATH || '').trim()) env.CHROME_PATH = chrome;
    if (overwrite || !String(env.CHROMIUM_PATH || '').trim()) env.CHROMIUM_PATH = chrome;
  }

  const shotDir = String(
    env.TASK_SCREENSHOT_DIR || env.ARTIFACTS_DIR || env.SCREENSHOT_DIR || ''
  ).trim();
  if (shotDir) {
    if (overwrite || !String(env.TASK_SCREENSHOT_DIR || '').trim()) {
      env.TASK_SCREENSHOT_DIR = shotDir;
    }
    if (overwrite || !String(env.ARTIFACTS_DIR || '').trim()) env.ARTIFACTS_DIR = shotDir;
    if (overwrite || !String(env.SCREENSHOT_DIR || '').trim()) env.SCREENSHOT_DIR = shotDir;
  }

  return env;
}

/** Always-on script compat (safe even when GitHub compat flag is off). */
function applyScriptCompatEnv(env) {
  if (!env || typeof env !== 'object') return env;
  if (!String(env.PYTHONUNBUFFERED || '').trim()) {
    env.PYTHONUNBUFFERED = '1';
  }
  applyProxyAliases(env, { overwrite: false });
  return env;
}

/**
 * Merge user-configured env layers (no system browser/task paths).
 * Order: host prefixes → global env_entries → profile → task → vision → telegram (optional) → github compat
 */
function buildUserEnvLayers(task = null) {
  const env = {};

  assignMap(env, collectHostPrefixEnv());
  assignMap(env, db.getGlobalEnvMap());

  const profileId = task && (task.browser_profile_id || (task._profile && task._profile.id));
  if (profileId) {
    assignMap(env, db.getProfileEnvMap(profileId));
  }

  if (task) {
    // lazy migrate params_json → env_entries once
    try {
      db.migrateTaskParamsToEnvIfNeeded(task);
    } catch {
      // ignore migration errors at runtime
    }
    assignMap(env, db.getTaskEnvMap(task));
  }

  applyVisionFallbacks(env);

  // Task switch USE_GLOBAL_TELEGRAM (default on): force panel Telegram into script env
  // so game4free-style scripts get TG_TOKEN without per-task copy.
  if (wantsGlobalTelegram(env)) {
    applyTelegramFallbacks(env, { force: true });
  }

  applyGithubCompat(env);
  applyScriptCompatEnv(env);
  return env;
}

function forceSystemKeys(env, system = {}) {
  for (const [key, value] of Object.entries(system || {})) {
    if (!key) continue;
    if (value === null || value === undefined) continue;
    env[String(key)] = toEnvValue(value);
  }
  return env;
}

/**
 * Foreground (non-su) process env.
 */
function buildForegroundEnv(task, { screenshotPath } = {}) {
  const env = { ...process.env };
  const user = buildUserEnvLayers(task);
  assignMap(env, user, { overwrite: true });

  const params = parseTaskParams(task);
  const useTempProfile = resolveUseTempProfile(task, params);
  const system = {
    APP_ROOT: config.paths.root,
    LOGS_DIR: config.paths.logsDir,
    SCREENSHOTS_DIR: config.paths.screenshotsDir,
  };
  if (screenshotPath) system.TASK_SCREENSHOT_PATH = screenshotPath;

  if (task && task.use_browser) {
    const profile = task._profile || null;
    system.BROWSER_DISPLAY = config.browser.display;
    system.BROWSER_XAUTHORITY = config.browser.xauthority;
    system.BROWSER_USER = config.browser.user;
    // Temp mode: leave USER_DATA_DIR empty here; browser-launcher / task-runner
    // set a per-run dir and inject USE_TEMP_PROFILE=1 so scripts cleanup after quit.
    system.BROWSER_USER_DATA_DIR = useTempProfile
      ? ''
      : (profile && profile.user_data_dir) || (task.use_persistent ? config.browser.userDataDir : '');
    system.USE_TEMP_PROFILE = useTempProfile ? '1' : '0';
    // Panel global setting (DB) overrides env/config default when set
    try {
      const br = db.getBrowserRuntimeSettings();
      system.BROWSER_CHROME_PATH = (br && br.chromePath) || config.browser.chromePath;
    } catch {
      system.BROWSER_CHROME_PATH = config.browser.chromePath;
    }
    system.BROWSER_PROXY = resolveEffectiveProxy(task, profile);
    system.BROWSER_LOCALE = (profile && profile.locale) || config.browser.locale;
    system.BROWSER_TIMEZONE = (profile && profile.timezone_id) || config.browser.timezoneId;
    system.BROWSER_HEADLESS = 'false';
  }

  forceSystemKeys(env, system);
  // After system BROWSER_PROXY / chrome path are forced, expand GitHub-style aliases.
  applyScriptCompatEnv(env);
  return env;
}

/**
 * Browser launcher: returns ordered [key, value] pairs for shell injection.
 * System pairs should be applied by caller first (or pass system map).
 */
function buildBrowserUserEnvPairs(task) {
  const env = buildUserEnvLayers(task);
  // Strip keys that must only come from system layer
  for (const key of SYSTEM_PROTECTED_KEYS) {
    // still allow user to set non-conflicting; system forced later
    // do not delete user VISION etc.
  }
  return Object.entries(env)
    .filter(([k, v]) => k && v !== undefined && v !== null && v !== '')
    .sort((a, b) => a[0].localeCompare(b[0]));
}

function envObjectToPairs(env) {
  return Object.entries(env || {})
    .filter(([k, v]) => k && v !== undefined && v !== null && String(v) !== '')
    .sort((a, b) => a[0].localeCompare(b[0]));
}

function summarizeEnvPairs(pairs) {
  return pairs.map(([k, v]) => `${k}=${redactEnvValue(k, v)}`).join(', ');
}

module.exports = {
  SYSTEM_PROTECTED_KEYS,
  PROXY_ALIAS_KEYS,
  toEnvValue,
  isTruthyEnv,
  redactEnvValue,
  parseTaskParams,
  resolveUseTempProfile,
  resolveEffectiveProxy,
  pickNonEmptyString,
  buildUserEnvLayers,
  buildForegroundEnv,
  buildBrowserUserEnvPairs,
  forceSystemKeys,
  envObjectToPairs,
  summarizeEnvPairs,
  applyVisionTelegramFallbacks,
  applyTelegramFallbacks,
  applyProxyAliases,
  applyScriptCompatEnv,
  applyGithubCompat,
  wantsGlobalTelegram,
};
