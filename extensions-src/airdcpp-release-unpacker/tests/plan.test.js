'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { planSet, safeRelativePath, isPlayableAsStored, hasRoom, formatBytes, GIB } = require('../src/plan');

const opts = { unpackStored: false, mediaOnly: true, nested: true };
const e = (name, size, extra = {}) => ({ name, size, crc: 1, stored: false, encrypted: false, directory: false, ...extra });

test('entry names are confined to the output folder', () => {
  assert.equal(safeRelativePath('movie.mkv'), 'movie.mkv');
  assert.equal(safeRelativePath('Subs/eng.srt'), path.join('Subs', 'eng.srt'));
  assert.equal(safeRelativePath('Subs\\eng.srt'), path.join('Subs', 'eng.srt'));
  assert.equal(safeRelativePath('../../Windows/evil.dll'), path.join('Windows', 'evil.dll'));
  assert.equal(safeRelativePath('C:\\Windows\\evil.dll'), path.join('Windows', 'evil.dll'));
  assert.equal(safeRelativePath('/etc/passwd'), path.join('etc', 'passwd'));
  assert.equal(safeRelativePath('..'), null);
  assert.equal(safeRelativePath(''), null);
  // Names Windows cannot create, or would silently change
  assert.equal(safeRelativePath('con.txt'), null);
  assert.equal(safeRelativePath('a:b.mkv'), null);
  assert.equal(safeRelativePath('trailing.'), null);
  assert.equal(safeRelativePath('what?.mkv'), null);
});

test('playable as stored = the largest video entry of a RAR set is stored (what the media server picks)', () => {
  assert.equal(isPlayableAsStored('rar', [ e('m.mkv', 100, { stored: true }), e('m.nfo', 1) ]), true);
  assert.equal(isPlayableAsStored('rar', [ e('m.mkv', 100) ]), false);
  // A stored sample beside a compressed film: the film is not playable
  assert.equal(isPlayableAsStored('rar', [ e('m.mkv', 100), e('sample.mkv', 5, { stored: true }) ]), false);
  assert.equal(isPlayableAsStored('rar', [ e('m.nfo', 1, { stored: true }) ]), false);
  // The media server reads no zip or 7z, stored or not
  assert.equal(isPlayableAsStored('zip', [ e('m.mkv', 100, { stored: true }) ]), false);
});

test('plan: encrypted, empty, unsafe, no media, stored, ok', () => {
  assert.deepEqual(planSet('rar', { encrypted: true, entries: [] }, opts).reason, 'it is password protected');
  assert.equal(planSet('rar', { entries: [ e('m.mkv', 1, { encrypted: true }) ] }, opts).quiet, false);
  assert.equal(planSet('rar', { entries: [ e('d', 0, { directory: true }) ] }, opts).quiet, true);
  assert.match(planSet('rar', { entries: [ e('con.mkv', 1) ] }, opts).reason, /cannot be created safely/);
  assert.match(planSet('rar', { entries: [ e('setup.exe', 1) ] }, opts).reason, /no video/);
  assert.equal(planSet('rar', { entries: [ e('setup.exe', 1) ] }, { ...opts, mediaOnly: false }).action, 'unpack');
  const stored = { entries: [ e('m.mkv', 10, { stored: true }) ] };
  assert.equal(planSet('rar', stored, opts).action, 'skip');
  assert.equal(planSet('rar', stored, opts).quiet, true);
  assert.equal(planSet('rar', stored, { ...opts, unpackStored: true }).action, 'unpack');
  const ok = planSet('rar', { entries: [ e('m.mkv', 10), e('m.nfo', 2), e('Subs', 0, { directory: true }) ] }, opts);
  assert.equal(ok.action, 'unpack');
  assert.equal(ok.bytes, 12);
  assert.deepEqual(ok.files.map((f) => f.name), [ 'm.mkv', 'm.nfo' ]);
});

test('plan: a zip holding only RAR volumes passes the media check when nested archives are on', () => {
  const zip = { entries: [ e('inner.r00', 10), e('file_id.diz', 1) ] };
  assert.equal(planSet('zip', zip, opts).action, 'unpack');
  assert.equal(planSet('zip', zip, { ...opts, nested: false }).action, 'skip');
});

test('room: needed plus margin must fit; an unknown free space never fits', () => {
  assert.equal(hasRoom(10 * GIB, 7 * GIB, 2), true);
  assert.equal(hasRoom(10 * GIB, 9 * GIB, 2), false);
  assert.equal(hasRoom(-1, 1, 0), false);
  assert.equal(hasRoom(undefined, 1, 0), false);
  assert.equal(formatBytes(1.5 * GIB), '1.5 GiB');
  assert.equal(formatBytes(512), '512 B');
});

test('CRC-32: the table version (old Nodes) matches the standard check value, also in pieces', () => {
  const { crc32, crc32Js } = require('../src/crc32');
  const data = Buffer.from('123456789');
  assert.equal(crc32Js(data), 0xCBF43926);
  assert.equal(crc32(data), 0xCBF43926);
  assert.equal(crc32Js(data.subarray(4), crc32Js(data.subarray(0, 4))), 0xCBF43926);
});
