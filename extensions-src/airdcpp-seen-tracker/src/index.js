require('source-map-support').install();

const { ManagedExtension } = require('airdcpp-extension');

// Entry point run by the client's extension manager
ManagedExtension(require('./main.js'), {});
