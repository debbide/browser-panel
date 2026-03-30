const path = require('path');

module.exports = {
  server: {
    port: Number(process.env.PORT || 3210),
    host: process.env.HOST || '0.0.0.0',
  },
  browser: {
    display: process.env.BROWSER_DISPLAY || ':1.0',
    xauthority: process.env.BROWSER_XAUTHORITY || '/home/abc61154321/.Xauthority',
    user: process.env.BROWSER_USER || 'abc61154321',
    userDataDir: process.env.BROWSER_USER_DATA_DIR || '/home/abc61154321/browser-work/persistent',
    chromePath: process.env.BROWSER_CHROME_PATH || '/usr/bin/google-chrome',
    proxy: process.env.BROWSER_PROXY || 'socks5://127.0.0.1:7891',
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
