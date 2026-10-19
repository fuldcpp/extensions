'use strict';

// The worker thread side: one operation (list or extract one set), then the thread ends. A new
// thread per operation also means a fresh WASM heap each time.

const { parentPort, workerData } = require('worker_threads');

const { listArchive, extractArchive } = require('./engine');

const start = () => {
  const job = workerData;
  const send = (message) => parentPort.postMessage(message);
  const op = job.op === 'extract' ? extractArchive : listArchive;
  Promise.resolve()
    .then(() => op({ ...job, onProgress: (bytes) => send({ type: 'progress', bytes }) }))
    .then((result) => send({ type: 'done', result }))
    .catch((error) => send({
      type: 'failed',
      error: { reason: (error && error.reason) || 'failed', message: (error && (error.message || error.code)) || String(error) },
    }));
};

module.exports = { start };
