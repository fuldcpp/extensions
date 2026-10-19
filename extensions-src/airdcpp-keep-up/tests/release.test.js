'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const r = require('../src/release');

const show = r.showIdentity([ 'The Show' ], 2019);
const result = (name, extra = {}) => ({ id: name, name, size: 2e9, type: { id: 'directory' }, dupe: null, users: { count: 1 }, slots: { free: 1 }, ...extra });

test('parses scene episode names, packs, double episodes, files, years and groups', () => {
  const p = r.parseRelease('Doctor.Who.2005.S13E01.720p.HDTV.x264-ORGANiC');
  assert.equal(p.title, 'Doctor Who');
  assert.equal(p.year, 2005);
  assert.deepEqual([ p.season, p.episode, p.group, p.resolution ], [ 13, 1, 'ORGANiC', '720p' ]);
  assert.equal(r.parseRelease('The.Show.S01.1080p.WEB-GRP').seasonPack, true);
  assert.equal(r.parseRelease('The.Show.S01E02E03.1080p-GRP').multiEpisode, true);
  assert.equal(r.parseRelease('The.Show.S01E02-03.1080p-GRP').multiEpisode, true);
  assert.equal(r.parseRelease('The.Show.S01E02-720p').multiEpisode, false);
  assert.equal(r.parseRelease('The Show - S01E02 - Title.mkv').extension, 'mkv');
  assert.equal(r.parseRelease('Some.Movie.2019.1080p.BluRay-GRP'), null);
});

test('show match: normalised title equality, year aware, never a longer or shorter title', () => {
  const ok = (name) => r.matchesShow(r.parseRelease(name), show);
  assert.equal(ok('The.Show.S01E02.1080p-GRP'), true);
  assert.equal(ok('the show S01E02 1080p-GRP'), true);
  assert.equal(ok('The.Show.2019.S01E02.1080p-GRP'), true);
  assert.equal(ok('The.Show.2008.S01E02.1080p-GRP'), false, 'another show of the same name');
  assert.equal(ok('The.Show.Aftershow.S01E02.1080p-GRP'), false);
  assert.equal(ok('Show.S01E02.1080p-GRP'), false);
  assert.equal(r.matchesShow(r.parseRelease('Greys.Anatomy.S21E03.1080p-GRP'), r.showIdentity([ "Grey's Anatomy" ], 2005)), true);
  assert.equal(r.matchesShow(r.parseRelease('1923.S02E03.1080p.WEB-NTb'), r.showIdentity([ '1923' ], 2022)), true);
  assert.equal(r.matchesShow(r.parseRelease('The.Office.US.S01E01-GRP'), r.showIdentity([ 'The Office (US)' ], 2005)), true);
});

test('episode match is exact: no other episode, no pack, no double episode', () => {
  const m = (name) => r.matchesEpisode(r.parseRelease(name), show, 1, 2);
  assert.equal(m('The.Show.S01E02.1080p-GRP'), true);
  assert.equal(m('The.Show.S01E12.1080p-GRP'), false);
  assert.equal(m('The.Show.S11E02.1080p-GRP'), false);
  assert.equal(m('The.Show.S01.1080p-GRP'), false);
  assert.equal(m('The.Show.S01E01E02.1080p-GRP'), false);
});

