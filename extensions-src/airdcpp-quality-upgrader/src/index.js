require('source-map-support').install();

const { ManagedExtension } = require('airdcpp-extension');

// A rejected promise nobody caught must not end the extension
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('Unhandled rejection:', reason && reason.message ? reason.message : String(reason));
});

// Entry point run by the client's extension manager
ManagedExtension(require('./main.js'), {});
