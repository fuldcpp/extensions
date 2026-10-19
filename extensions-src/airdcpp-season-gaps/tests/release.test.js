'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseRelease, matchesWanted, pickBest, buildQuery, titleKeys, hasToken } = require('../src/release');

const wanted = (title, season, episode) => ({ keys: titleKeys(title), season, episode });
const dir = (id, name, extra = {}) => ({ id, name, type: { id: 'directory' }, hits: 1, dupe: null, ...extra });
const file = (id, name, extra = {}) => ({ id, name, type: { id: 'file', str: 'mkv' }, hits: 1, dupe: null, ...extra });

test('parses scene names, double episodes and the group', () => {
  assert.deepEqual(parseRelease('Show.Name.S02E05.1080p.WEB.h264-GRP'), { show: 'Show Name', season: 2, episode: 5, episodeEnd: 5, group: 'GRP' });
  assert.deepEqual(parseRelease('Show Name - S01E01E02 - Pilot.mkv'), { show: 'Show Name', season: 1, episode: 1, episodeEnd: 2, group: '' });
  assert.equal(parseRelease('Show.Name.S01E03-E04.720p-X').episodeEnd, 4);
  assert.equal(parseRelease('Show.Name.S02.1080p.WEB-GRP'), null, 'a season pack is not an episode');
  assert.equal(parseRelease('Show.Name.S01E05E03.720p-X'), null, 'numbers running backwards are refused');
  assert.equal(parseRelease('Show.Name.2019.12.01.720p'), null);
});

test('the name check is exact about the show and the episode', () => {
  const w = wanted('The Expanse', 2, 5);
  assert.ok(matchesWanted('The.Expanse.S02E05.1080p.WEB-GRP', w));
  assert.equal(matchesWanted('The.Expanse.S02E06.1080p.WEB-GRP', w), null);
  assert.equal(matchesWanted('The.Expanse.S03E05.1080p.WEB-GRP', w), null);
  assert.equal(matchesWanted('The.Expanse.Aftershow.S02E05.1080p-GRP', w), null, 'a longer title is another show');
  assert.equal(matchesWanted('Expanse.S02E05.1080p-GRP', w), null, 'a shorter title is another show');
  assert.ok(matchesWanted('The.Expanse.S02E04E05.1080p-GRP', w), 'a double episode containing it');
  // Year and country tags in the library name
  assert.ok(matchesWanted('Doctor.Who.2005.S01E01.720p-X', wanted('Doctor Who (2005)', 1, 1)));
  assert.ok(matchesWanted('Doctor.Who.S01E01.720p-X', wanted('Doctor Who (2005)', 1, 1)));
  assert.ok(matchesWanted('Greys.Anatomy.S01E01.720p-X', wanted("Grey's Anatomy", 1, 1)));
});

test('pickBest: never the top result by default; only exact matches, quality required, no dupes', () => {
  const w = wanted('Show Name', 2, 5);
  const results = [
    dir('a', 'Show.Name.S02E06.1080p.WEB-TOP', { hits: 50 }),
    dir('b', 'Other.Show.Name.S02E05.1080p.WEB-TOP', { hits: 40 }),
    dir('c', 'Show.Name.S02E05.720p.WEB-LOW', { hits: 30 }),
    dir('d', 'Show.Name.S02E05.1080p.WEB-ALREADY', { hits: 20, dupe: { id: 'share_full' } }),
    file('e', 'Show.Name.S02E05.1080p.WEB-FILE.nfo', { hits: 10 }),
    dir('f', 'Show.Name.S02E05.1080p.WEB-OK', { hits: 2 }),
    dir('g', 'Show.Name.S02E05.1080p.WEB-MORE', { hits: 5 }),
    dir('h', 'Show.Name.S02E05.1080p.Sample-X', { hits: 99 }),
  ];
  const best = pickBest(results, w, { quality: '1080p' });
  assert.equal(best.result.id, 'g', 'the most sources among the exact matches');
  assert.equal(pickBest(results.slice(0, 5), w, { quality: '1080p' }), null, 'nothing exact: nothing at all');
});

test('pickBest: a preferred group wins over more sources; required groups filter', () => {
  const w = wanted('Show Name', 1, 1);
  const results = [ dir(1, 'Show.Name.S01E01.1080p-MANY', { hits: 9 }), dir(2, 'Show.Name.S01E01.1080p-LIKED', { hits: 1 }) ];
  assert.equal(pickBest(results, w, { groups: 'liked, other' }).result.id, 2);
  assert.equal(pickBest([ results[0] ], w, { groups: 'liked', requireGroup: true }), null);
  assert.equal(pickBest(results, w, {}).result.id, 1);
  // A video file is fine; users.count is read when hits is absent
  const files = [ { id: 3, name: 'Show.Name.S01E01.1080p-F.mkv', type: { id: 'file' }, users: { count: 4 } } ];
  assert.equal(pickBest(files, w, {}).result.id, 3);
});

test('pickBest: the release folder wins over its loose video file, whichever more users have', () => {
  const w = wanted('Show Name', 1, 3);
  const results = [
    file(1, 'Show.Name.S01E03.1080p.WEB-DL.x264-GRP.mkv', { hits: 5 }),
    dir(2, 'Show.Name.S01E03.1080p.WEB-DL.x264-GRP', { hits: 2 }),
  ];
  assert.equal(pickBest(results, w, { quality: '1080p' }).result.id, 2);
  assert.equal(pickBest([ ...results ].reverse(), w, { quality: '1080p' }).result.id, 2);
  // A preferred group still comes first: a liked group's file beats another group's folder
  const liked = [ dir(3, 'Show.Name.S01E03.1080p-OTHER', { hits: 9 }), file(4, 'Show.Name.S01E03.1080p-LIKED.mkv') ];
  assert.equal(pickBest(liked, w, { groups: 'liked' }).result.id, 4);
});

test('the query is words, the code and the quality', () => {
  assert.equal(buildQuery("Marvel's Agents of S.H.I.E.L.D. (2013)", 2, 5, '1080p'), 'Marvels Agents of S H I E L D S02E05 1080p');
  assert.equal(buildQuery('Show', 10, 12, ''), 'Show S10E12');
  assert.equal(buildQuery('Show', 1, 1, 'bad value!'), 'Show S01E01', 'a quality that is not one word is not typed');
  assert.ok(hasToken('A.1080p.B', '1080P'));
  assert.ok(!hasToken('A.10800p.B', '1080p'));
});
