require('source-map-support').install();

const { isMainThread } = require('worker_threads');

if (!isMainThread) {
  // The same file runs the unpacking threads (see runner.js): the client installs one bundle
  require('./worker').start();
} else {
  // A rejected promise nobody waited for would otherwise end the process; log it instead. Only
  // the error's own message is printed.
  process.on('unhandledRejection', (reason) => {
    const text = (reason && (reason.message || reason.code)) || String(reason);
    // eslint-disable-next-line no-console
    console.error(`airdcpp-release-unpacker: unhandled rejection: ${text}`);
  });

  const { ManagedExtension } = require('airdcpp-extension');
  const createMain = require('./main.js');

  // Entry point run by the client's extension manager. __filename is this bundle (webpack keeps
  // it for node targets), which the worker threads run as well.
  ManagedExtension((socket, extension) => createMain(socket, extension, { workerFile: __filename }), {});
}
