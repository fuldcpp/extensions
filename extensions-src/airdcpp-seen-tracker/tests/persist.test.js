'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPersistence } = require('../src/persist');

const quiet = { error() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'seen-persist-'));
const user = (nick, cid) => ({ nick, cid, hub_name: 'H', hub_url: 'adc://h', flags: [] });

test('a failed log write keeps the changes for the next write', () => {
  const dir = tmp();
  const p = createPersistence(dir, quiet);
  const { store } = p.load();
  store.record(user('a', 'C1'), 'left', 1);

  fs.mkdirSync(path.join(dir, 'seen.log')); // a folder where the log file must go: the append fails
  assert.equal(p.appendChanges(store), false);
  assert.equal(store.pendingChanges(), 1);

  fs.rmdirSync(path.join(dir, 'seen.log'));
  assert.equal(p.appendChanges(store), true);
  assert.equal(store.pendingChanges(), 0);
  assert.equal(p.load().store.find('a').length, 1);
});

test('a torn last log line (killed mid-write) is skipped, the rest replays', () => {
  const dir = tmp();
  const p = createPersistence(dir, quiet);
  const { store } = p.load();
  store.record(user('a', 'C1'), 'left', 1);
  store.record(user('b', 'C2'), 'left', 2);
  p.appendChanges(store);
  fs.appendFileSync(path.join(dir, 'seen.log'), '["C3",{"nick":"c","hu');
  const { store: again, replayed } = p.load();
  assert.equal(replayed, 2);
  assert.equal(again.size(), 2);
});

test('compaction writes the snapshot, empties the log, and loads back the same', () => {
  const dir = tmp();
  const p = createPersistence(dir, quiet);
  const { store } = p.load();
  for (let i = 0; i < 50; i++) store.record(user(`u${i}`, `C${i}`), 'left', i);
  p.appendChanges(store);
  assert.ok(p.logSize() > 0);
  assert.equal(p.compact(store), true);
  assert.equal(p.logSize(), 0);
  assert.equal(p.load().store.size(), 50);
});

test('alive.json round trip; a broken one reads as absent', () => {
  const dir = tmp();
  const p = createPersistence(dir, quiet);
  assert.equal(p.readAlive(), null);
  p.writeAlive('run1', 1234);
  assert.deepEqual(p.readAlive(), { run: 'run1', at: 1234 });
  fs.writeFileSync(path.join(dir, 'alive.json'), '{bad');
  assert.equal(p.readAlive(), null);
});
