'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  base32ToHex16, isUnder, isRecordingName, selectCandidates, lastEpisodesKept, planRemoval, applyCaps, buildReport, GIB, DAY_MS,
} = require('../src/decide');

const NOW = Date.parse('2026-10-18T12:00:00Z');
const ago = (days) => new Date(NOW - days * DAY_MS).toISOString();

const film = (id, extra = {}, ud = {}) => ({
  Id: id, Type: 'Movie', Name: `Film ${id}`, DateCreated: ago(400),
  UserData: { Played: true, PlayCount: 1, LastPlayedDate: ago(60), IsFavorite: false, PlaybackPositionTicks: 0, ...ud }, ...extra,
});
const ep = (id, series, s, e, ud = {}) => film(id, { Type: 'Episode', SeriesId: series, SeriesName: series, ParentIndexNumber: s, IndexNumber: e }, ud);
const account = (played, resumable = [], favorites = []) => ({ played, resumable, favorites });
const pick = (accounts, opts = {}) => selectCandidates({ accounts, now: NOW, watchedDays: 30, addedDays: 14, keepLastEpisodes: 0, ...opts });

test('base32 path ids decode to the media server id (empty-file TTH known value)', () => {
  // TTH of an empty file: LWPNACQDBZRYXW3VHJVCJ64QBZNGHOHHHZWCLNQ = 5D9ED00A030E638BDB753A6A24FB900E5A63B8E73E6C25B6
  assert.equal(base32ToHex16('LWPNACQDBZRYXW3VHJVCJ64QBZNGHOHHHZWCLNQ'), '5d9ed00a030e638bdb753a6a24fb900e');
  assert.equal(base32ToHex16('not base32!'), '');
  assert.equal(base32ToHex16('AAAA'), '');
});

test('isUnder is case-insensitive and separator-aware', () => {
  assert.ok(isUnder('D:\\Media\\Films\\A\\a.mkv', 'd:\\media\\films\\'));
  assert.ok(isUnder('D:\\Media\\Films', 'D:\\Media\\Films\\'));
  assert.ok(!isUnder('D:\\Media\\Films2\\a.mkv', 'D:\\Media\\Films'));
  assert.ok(!isUnder('D:\\x', ''));
});

test('recordings are recognised by the client\'s own naming', () => {
  assert.ok(isRecordingName('News 20261001 1a2b3c.ts'));
  assert.ok(!isRecordingName('Film.2019.1080p.mkv'));
  assert.ok(!isRecordingName('Show.S01E01.ts'));
});

test('a film watched long ago by the only account is a candidate; recent, new, favourite and in-progress are not', () => {
  const { candidates, excluded } = pick([ account([
    film('a'),
    film('b', {}, { LastPlayedDate: ago(5) }),
    film('c', { DateCreated: ago(3) }),
    film('d', {}, { IsFavorite: true }),
    film('e', {}, { PlaybackPositionTicks: 5000 }),
    film('f', { Type: 'Video' }),
    film('g', {}, { LastPlayedDate: null }),
    film('h', { DateCreated: undefined }),
  ]) ]);
  assert.deepEqual(candidates.map((c) => c.Id), [ 'a' ]);
  assert.equal(excluded['watched recently'], 1);
  assert.equal(excluded['added recently'], 2);
  assert.equal(excluded['a favourite'], 1);
  assert.equal(excluded['being watched again'], 1);
  assert.equal(excluded['not a film or an episode'], 1);
  assert.equal(excluded['no last played date'], 1);
});

test('every counted account must have watched it; the most recent watch decides the age', () => {
  const one = account([ film('a'), film('b'), film('c') ]);
  const two = account([ film('a'), film('c', {}, { LastPlayedDate: ago(2) }) ]);
  const { candidates, excluded } = pick([ one, two ]);
  assert.deepEqual(candidates.map((c) => c.Id), [ 'a' ]);
  assert.equal(excluded['not watched by every account'], 1);
  assert.equal(excluded['watched recently'], 1);
});

test('a favourite of ANY account, or a favourite series, keeps it', () => {
  const one = account([ film('a'), ep('e1', 'S', 1, 1) ]);
  const two = account([ film('a', {}, { IsFavorite: true }), ep('e1', 'S', 1, 1) ], [], [ { Id: 'S', Type: 'Series' } ]);
  assert.deepEqual(pick([ one, two ]).candidates, []);
});

