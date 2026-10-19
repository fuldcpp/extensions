'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectSets, parseSfv, missingFromSfv, parsePatterns, isExcluded } = require('../src/sets');

const byBase = (sets) => Object.fromEntries(sets.map((s) => [ `${s.kind}:${s.base}`, s ]));

test('old-style RAR volumes: .rar first, then r00.., s00..; gaps are missing', () => {
  const names = [ 'rel.r01', 'rel.rar', 'rel.r00', 'rel.s00', 'rel.nfo', 'rel.sfv' ];
  for (let i = 2; i < 100; i++) names.push(`rel.r${String(i).padStart(2, '0')}`);
  const [ set ] = detectSets(names);
  assert.equal(set.kind, 'rar');
  assert.equal(set.first, 'rel.rar');
  assert.equal(set.volumes[0], 'rel.rar');
  assert.equal(set.volumes[1], 'rel.r00');
  assert.equal(set.volumes[set.volumes.length - 1], 'rel.s00');
  assert.deepEqual(set.missing, []);

  const gap = detectSets([ 'a.rar', 'a.r00', 'a.r02' ])[0];
  assert.deepEqual(gap.missing, [ 'a.r01' ]);
});

test('old-style volumes without the .rar: the first volume is missing', () => {
  const [ set ] = detectSets([ 'a.r00', 'a.r01' ]);
  assert.equal(set.first, null);
  assert.deepEqual(set.missing, [ 'a.rar' ]);
});

test('new-style .partN.rar, any digit width; part1 is first; gaps reported with the same width', () => {
  const [ set ] = detectSets([ 'x.part03.rar', 'x.part01.rar', 'x.part04.rar' ]);
  assert.equal(set.first, 'x.part01.rar');
  assert.deepEqual(set.volumes, [ 'x.part01.rar', 'x.part03.rar', 'x.part04.rar' ]);
  assert.deepEqual(set.missing, [ 'x.part02.rar' ]);
  const noFirst = detectSets([ 'y.part2.rar' ])[0];
  assert.equal(noFirst.first, null);
  assert.deepEqual(noFirst.missing, [ 'y.part1.rar' ]);
});

test('a stray name.rar next to a .partN set is not taken as one of its volumes', () => {
  const sets = byBase(detectSets([ 'm.part1.rar', 'm.part2.rar', 'm.rar' ]));
  assert.deepEqual(sets['rar:m'].volumes, [ 'm.part1.rar', 'm.part2.rar' ]);
});

test('two sets in one folder (film and subs) stay separate; upper-case extensions work', () => {
  const sets = byBase(detectSets([ 'Film.RAR', 'Film.R00', 'film.subs.rar' ]));
  assert.deepEqual(sets['rar:Film'].volumes, [ 'Film.RAR', 'Film.R00' ]);
  assert.deepEqual(sets['rar:film.subs'].volumes, [ 'film.subs.rar' ]);
  assert.deepEqual(detectSets([ 'Film.RAR', 'Film.R00', 'Film.R02' ])[0].missing, [ 'Film.R01' ]);
});

test('zip, split zip, 7z and split 7z', () => {
  const sets = byBase(detectSets([ 'a.zip', 'b.z01', 'b.z02', 'b.zip', 'c.7z', 'd.7z.001', 'd.7z.003', 'e.z01' ]));
  assert.equal(sets['zip:a'].first, 'a.zip');
  assert.deepEqual(sets['zip:b'].volumes, [ 'b.z01', 'b.z02', 'b.zip' ]);
  assert.equal(sets['zip:b'].first, 'b.zip');
  assert.equal(sets['7z:c'].first, 'c.7z');
  assert.equal(sets['7z:d'].first, 'd.7z.001');
  assert.deepEqual(sets['7z:d'].missing, [ 'd.7z.002' ]);
  assert.deepEqual(sets['zip:e'].missing, [ 'e.zip' ]);
});

test('files that are no archives make no sets', () => {
  assert.deepEqual(detectSets([ 'movie.mkv', 'movie.nfo', 'rel.sfv', 'rar.txt', 'archive.rarx' ]), []);
});

test('SFV: names listed; comments and junk ignored; volumes listed but absent are missing', () => {
  const names = parseSfv('; comment\r\nrel.rar 8FB25E93\r\nrel.r00 185DCB77\r\nrel.r01 B2F97389\r\n\r\nbroken line\n');
  assert.deepEqual(names, [ 'rel.rar', 'rel.r00', 'rel.r01' ]);
  const [ set ] = detectSets([ 'rel.rar', 'rel.r00' ]);
  assert.deepEqual(set.missing, []); // the names alone show no gap...
  assert.deepEqual(missingFromSfv(set, names, [ 'rel.rar', 'rel.r00' ]), [ 'rel.r01' ]); // ...the SFV does
  // Other sets' names in the SFV do not count against this one
  assert.deepEqual(missingFromSfv(set, [ ...names, 'other.rar 00000000' ], [ 'rel.rar', 'rel.r00', 'rel.r01' ]), []);
});

test('exclude patterns match the folder name or its full path, case-insensitively', () => {
  const patterns = parsePatterns('*.XXX.*\n*\\Games\\*;  \n');
  assert.deepEqual(patterns, [ '*.XXX.*', '*\\Games\\*' ]);
  assert.equal(isExcluded('D:\\dl\\Some.xxx.Release-GRP', patterns), true);
  assert.equal(isExcluded('D:\\Games\\Some.Game-GRP\\', patterns), true);
  assert.equal(isExcluded('D:\\dl\\Some.Movie.2019-GRP', patterns), false);
  assert.equal(isExcluded('D:\\dl\\x', []), false);
  // Regex characters in a pattern are literal
  assert.equal(isExcluded('D:\\dl\\a+b', [ 'a+b' ]), true);
  assert.equal(isExcluded('D:\\dl\\aab', [ 'a+b' ]), false);
});
