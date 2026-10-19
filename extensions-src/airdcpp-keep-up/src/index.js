require('source-map-support').install();

const { ManagedExtension } = require('airdcpp-extension');

// A rejected promise nobody waited for would otherwise end the process; log it instead. Only the
// error's own message is printed (requests never carry secrets in their error messages here).
process.on('unhandledRejection', (reason) => {
  const text = (reason && (reason.message || reason.code)) || String(reason);
  // eslint-disable-next-line no-console
  console.error(`airdcpp-keep-up: unhandled rejection: ${text}`);
});

// Entry point run by the client's extension manager
ManagedExtension(require('./main.js'), {});