test('a series with an episode in progress for anyone keeps all its episodes', () => {
  const one = account([ ep('e1', 'S', 1, 1), ep('x1', 'X', 1, 1) ]);
  const two = account([ ep('e1', 'S', 1, 1), ep('x1', 'X', 1, 1) ], [ { Id: 'e5', SeriesId: 'S', Type: 'Episode' } ]);
  assert.deepEqual(pick([ one, two ]).candidates.map((c) => c.Id), [ 'x1' ]);
});

test('the last K watched episodes of each series are kept, in series order, per account', () => {
  const played = [ ep('e1', 'S', 1, 1), ep('e2', 'S', 1, 2), ep('e3', 'S', 2, 1), ep('t1', 'T', 1, 1) ];
  assert.deepEqual([ ...lastEpisodesKept(played, 1) ].sort(), [ 'e3', 't1' ]);
  assert.deepEqual(pick([ account(played) ], { keepLastEpisodes: 1 }).candidates.map((c) => c.Id).sort(), [ 'e1', 'e2' ]);
  assert.deepEqual(pick([ account(played) ], { keepLastEpisodes: 2 }).candidates.map((c) => c.Id), [ 'e1' ]);
  // Another account is further behind: its last one is kept too
  const behind = account([ ep('e1', 'S', 1, 1), ep('e2', 'S', 1, 2), ep('e3', 'S', 2, 1) ].map((x) => x).slice(0, 3));
  behind.played = behind.played.filter((x) => x.Id !== 'e3');
  assert.deepEqual(pick([ account(played), behind ], { keepLastEpisodes: 1 }).candidates.map((c) => c.Id), [ 'e1' ]);
});

test('candidates come out oldest watch first, ids normalised', () => {
  const { candidates } = pick([ account([ film('B-2', {}, { LastPlayedDate: ago(40) }), film('a1', {}, { LastPlayedDate: ago(90) }) ]) ]);
  assert.deepEqual(candidates.map((c) => c.Id), [ 'a1', 'b2' ]);
});

const roots = [ 'D:\\Media\\' ];

test('a release folder holding only the film (plus nfo, sample, subs) goes as a whole folder', () => {
  const plan = planRemoval({
    file: 'D:\\Media\\Films\\Film.2019-GRP\\film.2019.mkv', type: 'Movie', guarded: roots,
    entries: [
      { rel: 'film.2019.mkv', size: 4 * GIB, isDir: false },
      { rel: 'film.2019.nfo', size: 1000, isDir: false },
      { rel: 'Sample', size: 0, isDir: true },
      { rel: 'Sample\\film-sample.mkv', size: 50e6, isDir: false },
      { rel: 'Subs', size: 0, isDir: true },
      { rel: 'Subs\\film.idx', size: 1e6, isDir: false },
    ],
  });
  assert.equal(plan.kind, 'folder');
  assert.deepEqual(plan.paths, [ 'D:\\Media\\Films\\Film.2019-GRP' ]);
  assert.equal(plan.refresh, 'D:\\Media\\Films');
});

test('a share root, or a folder holding a keep folder, is never moved as a whole', () => {
  const entries = [ { rel: 'film.mkv', size: GIB, isDir: false } ];
  let plan = planRemoval({ file: 'D:\\Media\\film.mkv', type: 'Movie', guarded: roots, entries });
  assert.equal(plan.kind, 'files');
  assert.deepEqual(plan.paths, [ 'D:\\Media\\film.mkv' ]);
  plan = planRemoval({ file: 'D:\\Media\\A\\film.mkv', type: 'Movie', guarded: [ ...roots, 'D:\\Media\\A\\Keep' ], entries });
  assert.equal(plan.kind, 'files');
});

