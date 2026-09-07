const express = require('express');

function createApp(options = {}) {
  const app = express();
  app.use(express.json({ limit: options.jsonLimit || '20mb' }));
  if (options.registerRoutes) options.registerRoutes(app);
  return app;
}

function createApplication(registerRoutes, options = {}) {
  return createApp({
    ...options,
    registerRoutes,
  });
}

module.exports = { createApp, createApplication };
