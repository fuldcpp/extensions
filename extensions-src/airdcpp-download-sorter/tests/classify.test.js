'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { categoryOf, showNameOf, seasonOf, destinationOf, parseCustomRules, safeFolder, isInside } = require('../src/classify');

test('categories of typical release names', () => {
  const cases = {
    'The.Show.S01E02.1080p.WEB.h264-GRP': 'tv',
    'The.Show.S03.1080p.BluRay.x264-GRP': 'tv',
    'Show.Name.S02E10E11.720p.HDTV.x264-GRP': 'tv',
    'Show_Name.1x05.HDTV.XviD-GRP': 'tv',
    'Some.Movie.2019.1080p.BluRay.x264-GRP': 'movies',
    'Some.Movie.2160p.2021.UHD.BluRay.REMUX.HEVC-GRP': 'movies',
    'Artist-Album-WEB-2023-GRP': 'music',
    'Artist-Album-(CAT123)-CD-FLAC-2001-GRP': 'music',
    'Artist_-_Album-2018-GRP': 'music',
    'Random.Software.v1.2-GRP': null,
    'family photos': null,
    'Some.Doc.2019.PDF-GRP': null,
  };
  for (const [ name, want ] of Object.entries(cases)) {
    assert.equal(categoryOf(name), want, name);
  }
});

test('false positives the review found are gone', () => {
  const cases = {
    'Movie.Name.2020.1080p.WEBRip.x264.AAC-GRP': 'movies',
    'Anime.Movie.2021.1080p.BluRay.x265.Opus-GRP': 'movies',
    'Movie.2019.1080p.BluRay.FLAC.x264-GRP': 'movies',
    'MP3.Converter.Pro.v2.1-GRP': 'music', // an audio format word with no video tag still reads as music
    'Icons.Pack.32x32-GRP': null,
    'Samsung.Galaxy.S10.Firmware-GRP': null,
    'Adobe.Dreamweaver.2020.Web.Tools-GRP': null,
    'Holiday-Photos-2019-June': null,
    'Show.2024.03.15.1080p.WEB.h264-GRP': 'tv',
    'Show.S01.1080p.BluRay.x264-GRP': 'tv',
  };
  for (const [ name, want ] of Object.entries(cases)) {
    assert.equal(categoryOf(name), want, name);
  }
});

test('the season comes from the TV marker, show names lose trailing separators', () => {
  assert.equal(seasonOf('Mr.S1ck.Show.S03E01.720p.HDTV-GRP'), 3);
  assert.equal(showNameOf('Show - S01E01 - Title 720p HDTV'), 'Show');
  assert.equal(seasonOf('Show.2024.03.15.1080p.WEB.h264-GRP'), null);
  assert.equal(showNameOf('Show.2024.03.15.1080p.WEB.h264-GRP'), 'Show');
});

test('reserved Windows names and relative folders', () => {
  assert.equal(safeFolder('Con'), 'Con_');
  assert.equal(safeFolder('nul.'), 'nul_');
  const { errors } = parseCustomRules('^a => TV\n^b => D:TV\n^c => D:\\TV\n^d => \\\\nas\\media');
  assert.equal(errors.length, 2);
});

test('a music-looking tail with a video tag is not music', () => {
  assert.equal(categoryOf('Concert.Live.2019.1080p.WEB-2019-GRP'), 'movies');
});

test('show name and season', () => {
  assert.equal(showNameOf('The.Show.S01E02.1080p.WEB.h264-GRP'), 'The Show');
  assert.equal(showNameOf('Show_Name.1x05.HDTV.XviD-GRP'), 'Show Name');
  assert.equal(seasonOf('The.Show.S01E02.1080p'), 1);
  assert.equal(seasonOf('The.Show.S12.1080p'), 12);
  assert.equal(seasonOf('Show_Name.1x05.HDTV'), 1);
  assert.equal(showNameOf('S01E01.Only.Marker'), null);
});

const settings = (overrides = {}) => ({
  tvDirectory: path.join('D:', 'TV'),
  moviesDirectory: path.join('D:', 'Movies'),
  musicDirectory: '',
  tvGroupByShow: true,
  customRules: [],
  ...overrides,
});

test('TV goes to show and season folders', () => {
  assert.deepEqual(destinationOf('The.Show.S01E02.1080p.WEB.h264-GRP', settings()),
    { category: 'tv', directory: path.join('D:', 'TV', 'The Show', 'Season 01') });
  assert.deepEqual(destinationOf('The.Show.S01E02.1080p.WEB.h264-GRP', settings({ tvGroupByShow: false })),
    { category: 'tv', directory: path.join('D:', 'TV') });
});

test('an empty category folder means: leave it', () => {
  assert.equal(destinationOf('Artist-Album-WEB-2023-GRP', settings()), null);
  assert.equal(destinationOf('Random.Software.v1.2-GRP', settings()), null);
});

test('own rules come first', () => {
  const { rules, errors } = parseCustomRules('# sport\n^Formula\\.1\\. => E:\\Sport\\F1\n\nbad line\n([ => X:\\broken\n');
  assert.equal(rules.length, 1);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /line 4/);
  assert.match(errors[1], /line 5: invalid pattern/);
  assert.deepEqual(destinationOf('Formula.1.2024.Round01.Race.1080p.WEB.h264-GRP', settings({ customRules: rules })),
    { category: 'custom', directory: 'E:\\Sport\\F1' });
});

test('folder names are made safe for Windows', () => {
  assert.equal(safeFolder('What: If? <Show>.'), 'What If Show');
  // A show name that is nothing but unsafe characters falls back to the TV root
  assert.deepEqual(destinationOf('???.S01E01.720p.HDTV-GRP', settings()).directory, path.join('D:', 'TV'));
});

test('isInside is case-insensitive and needs a real parent folder', () => {
  const base = path.resolve('Downloads');
  assert.equal(isInside(path.join(base, 'x', 'y') + path.sep, base), true);
  assert.equal(isInside(path.join(base.toUpperCase(), 'x'), base), true);
  assert.equal(isInside(base + '2' + path.sep + 'x', base), false);
  assert.equal(isInside(path.join(base, 'x'), ''), false);
});
