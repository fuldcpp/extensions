'use strict';

// Lists, then unpacks workerData's set with every file write failing as on a full disk
// (engine.test.js). Posts { reason, message } of the failure, or { reason: null }.
const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');

const { listArchive, extractArchive } = require('../../src/engine');

(async () => {
  const listing = await listArchive(workerData);
  const realWrite = fs.writeSync;
  fs.writeSync = function (fd, ...rest) {
    if (typeof fd === 'number' && fd > 2) {
      const e = new Error('ENOSPC: no space left on device, write');
      e.code = 'ENOSPC';
      throw e;
    }

    return realWrite.call(fs, fd, ...rest);
  };

  try {
    await extractArchive({ ...workerData, files: listing.entries.filter((e) => !e.directory), onProgress: () => {} });
    parentPort.postMessage({ reason: null });
  } catch (error) {
    parentPort.postMessage({ reason: error.reason, message: error.message });
  } finally {
    fs.writeSync = realWrite;
  }
})().catch((error) => parentPort.postMessage({ reason: 'setup', message: String(error && error.message) }));
