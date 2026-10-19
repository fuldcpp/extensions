'use strict';

// The main-thread side of the worker: runs one operation in a new thread and resolves with its
// result. stopAll() ends every running thread (the extension is stopping).

const path = require('path');
const { Worker } = require('worker_threads');

// Where the WASM files and the 7-Zip glue are: beside the bundle (dist/vendor, copied there by
// scripts/copy-vendor.js) when bundled, in node_modules when running from the sources (tests)
const defaultVendor = (bundleDir) => {
  // eslint-disable-next-line no-undef
  if (typeof __non_webpack_require__ === 'function') {
    const v = path.join(bundleDir, 'vendor');
    return {
      unrarWasm: path.join(v, 'unrar.wasm'),
      sevenZipJs: path.join(v, '7z-wasm', '7zz.umd.js'),
      sevenZipWasm: path.join(v, '7z-wasm', '7zz.wasm'),
    };
  }

  const sevenDir = path.dirname(require.resolve('7z-wasm/package.json'));
  return {
    unrarWasm: path.join(path.dirname(require.resolve('node-unrar-js/package.json')), 'dist', 'js', 'unrar.wasm'),
    sevenZipJs: path.join(sevenDir, '7zz.umd.js'),
    sevenZipWasm: path.join(sevenDir, '7zz.wasm'),
  };
};

const createRunner = ({ workerFile, vendor }) => {
  const running = new Set();
  let stopping = false;

  // timeoutMs: a decoder that never finishes (a malformed archive looping in WASM) would hold
  // the one-at-a-time queue for good; past it the thread is ended and the run fails ('timeout')
  const run = (data, onProgress = () => {}, timeoutMs = 0) => new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const worker = new Worker(workerFile, { workerData: { ...data, vendor } });
    running.add(worker);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      running.delete(worker);
      fn(value);
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const e = new Error(`the unpacker thread did not finish within ${Math.max(1, Math.round(timeoutMs / 60000))} minute(s)`);
        e.reason = 'timeout';
        finish(reject, e);
        worker.terminate().catch(() => {});
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }

    worker.on('message', (message) => {
      if (!message) return;
      if (message.type === 'progress') {
        try { onProgress(message.bytes); } catch (error) { /* progress is only informative */ }
      } else if (message.type === 'done') {
        finish(resolve, message.result);
        worker.terminate().catch(() => {});
      } else if (message.type === 'failed') {
        const error = new Error(message.error.message);
        error.reason = message.error.reason;
        finish(reject, error);
        worker.terminate().catch(() => {});
      }
    });
    worker.on('error', (error) => {
      const e = new Error((error && error.message) || String(error));
      e.reason = /ENOSPC/.test(e.message) ? 'disk_full' : 'failed';
      finish(reject, e);
    });
    worker.on('exit', (code) => {
      // 'stopped' only when the extension is stopping: a thread that died on its own (out of
      // memory, a decoder abort) is a failure of that set, not a reason to give up the release
      const e = new Error(`the unpacker thread ended (${code})`);
      e.reason = stopping ? 'stopped' : 'failed';
      finish(reject, e);
    });
  });

  const stopAll = () => {
    stopping = true;
    for (const worker of running) {
      worker.terminate().catch(() => {});
    }
  };

  return { run, stopAll };
};

module.exports = { createRunner, defaultVendor };
