'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseRelease, isSceneRelease, identityKey, searchPatternOf, releaseBaseKey, resolutionFromSize, normalizeTitle } = require('../src/release');

const pick = (name, keys) => {
  const p = parseRelease(name);
  return Object.fromEntries(keys.map((k) => [ k, p[k] ]));
};

const ALL = [ 'title', 'year', 'season', 'episodes', 'kind', 'resolution', 'source', 'codec', 'group' ];

const CASES = [
  [ 'Some.Movie.2019.1080p.BluRay.x264-GRP', { title: 'Some Movie', year: 2019, season: null, episodes: [], kind: 'movie', resolution: 1080, source: 'bluray', codec: 'h264', group: 'GRP' } ],
  [ 'The.Show.S01E02.720p.HDTV.x264-KILLERS', { title: 'The Show', year: null, season: 1, episodes: [ 2 ], kind: 'episode', resolution: 720, source: 'hdtv', codec: 'h264', group: 'KILLERS' } ],
  [ 'The_Show_S03E10_1080p_WEB-DL_DD5.1_H.264-NTb', { title: 'The Show', year: null, season: 3, episodes: [ 10 ], kind: 'episode', resolution: 1080, source: 'web-dl', codec: 'h264', group: 'NTb' } ],
  [ 'The.Show.S01E01E02.1080p.WEB.h264-GRP', { title: 'The Show', year: null, season: 1, episodes: [ 1, 2 ], kind: 'episode', resolution: 1080, source: 'web-dl', codec: 'h264', group: 'GRP' } ],
  [ 'The.Show.S01E01-E03.720p.WEBRip.x264-GRP', { title: 'The Show', year: null, season: 1, episodes: [ 1, 2, 3 ], kind: 'episode', resolution: 720, source: 'webrip', codec: 'h264', group: 'GRP' } ],
  [ 'The.Show.S02.1080p.BluRay.x265-GRP', { title: 'The Show', year: null, season: 2, episodes: [], kind: 'season', resolution: 1080, source: 'bluray', codec: 'hevc', group: 'GRP' } ],
  [ 'Some.Movie.2019.2160p.UHD.BluRay.x265.HDR.DV-GRP', { title: 'Some Movie', year: 2019, season: null, episodes: [], kind: 'movie', resolution: 2160, source: 'bluray', codec: 'hevc', group: 'GRP' } ],
  [ 'Some.Movie.2019.UHD.BluRay.HEVC-GRP', { title: 'Some Movie', year: 2019, season: null, episodes: [], kind: 'movie', resolution: 2160, source: 'bluray', codec: 'hevc', group: 'GRP' } ],
  [ '2001.A.Space.Odyssey.1968.1080p.BluRay.x264-GRP', { title: '2001 A Space Odyssey', year: 1968, season: null, episodes: [], kind: 'movie', resolution: 1080, source: 'bluray', codec: 'h264', group: 'GRP' } ],
  [ '1917.2019.720p.BluRay.x264-GRP', { title: '1917', year: 2019, season: null, episodes: [], kind: 'movie', resolution: 720, source: 'bluray', codec: 'h264', group: 'GRP' } ],
  [ 'Doctor.Who.2005.S01E01.720p.BluRay.x264-GRP', { title: 'Doctor Who', year: 2005, season: 1, episodes: [ 1 ], kind: 'episode', resolution: 720, source: 'bluray', codec: 'h264', group: 'GRP' } ],
  [ 'The.Show.S01E02.HDTV.XviD-LOL', { title: 'The Show', year: null, season: 1, episodes: [ 2 ], kind: 'episode', resolution: 480, source: 'hdtv', codec: 'xvid', group: 'LOL' } ],
  [ 'The.Show.1x05.720p.HDTV.x264-GRP', { title: 'The Show', year: null, season: 1, episodes: [ 5 ], kind: 'episode', resolution: 720, source: 'hdtv', codec: 'h264', group: 'GRP' } ],
  [ 'Some Movie 2019 1080p WEB-DL H 264-GRP', { title: 'Some Movie', year: 2019, season: null, episodes: [], kind: 'movie', resolution: 1080, source: 'web-dl', codec: 'h264', group: 'GRP' } ],
  [ 'Some.Movie.2019.1080p.WEB-DL-GRP', { title: 'Some Movie', year: 2019, season: null, episodes: [], kind: 'movie', resolution: 1080, source: 'web-dl', codec: null, group: 'GRP' } ],
  [ 'Some.Movie.2019.Blu-Ray.1080p.AVC.REMUX-GRP', { title: 'Some Movie', year: 2019, season: null, episodes: [], kind: 'movie', resolution: 1080, source: 'bluray', codec: 'h264', group: 'GRP' } ],
  [ 'Some.Movie.2019.1080p.BluRay.x264-GRP.mkv', { title: 'Some Movie', year: 2019, season: null, episodes: [], kind: 'movie', resolution: 1080, source: 'bluray', codec: 'h264', group: 'GRP' } ],
  [ 'Some.Movie.2019.4K.WEB.H265-GRP', { title: 'Some Movie', year: 2019, season: null, episodes: [], kind: 'movie', resolution: 2160, source: 'web-dl', codec: 'hevc', group: 'GRP' } ],
  [ 'The.Limited.Series.S01E01.1080p.WEB.h264-GRP', { title: 'The Limited Series', year: null, season: 1, episodes: [ 1 ], kind: 'episode', resolution: 1080, source: 'web-dl', codec: 'h264', group: 'GRP' } ],
  [ 'Some.Movie.2019.LIMITED.1080p.BluRay.x264-GRP', { title: 'Some Movie', year: 2019, season: null, episodes: [], kind: 'movie', resolution: 1080, source: 'bluray', codec: 'h264', group: 'GRP' } ],
  [ 'Some.Movie.2019.EXTENDED.REMASTERED.720p.BluRay.x264-GRP', { title: 'Some Movie', year: 2019, kind: 'movie', resolution: 720, group: 'GRP' } ],
  [ 'Ghost-Show.S01E01.720p.HDTV.x264-GRP', { title: 'Ghost-Show', season: 1, episodes: [ 1 ], kind: 'episode', group: 'GRP' } ],
];