test('ranking never falls back to a non-matching result, and honours groups, quality, dupes and size', () => {
  const results = [
    result('Another.Show.S01E02.1080p-AAA', { users: { count: 50 } }),
    result('The.Show.S01E02.720p-BBB', { users: { count: 40 } }),
    result('The.Show.S01E02.1080p-CCC', { users: { count: 3 } }),
    result('The.Show.S01E02.1080p-PREF', { users: { count: 1 } }),
    result('The.Show.S01E02.1080p-BAD', { users: { count: 30 } }),
    result('The.Show.S01E02.1080p-DUP', { users: { count: 30 }, dupe: { id: 'share_full' } }),
    result('The.Show.S01E02.1080p-BIG', { users: { count: 30 }, size: 50e9 }),
    result('The.Show.S01E02.1080p-TXT.nfo', { type: { id: 'file' } }),
  ];
  const prefs = { quality: '1080p', qualityRequired: true, preferredGroups: [ 'pref' ], blockedGroups: [ 'BAD' ], maxSizeBytes: 10e9 };
  const ranked = r.rankResults(results, show, 1, 2, prefs);
  assert.deepEqual(ranked.map((x) => x.result.name), [ 'The.Show.S01E02.1080p-PREF', 'The.Show.S01E02.1080p-CCC' ]);
  assert.deepEqual(r.rankResults([ results[0] ], show, 1, 2, prefs), []);
  // Quality preferred, not required: 1080p first, the 720p still acceptable
  const loose = r.rankResults(results, show, 1, 2, { ...prefs, qualityRequired: false, preferredGroups: [] });
  assert.deepEqual(loose.map((x) => x.result.name), [ 'The.Show.S01E02.1080p-CCC', 'The.Show.S01E02.1080p-PREF', 'The.Show.S01E02.720p-BBB' ]);
});

test('a video file result is accepted, unsafe names never', () => {
  const ranked = r.rankResults([ result('The.Show.S01E02.1080p-GRP.mkv', { type: { id: 'file' } }), result('..', {}), result('a/The.Show.S01E02.1080p-GRP') ], show, 1, 2, {});
  assert.deepEqual(ranked.map((x) => x.result.name), [ 'The.Show.S01E02.1080p-GRP.mkv' ]);
});

test('the release folder ranks before its loose video file, whichever more users have', () => {
  const loose = result('The.Show.S01E02.1080p.WEB-DL.x264-GRP.mkv', { type: { id: 'file' }, users: { count: 6 } });
  const folder = result('The.Show.S01E02.1080p.WEB-DL.x264-GRP', { users: { count: 2 } });
  for (const order of [ [ loose, folder ], [ folder, loose ] ]) {
    assert.equal(r.rankResults(order, show, 1, 2, {})[0].result, folder);
  }
  // A preferred group still comes first
  const liked = result('The.Show.S01E02.1080p-LIKED.mkv', { type: { id: 'file' } });
  assert.equal(r.rankResults([ folder, liked ], show, 1, 2, { preferredGroups: [ 'liked' ] })[0].result, liked);
});

test('a queued bundle covers its episode, a pack of its season or a double episode holding it', () => {
  assert.equal(r.bundleCovers('The.Show.S01E02.720p-X', show, 1, 2), true);
  assert.equal(r.bundleCovers('The.Show.S01.1080p-X', show, 1, 5), true);
  assert.equal(r.bundleCovers('The.Show.S01E04E05.1080p-X', show, 1, 5), true);
  assert.equal(r.bundleCovers('The.Show.S02.1080p-X', show, 1, 5), false);
  assert.equal(r.bundleCovers('Other.Show.S01E02-X', show, 1, 2), false);
});

test('search pattern is the dotted name and SxxEyy, plus the quality word when required', () => {
  assert.equal(r.searchPattern("Grey's Anatomy (2005)", 21, 3, ''), 'greys.anatomy.S21E03');
  assert.equal(r.searchPattern('The Show', 1, 2, '1080p'), 'the.show.S01E02 1080p');
});

test('a sample file of the release is never taken as the episode', () => {
  const sample = result('the.show.s01e04.1080p.web.h264-grp-sample.mkv', { type: { id: 'file' }, size: 5e7, users: { count: 6 } });
  const sample2 = result('The.Show.S01E04.1080p.WEB.H264-GRP.sample.mkv', { type: { id: 'file' }, size: 5e7, users: { count: 6 } });
  const real = result('The.Show.S01E04.1080p.WEB.H264-GRP', { users: { count: 5 } });
  const ranked = r.rankResults([ sample, sample2, real ], show, 1, 4, { quality: '1080p', qualityRequired: true });
  assert.deepEqual(ranked.map((a) => a.result.name), [ 'The.Show.S01E04.1080p.WEB.H264-GRP' ]);
  // A show whose title has the word in it is still matched
  const sampleShow = r.showIdentity([ 'Sample Show' ], null);
  assert.equal(r.rankResults([ result('Sample.Show.S01E04.1080p-GRP') ], sampleShow, 1, 4, {}).length, 1);
});

