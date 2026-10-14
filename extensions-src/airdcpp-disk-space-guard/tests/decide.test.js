'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { decide, foldersToCheck, isPausable, restorePriority, GIB } = require('../src/decide');

const bundle = (id, target, { status = 'queued', downloaded = false, prio = 4, auto = false } = {}) => ({
  id, name: `B${id}`, target,
  status: { id: status, downloaded },
  priority: { id: prio, auto },
});

const run = (bundles, free, paused = {}) => decide({
  bundles,
  freeByFolder: new Map(Object.entries(free).map(([ t, gib ]) => [ t, gib < 0 ? -1 : gib * GIB ])),
  paused, minFreeGiB: 10, resumeMarginGiB: 2,
});

test('pauses only bundles on the low drive', () => {
  const r = run([ bundle(1, 'D:\\a\\'), bundle(2, 'E:\\b\\') ], { 'D:\\a\\': 5, 'E:\\b\\': 50 });
  assert.deepEqual(r.pause.map((p) => p.id), [ '1' ]);
  assert.deepEqual(r.pause[0].saved, { id: 4, auto: false, name: 'B1' });
  assert.deepEqual(r.resume, []);
});

test('never touches finished, errored, rechecking or user force-paused bundles', () => {
  const low = 'D:\\x\\';
  const bundles = [
    bundle(1, low, { status: 'completed', downloaded: true }),
    bundle(2, low, { status: 'download_error' }),
    bundle(3, low, { status: 'recheck' }),
    bundle(4, low, { prio: 0 }),
    bundle(5, low, { status: 'shared', downloaded: true }),
  ];
  assert.deepEqual(run(bundles, { [low]: 1 }).pause, []);
});

test('unknown free space (-1 or missing) never pauses or resumes', () => {
  const r = run([ bundle(1, 'Z:\\'), bundle(2, 'Y:\\') ], { 'Z:\\': -1 });
  assert.deepEqual(r.pause, []);
  const r2 = run([ bundle(1, 'Z:\\', { prio: 0 }) ], { 'Z:\\': -1 }, { 1: { id: 4, auto: false } });
  assert.deepEqual(r2.resume, []);
  assert.deepEqual(r2.forget, []);
});

test('hysteresis: resumes only above limit + margin', () => {
  const paused = { 1: { id: 5, auto: false, name: 'B1' } };
  const b = [ bundle(1, 'D:\\a\\', { prio: 0 }) ];
  assert.deepEqual(run(b, { 'D:\\a\\': 11 }, paused).resume, []);
  assert.deepEqual(run(b, { 'D:\\a\\': 12 }, paused).resume, [ { id: '1', name: 'B1', priority: 5 } ]);
});

test('a bundle the guard paused is not paused again, even while still low', () => {
  const r = run([ bundle(1, 'D:\\a\\', { prio: 0 }) ], { 'D:\\a\\': 1 }, { 1: { id: 4, auto: false } });
  assert.deepEqual(r.pause, []);
  assert.deepEqual(r.resume, []);
  assert.deepEqual(r.forget, []);
});

test('forgets bundles that are gone, finished or whose priority the user changed', () => {
  const paused = { 1: { id: 4 }, 2: { id: 4 }, 3: { id: 4 } };
  const r = run([
    bundle(2, 'D:\\a\\', { status: 'completed', downloaded: true, prio: 0 }),
    bundle(3, 'D:\\a\\', { prio: 6 }),
  ], { 'D:\\a\\': 50 }, paused);
  assert.deepEqual(r.forget.sort(), [ '1', '2', '3' ]);
  assert.deepEqual(r.resume, []);
});

test('auto priority is restored as auto', () => {
  assert.equal(restorePriority({ id: 3, auto: true }), -1);
  assert.equal(restorePriority({ id: null, auto: false }), -1);
  assert.equal(restorePriority({ id: 1, auto: false }), 1);
  const r = run([ bundle(1, 'D:\\a\\', { auto: true, prio: 3 }) ], { 'D:\\a\\': 1 });
  assert.deepEqual(r.pause[0].saved, { id: 3, auto: true, name: 'B1' });
});

test('a user-paused (non-force) bundle is paused and later restored to paused', () => {
  const r = run([ bundle(1, 'D:\\a\\', { prio: 1 }) ], { 'D:\\a\\': 1 });
  assert.equal(r.pause[0].saved.id, 1);
  assert.equal(restorePriority(r.pause[0].saved), 1);
});

