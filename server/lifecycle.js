function createLifecycle(options) {
  if (!options || !options.app) throw new Error('app is required');
  if (typeof options.closeCoreServices !== 'function') throw new Error('closeCoreServices is required');

  let httpServer = null;
  let shutdownPromise = null;

  function startServer() {
    if (httpServer) return httpServer;
    httpServer = options.app.listen(options.port, options.host, () => {
      if (options.onStarted) options.onStarted();
    });
    return httpServer;
  }

  function shutdown(signal) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      await options.closeCoreServices(`received ${signal}`);
      if (httpServer) {
        await new Promise((resolve) => httpServer.close(resolve));
        httpServer = null;
      }
    })().catch((error) => {
      console.error('[shutdown] failed:', error);
      process.exitCode = 1;
    });
    return shutdownPromise;
  }

  return { startServer, shutdown };
}

function registerSignalHandlers(shutdown) {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      void shutdown(signal).finally(() => {
        // Re-raise the signal with its default disposition instead of a bare
        // process.exit(): exit() reports code 0, which systemd
        // Restart=on-failure reads as "clean shutdown" and will NOT restart
        // us — the panel then stays down (connection refused) until someone
        // notices. Dying by signal reports the truth and gets restarted.
        // (process.once already removed our handler, so the default action
        // applies again here.)
        process.kill(process.pid, signal);
      });
    });
  }
}

module.exports = { createLifecycle, registerSignalHandlers };
