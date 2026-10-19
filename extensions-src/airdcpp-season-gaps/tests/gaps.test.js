'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ownedEpisodes, isAired, wholeSeasonsToReport, missingInSeason, nativeEpisodes, DAY_MS } = require('../src/gaps');
const { canSearch, prune, HOUR_MS } = require('../src/budget');

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const ep = (season, number, end) => ({ ParentIndexNumber: season, IndexNumber: number, ...(end ? { IndexNumberEnd: end } : {}) });

test('a double episode counts for both numbers; unnumbered and virtual rows do not count', () => {
  const owned = ownedEpisodes([ ep(1, 1, 2), ep(1, 4), { IndexNumber: 3 }, { ...ep(1, 5), LocationType: 'Virtual' }, ep(2, 0) ]);
  assert.deepEqual([ ...owned.get(1) ].sort(), [ 1, 2, 4 ]);
  assert.equal(owned.has(2), false);
});

test('aired means before today minus the grace days', () => {
  assert.equal(isAired('2026-10-17', NOW, 1), false, 'yesterday is inside the grace');
  assert.equal(isAired('2026-10-16', NOW, 1), true);
  assert.equal(isAired('2026-10-17T00:00:00.0000000Z', NOW, 0), true);
  assert.equal(isAired('', NOW, 1), false);
  assert.equal(isAired('2027-01-01', NOW, 1), false);
});

test('whole seasons: between and after on, before off, specials off by default', () => {
  const owned = new Map([ [ 2, new Set([ 1 ]) ], [ 4, new Set([ 1 ]) ] ]);
  const seasons = [ 0, 1, 2, 3, 4, 5 ];
  assert.deepEqual(wholeSeasonsToReport(seasons, owned, { between: true, after: true, before: false }), [ 3, 5 ]);
  assert.deepEqual(wholeSeasonsToReport(seasons, owned, { between: false, after: false, before: true, includeSpecials: true }), [ 0, 1 ]);
  assert.deepEqual(wholeSeasonsToReport(seasons, new Map(), { between: true, after: true, before: true }), [], 'nothing held: nothing to place');
});

test('missing in a season: aired and not held; a season numbered another way is left out', () => {
  const list = [
    { number: 1, airDate: '2026-01-01' }, { number: 2, airDate: '2026-01-08' }, { number: 3, airDate: '2026-10-17' }, { number: 4, airDate: '' },
  ];
  assert.deepEqual(missingInSeason(list, new Set([ 1 ]), NOW, 1).map((m) => m.episode), [ 2 ]);
  assert.equal(missingInSeason(list, new Set([ 30 ]), NOW, 1), null, 'held numbers past the list');
  // The media server's own rows list only what is missing: no numbering check for them
  const native = nativeEpisodes([ { LocationType: 'Virtual', IndexNumber: 7, PremiereDate: '2026-02-01T00:00:00.0000000Z', Name: 'Seven' }, { IndexNumber: 8 } ]);
  assert.deepEqual(missingInSeason(native, new Set([ 1, 2 ]), NOW, 1, { checkNumbering: false }), [ { episode: 7, airDate: '2026-02-01', title: 'Seven' } ]);
});

test('search budget: spacing, hourly cap, a clock that went back', () => {
  const spacing = 20 * 1000;
  assert.deepEqual(canSearch([], NOW, 20, spacing), { ok: true });
  assert.equal(canSearch([ NOW - 5000 ], NOW, 20, spacing).ok, false);
  assert.equal(canSearch([ NOW - 5000 ], NOW, 20, spacing).waitMs, 15000);
  const full = Array.from({ length: 3 }, (_, i) => NOW - (i + 1) * 60 * 1000);
  assert.equal(canSearch(full, NOW, 3, spacing).ok, false);
  assert.equal(canSearch(full, NOW, 4, spacing).ok, true);
  assert.equal(canSearch([ NOW + 1000 ], NOW, 20, spacing).ok, false, 'a search from the future still blocks');
  assert.deepEqual(prune([ NOW - HOUR_MS - 1, NOW - 10, NOW + 2 * HOUR_MS ], NOW), [ NOW - 10 ], 'old and far-future times are dropped');
  assert.ok(DAY_MS > 0);
});