for (const [ name, want ] of CASES) {
  test(`parses ${name}`, () => {
    assert.deepEqual(pick(name, Object.keys(want).filter((k) => ALL.includes(k))), want);
  });
}

test('PROPER, REPACK, REAL.PROPER and REPACK2 raise the proper level; iNTERNAL is a flag', () => {
  assert.equal(parseRelease('The.Show.S01E02.720p.HDTV.x264-GRP').properLevel, 0);
  const proper = parseRelease('The.Show.S01E02.PROPER.720p.HDTV.x264-GRP');
  assert.equal(proper.proper, true);
  assert.equal(proper.properLevel, 1);
  assert.equal(proper.title, 'The Show');
  assert.equal(parseRelease('The.Show.S01E02.REPACK.720p.HDTV.x264-GRP').properLevel, 1);
  assert.equal(parseRelease('The.Show.S01E02.REAL.PROPER.720p.HDTV.x264-GRP').properLevel, 2);
  assert.equal(parseRelease('The.Show.S01E02.REPACK2.720p.HDTV.x264-GRP').properLevel, 2);
  const movie = parseRelease('Some.Movie.2019.PROPER.1080p.BluRay.x264-GRP');
  assert.deepEqual([ movie.title, movie.year, movie.properLevel ], [ 'Some Movie', 2019, 1 ]);
  const internal = parseRelease('Some.Movie.2019.iNTERNAL.1080p.BluRay.x264-GRP');
  assert.equal(internal.internal, true);
  assert.equal(internal.title, 'Some Movie');
  assert.equal(internal.properLevel, 0);
});

