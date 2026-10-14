'use strict';

// Storage of the seen records: a snapshot (seen.json) plus an append-only change log
// (seen.log, one JSON line per changed user). A busy hub changes a few records per second; with
// 100 000 records a full rewrite is ~14 MB, so only the changes are written often and the
// snapshot is rewritten rarely (compaction). Also alive.json: when this run was last alive.
//
// Everything is synchronous and small per call. On Windows the client ends an extension with
// TerminateProcess, so whatever is not on disk yet is lost: the log keeps that to seconds.

const fs = require('fs');
const path = require('path');

const { createStore } = require('./store');

const createPersistence = (dir, logger) => {
  const file = (name) => path.join(dir || '.', name);
  const SNAPSHOT = 'seen.json';
  const LOG = 'seen.log';
  const ALIVE = 'alive.json';

  const errorText = (error) => (error && (error.message || error.code)) || String(error);

  const writeAtomic = (name, text) => {
    const tmp = `${file(name)}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file(name));
  };

  // Snapshot + log replay. A bad snapshot or a torn last log line is skipped, not fatal.
  const load = () => {
    let users = {};
    try {
      const data = JSON.parse(fs.readFileSync(file(SNAPSHOT), 'utf8'));
      users = (data && data.users) || {};
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error(`Could not read ${SNAPSHOT}, starting from the change log only: ${errorText(error)}`);
      }
    }

    const store = createStore(users);
    let replayed = 0;
    try {
      for (const line of fs.readFileSync(file(LOG), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const [ cid, entry ] = JSON.parse(line);
          store.apply(cid, entry);
          replayed++;
        } catch (e) {
          // A line cut short by a kill mid-write
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error(`Could not read ${LOG}: ${errorText(error)}`);
      }
    }

    store.takeChanges(); // everything loaded is already on disk
    return { store, replayed };
  };

  // Appends the pending changes. Returns false (changes kept for the next try) on failure.
  const appendChanges = (store) => {
    const changes = store.takeChanges();
    if (changes.length === 0) {
      return true;
    }

    try {
      fs.appendFileSync(file(LOG), changes.map((c) => JSON.stringify(c)).join('\n') + '\n');
      return true;
    } catch (error) {
      store.restoreChanges(changes);
      logger.error(`Could not write ${LOG}: ${errorText(error)}`);
      return false;
    }
  };

  // Rewrites the snapshot and empties the log. Snapshot first: a kill between the two only
  // means the log is replayed over a snapshot that already contains it, which is harmless.
  const compact = (store) => {
    if (!appendChanges(store)) {
      return false;
    }

    try {
      writeAtomic(SNAPSHOT, JSON.stringify({ version: 1, users: store.toJSON() }));
      fs.writeFileSync(file(LOG), '');
      return true;
    } catch (error) {
      logger.error(`Could not compact ${SNAPSHOT}: ${errorText(error)}`);
      return false;
    }
  };

  const logSize = () => {
    try {
      return fs.statSync(file(LOG)).size;
    } catch (e) {
      return 0;
    }
  };

  const readAlive = () => {
    try {
      const data = JSON.parse(fs.readFileSync(file(ALIVE), 'utf8'));
      return data && typeof data.run === 'string' && typeof data.at === 'number' ? data : null;
    } catch (e) {
      return null;
    }
  };

  const writeAlive = (run, at) => {
    try {
      writeAtomic(ALIVE, JSON.stringify({ run, at }));
    } catch (error) {
      logger.error(`Could not write ${ALIVE}: ${errorText(error)}`);
    }
  };

  return { load, appendChanges, compact, logSize, readAlive, writeAlive };
};

module.exports = { createPersistence };