test('a folder with other films is not moved; a season folder loses only the episode and its sidecars', () => {
  const two = [ { rel: 'a.mkv', size: GIB, isDir: false }, { rel: 'b.mkv', size: GIB, isDir: false } ];
  assert.ok(planRemoval({ file: 'D:\\Media\\M\\a.mkv', type: 'Movie', guarded: roots, entries: two }).skip);

  const plan = planRemoval({
    file: 'D:\\Media\\Show\\S01\\Show.S01E01.mkv', type: 'Episode', guarded: roots,
    entries: [
      { rel: 'Show.S01E01.mkv', size: GIB, isDir: false },
      { rel: 'Show.S01E01.en.srt', size: 10, isDir: false },
      { rel: 'Show.S01E01-thumb.jpg', size: 10, isDir: false },
      { rel: 'Show.S01E01.nfo', size: 10, isDir: false },
      { rel: 'Show.S01E01.extra.mkv', size: 10, isDir: false },
      { rel: 'Show.S01E010.mkv', size: GIB, isDir: false },
      { rel: 'Show.S01E010.srt', size: 10, isDir: false },
      { rel: 'Show.S01E02.mkv', size: GIB, isDir: false },
      { rel: 'notes.docx', size: 10, isDir: false },
    ],
  });
  assert.equal(plan.kind, 'files');
  assert.deepEqual(plan.paths, [
    'D:\\Media\\Show\\S01\\Show.S01E01.mkv', 'D:\\Media\\Show\\S01\\Show.S01E01.en.srt',
    'D:\\Media\\Show\\S01\\Show.S01E01-thumb.jpg', 'D:\\Media\\Show\\S01\\Show.S01E01.nfo',
  ]);
});

test('a folder with a stranger (a document, music, a big extra) stays', () => {
  const base = [ { rel: 'film.mkv', size: GIB, isDir: false } ];
  for (const extra of [ { rel: 'thesis.docx', size: 10 }, { rel: 'song.mp3', size: 10 }, { rel: 'bonus.iso', size: 10 }, { rel: 'big.nfo', size: 0.6 * GIB } ]) {
    const plan = planRemoval({ file: 'D:\\Media\\F\\film.mkv', type: 'Episode', guarded: roots, entries: [ ...base, { ...extra, isDir: false } ] });
    assert.equal(plan.kind, 'files', extra.rel);
  }

  assert.equal(planRemoval({ file: 'D:\\Media\\F\\film.mkv', type: 'Episode', guarded: roots, entries: base, overflow: true }).kind, 'files');
  assert.ok(planRemoval({ file: 'D:\\Media\\F\\film.mkv', type: 'Movie', guarded: roots, entries: base, overflow: true }).skip);
});

test('a packed release goes only with its own folder', () => {
  const entries = [ { rel: 'f.rar', size: GIB, isDir: false }, { rel: 'f.r00', size: GIB, isDir: false }, { rel: 'f.sfv', size: 1, isDir: false } ];
  assert.equal(planRemoval({ file: 'D:\\Media\\R\\f.rar', type: 'Movie', guarded: roots, entries }).kind, 'folder');
  assert.ok(planRemoval({ file: 'D:\\Media\\f.rar', type: 'Movie', guarded: roots, entries }).skip);
});

test('caps: item count and bytes', () => {
  const items = [ { bytes: 100 }, { bytes: 300 }, { bytes: 50 }, { bytes: 10 } ];
  assert.deepEqual(applyCaps(items, 2, 1000).taken.map((i) => i.bytes), [ 100, 300 ]);
  assert.deepEqual(applyCaps(items, 10, 200).taken.map((i) => i.bytes), [ 100, 50, 10 ]);
});

test('the report escapes table breakers and totals per drive', () => {
  const report = buildReport({
    planned: [
      { item: { Name: 'A | B\nC', Type: 'Movie', lastPlayed: NOW }, kind: 'files', paths: [ 'D:\\x|y.mkv' ], bytes: 2 * GIB },
      { item: { Name: 'E', Type: 'Episode', SeriesName: 'S', ParentIndexNumber: 1, IndexNumber: 2, lastPlayed: NOW }, kind: 'folder', paths: [ 'E:\\r' ], bytes: GIB },
    ],
    skipped: [ { item: { Name: 'Q', Type: 'Movie' }, reason: 'in the download queue', path: 'D:\\q.mkv' } ],
    excluded: { 'watched recently': 3 }, accounts: [ 'me' ], uncovered: [ 'kid' ], now: NOW, settingsText: 'x',
  });
  assert.match(report, /\| A   B C \| 2026-10-18 \| 2\.0 GiB \| `D:\\x y\.mkv` \|/);
  assert.match(report, /- D: 2\.0 GiB/);
  assert.match(report, /- E: 1\.0 GiB/);
  assert.match(report, /S S01E02 - E/);
  assert.match(report, /Not counted .*kid/);
  assert.match(report, /watched recently: 3/);
});

// Review 2026-10-18: a whole folder must never take OTHER media with it
const f = (rel, size = 1000, isDir = false) => ({ rel, size, isDir });