test('a year in the release name must be one of the show\'s years', () => {
  const ok = (names, years, name) => r.matchesShow(r.parseRelease(name), r.showIdentity(names, ...years));
  // The year written in the library name counts as the show's year
  assert.equal(ok([ 'Doctor Who (1963)' ], [], 'Doctor.Who.2005.S01E01.720p-GRP'), false, 'not the 1963 show');
  assert.equal(ok([ 'Doctor Who (1963)' ], [], 'Doctor.Who.1963.S01E01.720p-GRP'), true);
  // No year known at all: a release with a year is another show of the same name
  assert.equal(ok([ 'Show Name' ], [], 'Show.Name.2024.S01E01.720p-GRP'), false);
  assert.equal(ok([ 'Show Name' ], [], 'Show.Name.S01E01.720p-GRP'), true);
  // The library's and TMDB's years both count
  assert.equal(ok([ 'Show Name' ], [ 2010, 2011 ], 'Show.Name.2011.S01E01.720p-GRP'), true);
  assert.equal(ok([ 'Show Name' ], [ 2010, 2011 ], 'Show.Name.2024.S01E01.720p-GRP'), false);
  assert.equal(ok([ '1923' ], [ 2022 ], '1923.S02E03.1080p.WEB-NTb'), true);
});

test('a show with a country tag in a name is never matched by the bare title', () => {
  const ok = (names, name) => r.matchesShow(r.parseRelease(name), r.showIdentity(names, 2005));
  // TMDB calls "The Office (US)" plain "The Office"; the bare title is the UK show's
  assert.equal(ok([ 'The Office (US)', 'The Office' ], 'The.Office.S02E05.720p-GRP'), false);
  assert.equal(ok([ 'The Office (US)', 'The Office' ], 'The.Office.US.S02E05.720p-GRP'), true);
  assert.equal(ok([ 'The Office (US)', 'The Office' ], 'The.Office.UK.S02E05.720p-GRP'), false);
  assert.equal(ok([ 'The Office' ], 'The.Office.S02E05.720p-GRP'), true);
});

test('a language, dub, hardsub or extras release is never the episode, unless its language tag is accepted', () => {
  const pick = (name, prefs = {}) => r.rankResults([ result(name) ], show, 1, 2, prefs).length === 1;
  for (const name of [ 'The.Show.S01E02.FRENCH.1080p.WEB-GRP', 'The.Show.S01E02.GERMAN.DL.1080p.WEB-GRP', 'The.Show.S01E02.NORDiC.1080p.WEB-GRP',
    'The.Show.S01E02.SWESUB.1080p.WEB-GRP', 'The.Show.S01E02.DUBBED.1080p.WEB-GRP', 'The.Show.S01E02.MULTi.1080p.WEB-GRP',
    'The.Show.S01E02.HC.1080p.WEB-GRP', 'The.Show.S01E02.EXTRAS.1080p.WEB-GRP', 'The.Show.S01E02.Bonus.1080p.WEB-GRP',
    'The.Show.S01E02.SUBPACK.1080p.WEB-GRP', 'The.Show.S01E02.Trailer.1080p.WEB-GRP' ]) {
    assert.equal(pick(name), false, name);
  }

  // Ordinary quality words are not language tags (WEB-DL's "DL", DTS, DDP5.1, H.264)
  assert.equal(pick('The.Show.S01E02.1080p.WEB-DL.DDP5.1.H.264-GRP'), true);
  assert.equal(pick('The.Show.S01E02.1080p.BluRay.DTS.x264-GRP'), true);
  // Listed by the user: taken; content tags never
  assert.equal(pick('The.Show.S01E02.MULTi.1080p.WEB-GRP', { acceptedTags: [ 'MULTi' ] }), true);
  assert.equal(pick('The.Show.S01E02.GERMAN.DL.1080p.WEB-GRP', { acceptedTags: [ 'german', 'dl' ] }), true);
  assert.equal(pick('The.Show.S01E02.SUBPACK.1080p.WEB-GRP', { acceptedTags: [ 'subpack' ] }), false);
});
