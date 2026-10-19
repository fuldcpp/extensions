'use strict';

// A worker that dies on its own for RAR sets (as on out of memory) and works for the others
// (main.test.js)
const { workerData } = require('worker_threads');

if (workerData.kind === 'rar') {
  process.exit(3);
} else {
  require('../../src/worker').start();
}
