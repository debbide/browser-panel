const { launchBrowser } = require('./browser-runtime');

let context = null;

async function main() {
  try {
    const launched = await launchBrowser({ headless: false });
    context = launched.context;
    process.stdout.write(`MANUAL_BROWSER_READY ${process.pid}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message || String(error)}\n`);
    process.exit(1);
  }
}

async function shutdown() {
  if (context) {
    try {
      await context.close();
    } catch (error) {
      process.stderr.write(`${error.stack || error.message || String(error)}\n`);
    }
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGHUP', shutdown);

main();
