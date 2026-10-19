'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const plan = require('../src/plan');

const NOW = Date.parse('2026-10-18T12:00:00Z');
const ep = (s, e, played, at, extra = {}) => ({
  Type: 'Episode', SeriesId: 'show1', SeriesName: 'The Show', ParentIndexNumber: s, IndexNumber: e,
  UserData: { Played: played, LastPlayedDate: at || null }, ...extra,
});

test('recent shows: played within D days, most recent first; older and unplayed ignored', () => {
  const items = [
    ep(1, 1, true, '2026-10-17T20:00:00Z'),
    ep(1, 2, true, '2026-10-10T20:00:00Z'),
    { ...ep(3, 1, true, '2026-09-01T20:00:00Z'), SeriesId: 'old', SeriesName: 'Old' },
    { ...ep(1, 1, false, null), SeriesId: 'never', SeriesName: 'Never' },
    { ...ep(1, 1, true, '2026-10-18T08:00:00Z'), SeriesId: 'b', SeriesName: 'B' },
  ];
  const shows = plan.recentShows(items, NOW, 14);
  assert.deepEqual(shows.map((s) => s.seriesId), [ 'b', 'show1' ]);
  assert.equal(shows[1].lastPlayedMs, Date.parse('2026-10-17T20:00:00Z'));
});

test('furthest played in airing order; specials and virtual rows ignored; double episodes held', () => {
  const eps = [ ep(1, 1, true), ep(1, 5, true), ep(1, 3, true), ep(0, 9, true), ep(2, 1, false), ep(1, 6, true, null, { LocationType: 'Virtual' }), ep(1, 7, false, null, { IndexNumberEnd: 8 }) ];
  assert.deepEqual(plan.furthestPlayed(eps), { season: 1, episode: 5 });
  const held = plan.heldEpisodes(eps);
  assert.equal(held.has('1:8'), true);
  assert.equal(held.has('1:6'), false);
  assert.equal(plan.furthestPlayed([ ep(1, 1, false) ]), null);
});

test('wanted: aired and not held only', () => {
  const next = [ { season: 1, episode: 6, airDate: '2026-10-01' }, { season: 1, episode: 7, airDate: '2026-10-18' }, { season: 1, episode: 8, airDate: '2026-10-25' }, { season: 2, episode: 1, airDate: '' } ];
  const wanted = plan.wantedEpisodes(next, new Set([ '1:6' ]), NOW);
  assert.deepEqual(wanted.map((e) => e.episode), [ 7 ]);
});

test('next from the server missing rows: K after the furthest, held rows counted', () => {
  const rows = [ ep(1, 5, true), ep(1, 6, false), { ...ep(1, 7, false), LocationType: 'Virtual', PremiereDate: '2026-10-01T00:00:00.0000000Z' }, { ...ep(1, 8, false), LocationType: 'Virtual', PremiereDate: '2026-10-08T00:00:00.0000000Z' } ];
  const next = plan.nextFromMissingRows(rows, { season: 1, episode: 5 }, 2);
  assert.deepEqual(next.map((e) => e.episode), [ 6, 7 ]);
  assert.equal(next[1].airDate, '2026-10-01');
});

test('backoff doubles from 1 h up to 24 h', () => {
  assert.deepEqual([ 1, 2, 3, 5, 6, 20 ].map((n) => plan.backoffMs(n) / 3600000), [ 1, 2, 4, 16, 24, 24 ]);
});

test('furthest played: a rewatch of an early episode does not move it back; out of order takes the furthest', () => {
  const held = { LocationType: 'FileSystem' };
  // Watched to S02E03, now rewatching S01E01 (played again recently)
  assert.deepEqual(plan.furthestPlayed([ ep(1, 1, true, '2026-10-18T08:00:00Z', held), ep(1, 2, true, '2026-01-01T00:00:00Z', held),
    ep(2, 3, true, '2026-02-01T00:00:00Z', held), ep(2, 4, false, null, held) ]), { season: 2, episode: 3 });
  // Watched S01E05 before S01E03: the place is E05; a special (season 0) and a missing row never count
  assert.deepEqual(plan.furthestPlayed([ ep(1, 5, true, '2026-10-01T00:00:00Z', held), ep(1, 3, true, '2026-10-17T00:00:00Z', held),
    ep(0, 9, true, '2026-10-18T00:00:00Z', held), ep(1, 8, true, '2026-10-18T00:00:00Z', { LocationType: 'Virtual' }) ]), { season: 1, episode: 5 });
});