test('a packed release sharing its folder with ANOTHER packed release is not moved as a folder', () => {
  const entries = [
    f('grp-film.rar', 100e6), f('grp-film.r00', 100e6), f('grp-film.nfo', 10),
    f('other-release.rar', 100e6), f('other-release.r00', 100e6),
  ];
  const plan = planRemoval({ file: 'D:\\Media\\Misc\\grp-film.rar', type: 'Movie', guarded: roots, entries });
  assert.notEqual(plan.kind, 'folder');
  // .partNN.rar sets: another set is a stranger too
  const parts = [ f('a.part1.rar', 100e6), f('a.part2.rar', 100e6), f('b.part1.rar', 100e6), f('b.part2.rar', 100e6) ];
  assert.notEqual(planRemoval({ file: 'D:\\Media\\Misc\\a.part1.rar', type: 'Movie', guarded: roots, entries: parts }).kind, 'folder');
  // Its own set, its Subs folder's rar and Sample: still the whole folder
  const own = [ f('a.part1.rar', 100e6), f('a.part2.rar', 100e6), f('a.nfo', 10), f('Subs', 0, true), f('Subs\\a.subs.rar', 1e6) ];
  assert.equal(planRemoval({ file: 'D:\\Media\\R\\a.part1.rar', type: 'Movie', guarded: roots, entries: own }).kind, 'folder');
  const old = [ f('grp-film.rar', 100e6), f('grp-film.r00', 100e6), f('grp-film.r01', 100e6), f('grp-film.sfv', 1) ];
  assert.equal(planRemoval({ file: 'D:\\Media\\R\\grp-film.rar', type: 'Movie', guarded: roots, entries: old }).kind, 'folder');
});

test('an unpacked film folder holding someone else\'s archive is not moved as a folder', () => {
  const entries = [ f('film.mkv', 4 * GIB), f('holiday.part1.rar', 50e6), f('holiday.part2.rar', 50e6) ];
  assert.notEqual(planRemoval({ file: 'D:\\Media\\F\\film.mkv', type: 'Episode', guarded: roots, entries }).kind, 'folder');
  const zip = [ f('film.mkv', 4 * GIB), f('photos.zip', 50e6) ];
  assert.notEqual(planRemoval({ file: 'D:\\Media\\F\\film.mkv', type: 'Episode', guarded: roots, entries: zip }).kind, 'folder');
  // The film's own subtitle archive is fine
  const subs = [ f('film.mkv', 4 * GIB), f('film.subs.rar', 1e6) ];
  assert.equal(planRemoval({ file: 'D:\\Media\\F\\film.mkv', type: 'Episode', guarded: roots, entries: subs }).kind, 'folder');
});

test('personal pictures beside a film keep the folder; release artwork does not', () => {
  const photos = [ f('film.mkv', 4 * GIB), f('IMG_0001.jpg', 3e6), f('IMG_0002.jpg', 3e6), f('family.png', 3e6) ];
  assert.notEqual(planRemoval({ file: 'D:\\Media\\F\\film.mkv', type: 'Movie', guarded: roots, entries: photos }).kind, 'folder');
  const art = [
    f('film.mkv', 4 * GIB), f('poster.jpg'), f('fanart.jpg'), f('folder.jpg'), f('film-poster.jpg'), f('clearlogo.png'),
    f('grp-film-proof.jpg'), f('Proof', 0, true), f('Proof\\scan.jpg'), f('extrafanart', 0, true), f('extrafanart\\fanart1.jpg'),
  ];
  assert.equal(planRemoval({ file: 'D:\\Media\\F\\film.mkv', type: 'Movie', guarded: roots, entries: art }).kind, 'folder');
});

test('a full-size video that merely has "sample" in its name is another video, not a sample', () => {
  const entries = [ f('film.mkv', 4 * GIB), f('The.Sample.1999.mkv', 450 * 1024 * 1024) ];
  assert.ok(planRemoval({ file: 'D:\\Media\\F\\film.mkv', type: 'Movie', guarded: roots, entries }).skip);
});

test('a .strm (a pointer, not a packed release) is never moved as a folder', () => {
  const entries = [ f('film.strm', 100), f('film.nfo', 10), f('IMG_0001.jpg', 3e6) ];
  const plan = planRemoval({ file: 'D:\\Media\\F\\film.strm', type: 'Movie', guarded: roots, entries });
  assert.notEqual(plan.kind, 'folder');
});