test('HDR and Dolby Vision', () => {
  assert.equal(parseRelease('Some.Movie.2019.2160p.WEB-DL.DDP5.1.DV.HDR.H.265-GRP').hdr, 'dv');
  assert.equal(parseRelease('Some.Movie.2019.2160p.WEB-DL.HDR10+.HEVC-GRP').hdr, 'hdr10+');
  assert.equal(parseRelease('Some.Movie.2019.2160p.BluRay.HDR.x265-GRP').hdr, 'hdr');
  assert.equal(parseRelease('Some.Movie.2019.1080p.BluRay.x264-GRP').hdr, null);
});

test('not releases: personal folders and plain names', () => {
  assert.equal(parseRelease(''), null);
  assert.equal(parseRelease(null), null);
  assert.equal(parseRelease('Holiday photos').kind, null);
  assert.equal(isSceneRelease(parseRelease('Holiday photos')), false);
  // A year and a resolution but no group: a personal folder, not a release
  assert.equal(isSceneRelease(parseRelease('Holiday 2019 1080p')), false);
  assert.equal(isSceneRelease(parseRelease('Some.Movie.2019.1080p.BluRay.x264-GRP')), true);
  // A group but no quality tag
  assert.equal(isSceneRelease(parseRelease('Some.Movie.2019-GRP')), false);
});

test('identity keys match across separators and case, and differ by year and episode', () => {
  const a = identityKey(parseRelease('The.Show.S01E02.720p.HDTV.x264-GRP'));
  assert.equal(a, identityKey(parseRelease('the_show_s01e02_1080p_web-dl-OTHER')));
  assert.notEqual(a, identityKey(parseRelease('The.Show.S01E03.1080p.WEB.h264-GRP')));
  assert.notEqual(a, identityKey(parseRelease('The.Show.S01E02E03.1080p.WEB.h264-GRP')));
  assert.notEqual(a, identityKey(parseRelease('The.Show.US.S01E02.1080p.WEB.h264-GRP')));
  const m = identityKey(parseRelease('Some.Movie.2019.720p.BluRay.x264-GRP'));
  assert.equal(m, 'movie:some movie (2019)');
  assert.notEqual(m, identityKey(parseRelease('Some.Movie.2020.1080p.BluRay.x264-GRP')));
  assert.notEqual(m, identityKey(parseRelease('Some.Movie.Returns.2019.1080p.BluRay.x264-GRP')));
  assert.equal(identityKey(parseRelease('Holiday photos')), null);
});

test('search patterns', () => {
  assert.equal(searchPatternOf(parseRelease('Some.Movie.2019.720p.BluRay.x264-GRP')), 'some movie 2019');
  assert.equal(searchPatternOf(parseRelease('The.Show.S01E02.720p.HDTV.x264-GRP')), 'the show S01E02');
  assert.equal(searchPatternOf(parseRelease('The.Show.S02.720p.HDTV.x264-GRP')), 'the show S02');
});

test('the release base ignores PROPER/REPACK only', () => {
  const base = releaseBaseKey(parseRelease('The.Show.S01E02.720p.HDTV.x264-GRP'));
  assert.equal(base, releaseBaseKey(parseRelease('The.Show.S01E02.REPACK.720p.HDTV.x264-GRP')));
  assert.notEqual(base, releaseBaseKey(parseRelease('The.Show.S01E02.REPACK.720p.HDTV.x264-OTHER')));
  assert.notEqual(base, releaseBaseKey(parseRelease('The.Show.S01E02.REPACK.1080p.HDTV.x264-GRP')));
});

test('resolution from the picture size', () => {
  assert.equal(resolutionFromSize(1920, 800), 1080);
  assert.equal(resolutionFromSize(3840, 1600), 2160);
  assert.equal(resolutionFromSize(1280, 536), 720);
  assert.equal(resolutionFromSize(720, 576), 480);
  assert.equal(resolutionFromSize(0, 0), null);
  assert.equal(resolutionFromSize(undefined, 1080), 1080);
});

test('title normalization', () => {
  assert.equal(normalizeTitle("Marvel's Agents.of.S.H.I.E.L.D"), 'marvels agents of s h i e l d');
  assert.equal(normalizeTitle('Law & Order'), 'law and order');
});