test('foldersToCheck covers pausable and guard-paused bundles only', () => {
  const bundles = [
    bundle(1, 'D:\\a\\'),
    bundle(2, 'E:\\b\\', { status: 'completed', downloaded: true }),
    bundle(3, 'F:\\c\\', { prio: 0 }),
    bundle(4, 'G:\\d\\', { prio: 0 }),
    bundle(5, 'D:\\a\\'),
  ];
  assert.deepEqual(foldersToCheck(bundles, { 4: { id: 4 } }).sort(), [ 'D:\\a\\', 'G:\\d\\' ]);
  assert.equal(isPausable(null), false);
});

const runR = (bundles, free, paused = {}, released = {}) => decide({
  bundles,
  freeByFolder: new Map(Object.entries(free).map(([ t, gib ]) => [ t, gib < 0 ? -1 : gib * GIB ])),
  paused, released, minFreeGiB: 10, resumeMarginGiB: 2,
});

test('while the core owns a guard-paused bundle (recheck, download_error) nothing is resumed or forgotten', () => {
  for (const status of [ 'recheck', 'download_error', 'completion_validation_running' ]) {
    const r = runR([ bundle(1, 'D:\\a\\', { status, prio: 0 }) ], { 'D:\\a\\': 50 }, { 1: { id: 5, auto: false } });
    assert.deepEqual(r.resume, [], status);
    assert.deepEqual(r.forget, [], status);
  }
});

test('an explicit priority set by hand while low is a takeover: released, not paused again', () => {
  const paused = { 1: { id: 4, auto: false, name: 'B1' } };
  const r = runR([ bundle(1, 'D:\\a\\', { prio: 4 }) ], { 'D:\\a\\': 1 }, paused);
  assert.deepEqual(r.forget, [ '1' ]);
  assert.deepEqual(r.release, [ '1' ]);
  assert.deepEqual(r.pause, []);

  // Next round, still low: stays released
  const r2 = runR([ bundle(1, 'D:\\a\\', { prio: 4 }) ], { 'D:\\a\\': 1 }, {}, { 1: true });
  assert.deepEqual(r2.pause, []);
  assert.deepEqual(r2.unrelease, []);

  // Space came back: the release ends, a later shortage may pause it again
  const r3 = runR([ bundle(1, 'D:\\a\\', { prio: 4 }) ], { 'D:\\a\\': 12 }, {}, { 1: true });
  assert.deepEqual(r3.unrelease, [ '1' ]);

  // Gone: dropped
  assert.deepEqual(runR([], {}, {}, { 9: true }).unrelease, [ '9' ]);
});

test('the core resuming a guard-paused bundle to auto is not a takeover', () => {
  const paused = { 1: { id: 5, auto: false, name: 'B1' } };
  // Still low: paused again, keeping the original record (High, not auto)
  const low = runR([ bundle(1, 'D:\\a\\', { prio: 3, auto: true }) ], { 'D:\\a\\': 5 }, paused);
  assert.deepEqual(low.pause.map((p) => [ p.id, p.saved ]), [ [ '1', paused[1] ] ]);
  assert.deepEqual(low.forget, []);
  assert.deepEqual(low.release, []);
  // Room again: restored to the original priority
  const ok = runR([ bundle(1, 'D:\\a\\', { prio: 3, auto: true }) ], { 'D:\\a\\': 50 }, paused);
  assert.deepEqual(ok.resume, [ { id: '1', name: 'B1', priority: 5 } ]);
});

test('file bundles are checked once per folder', () => {
  const bundles = [ bundle(1, 'D:\\dl\\a.mkv'), bundle(2, 'D:\\dl\\b.mkv'), bundle(3, 'D:/dl2/c.iso'), bundle(4, 'E:\\x\\') ];
  assert.deepEqual(foldersToCheck(bundles, {}).sort(), [ 'D:/dl2/', 'D:\\dl\\', 'E:\\x\\' ]);
  const r = runR(bundles, { 'D:\\dl\\': 1, 'D:/dl2/': 50, 'E:\\x\\': 50 });
  assert.deepEqual(r.pause.map((p) => p.id), [ '1', '2' ]);
});

