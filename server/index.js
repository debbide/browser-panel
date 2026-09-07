const application = require('./application');

if (require.main === module) {
  application.startServer();
  application.registerSignals();
}

module.exports = {
  app: application.app,
  startServer: application.startServer,
  closeCoreServices: application.closeCoreServices,
  shutdown: application.shutdown,
};
