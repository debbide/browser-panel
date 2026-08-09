const path = require('path');

// Generic defaults only — override with env on real hosts (do not put personal usernames here).
const browserUser = process.env.BROWSER_USER || 'browser';
const browserHome = process.env.BROWSER_HOME || path.join('/home', browserUser);
const browserWork = process.env.BROWSER_WORK_DIR || path.join(browserHome, 'browser-work');

module.exports = {
  server: {
    port: Number(process.env.PORT || 3210),
    host: process.env.HOST || '0.0.0.0',
  },
  browser: {
    display: process.env.BROWSER_DISPLAY || ':1.0',
    xauthority: process.env.BROWSER_XAUTHORITY || path.join(browserHome, '.Xauthority'),
    user: browserUser,
    home: browserHome,
    workDir: browserWork,
    userDataDir: process.env.BROWSER_USER_DATA_DIR || path.join(browserWork, 'persistent'),
    // Prefer env. Default is a common path; ARM snap hosts should set
    // BROWSER_CHROME_PATH=/snap/chromium/current/usr/lib/chromium-browser/chrome
    chromePath: process.env.BROWSER_CHROME_PATH || '/usr/bin/chromium-browser',
    // RuyiPage's patched Firefox runtime. Override on hosts that install it elsewhere.
    ruyiPath: process.env.BROWSER_RUYI_PATH || '/opt/ruyipage-firefox/firefox',
    proxy: process.env.BROWSER_PROXY || '',
    locale: process.env.BROWSER_LOCALE || 'zh-CN',
    timezoneId: process.env.BROWSER_TIMEZONE || 'Asia/Shanghai',
    extensions: process.env.BROWSER_EXTENSIONS || '',
    headless: false,
    viewport: { width: 1440, height: 900 },
    launchArgs: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
  paths: {
    root: __dirname,
    dataDir: path.join(__dirname, 'data'),
    dbFile: path.join(__dirname, 'data', 'app.db'),
    logsDir: path.join(__dirname, 'logs'),
    screenshotsDir: path.join(__dirname, 'screenshots'),
    tasksDir: path.join(__dirname, 'tasks'),
    publicDir: path.join(__dirname, 'public'),
  },
};
