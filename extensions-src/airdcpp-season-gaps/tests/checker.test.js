'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runCheck } = require('../src/checker');
const { isEnded } = require('../src/tmdb');

const NOW = Date.UTC(2026, 9, 18, 12);
const OPTIONS = { graceDays: 1, includeSpecials: false, between: true, after: true, before: false, identifyByName: true, setDisplayMissing: false, ignoredShows: '' };

const ep = (season, number, end) => ({ Type: 'Episode', ParentIndexNumber: season, IndexNumber: number, ...(end ? { IndexNumberEnd: end } : {}) });
const tmdbSeason = (n, count, date = '2025-01-01') => ({ episodes: Array.from({ length: count }, (_, i) => ({ episode_number: i + 1, air_date: date, name: `E${i + 1}` })), season_number: n });

// A media server: series -> { item, episodes, seasons, missing: { seasonNumber: rows } }
const fakeJellyfin = ({ displayMissing = false, series = [], onPost } = {}) => {
  const calls = [];
  return {
    calls,
    get: async (p, query = {}) => {
      calls.push([ p, query ]);
      if (p === '/Users/Me') return { Id: 'u1', Configuration: { DisplayMissingEpisodes: displayMissing } };
      if (p === '/Items') {
        const all = series.map((s) => s.item);
        return { Items: all.slice(query.StartIndex, query.StartIndex + query.Limit), TotalRecordCount: all.length };
      }

      const m = /^\/Shows\/([^/]+)\/(Episodes|Seasons)$/.exec(p);
      const s = series.find((x) => x.item.Id === decodeURIComponent(m[1]));
      if (m[2] === 'Seasons') return { Items: (s.seasons || []).map((n) => ({ Id: `${s.item.Id}-s${n}`, IndexNumber: n, Type: 'Season' })) };
      if (query.IsMissing === 'true') {
        const n = Number(query.SeasonId.split('-s')[1]);
        return { Items: (s.missing && s.missing[n]) || [], TotalRecordCount: 0 };
      }

      return { Items: s.episodes.slice(query.StartIndex, query.StartIndex + query.Limit), TotalRecordCount: s.episodes.length };
    },
    post: async (p, body) => {
      calls.push([ 'POST', p, body ]);
      if (onPost) return onPost(p, body);
      return null;
    },
  };
};

const fakeTmdb = (shows, { refuse = false } = {}) => {
  const calls = [];
  const fail = (status) => { const e = new Error(status === 401 ? 'TMDB refused the key' : 'nope'); e.status = status; e.fromTmdb = true; return e; };
  return {
    calls,
    isEnded,
    getShow: async (id) => {
      calls.push([ 'show', id ]);
      if (refuse) throw fail(401);
      if (!shows[id]) throw fail(404);
      return shows[id].show;
    },
    getSeason: async (id, n) => {
      calls.push([ 'season', id, n ]);
      if (refuse) throw fail(401);
      return shows[id].seasons[n];
    },
    searchShow: async (name) => {
      calls.push([ 'search', name ]);
      return { results: Object.entries(shows).map(([ id, s ]) => ({ id: Number(id), name: s.show.name, first_air_date: '2020-01-01' })) };
    },
  };
};

const series = (id, name, tmdbId, episodes, extra = {}) => ({
  item: { Id: id, Name: name, Type: 'Series', ProductionYear: 2020, ...(tmdbId ? { ProviderIds: { Tmdb: String(tmdbId) } } : {}) },
  episodes, ...extra,
});

test('TMDB only: gaps inside held seasons and whole seasons between and after, double episodes count twice', async () => {
  const jf = fakeJellyfin({
    series: [ series('A', 'Show A', 10, [ ep(1, 1, 2), ep(1, 4), ep(3, 1) ]) ],
  });
  const tmdb = fakeTmdb({
    10: {
      show: { name: 'Show A', status: 'Returning Series', seasons: [ { season_number: 0, episode_count: 3 }, { season_number: 1, episode_count: 4 }, { season_number: 2, episode_count: 2 }, { season_number: 3, episode_count: 1 }, { season_number: 4, episode_count: 2 } ] },
      seasons: { 1: tmdbSeason(1, 4), 2: tmdbSeason(2, 2), 4: { episodes: [ { episode_number: 1, air_date: '2026-10-10' }, { episode_number: 2, air_date: '2026-10-17' } ] } },
    },
  });
  const result = await runCheck({ jellyfin: jf, tmdb, options: OPTIONS, now: NOW });
  const show = result.shows[0];
  assert.deepEqual(show.seasons.map((s) => [ s.season, s.whole, s.missing.map((m) => m.episode) ]), [ [ 1, false, [ 3 ] ], [ 2, true, [ 1, 2 ] ], [ 4, true, [ 1 ] ] ]);
  assert.equal(result.native, false);
  assert.ok(!tmdb.calls.some((c) => c[0] === 'season' && c[2] === 3), 'a complete season is not fetched');
  assert.ok(!tmdb.calls.some((c) => c[0] === 'season' && c[2] === 0), 'specials skipped by default');
});

test('native lists are used for held seasons when the preference is on; TMDB only for whole seasons', async () => {
  const jf = fakeJellyfin({
    displayMissing: true,
    series: [ series('A', 'Show A', 10, [ ep(1, 1) ], { seasons: [ 1 ], missing: { 1: [ { LocationType: 'Virtual', IndexNumber: 2, PremiereDate: '2025-02-01T00:00:00.0000000Z', Name: 'Two' } ] } }) ],
  });
  const tmdb = fakeTmdb({ 10: { show: { name: 'Show A', status: 'Ended', seasons: [ { season_number: 1, episode_count: 2 } ] }, seasons: {} } });
  const result = await runCheck({ jellyfin: jf, tmdb, options: OPTIONS, now: NOW });
  assert.deepEqual(result.shows[0].seasons, [ { season: 1, whole: false, missing: [ { episode: 2, airDate: '2025-02-01', title: 'Two' } ] } ]);
  assert.ok(!tmdb.calls.some((c) => c[0] === 'season'), 'the native answer was enough');
  assert.ok(jf.calls.some(([ p, q ]) => p === '/Shows/A/Episodes' && q.IsMissing === 'true' && q.SeasonId === 'A-s1'));
  // Only the keys the media server treats as a season page (withMissingEpisodes DRAWING list)
  const nativeCall = jf.calls.find(([ , q ]) => q && q.IsMissing === 'true');
  assert.deepEqual(Object.keys(nativeCall[1]).sort(), [ 'IsMissing', 'SeasonId' ]);
});

test('native without TMDB: works, says whole seasons are not covered; neither source: a clear refusal', async () => {
  const jf = fakeJellyfin({ displayMissing: true, series: [ series('A', 'Show A', null, [ ep(2, 1) ], { seasons: [ 2 ], missing: { 2: [] } }) ] });
  const result = await runCheck({ jellyfin: jf, tmdb: null, options: OPTIONS, now: NOW });
  assert.ok(result.notes.some((n) => /whole missing seasons are not reported/.test(n)));
  assert.equal(result.shows[0].seasons.length, 0);

  const off = fakeJellyfin({ displayMissing: false, series: [] });
  await assert.rejects(runCheck({ jellyfin: off, tmdb: null, options: OPTIONS, now: NOW }), (e) => e.status === 412 && /Display missing episodes/.test(e.message));
});

test('the preference is turned on only when the setting says so', async () => {
  const jf = fakeJellyfin({ series: [] });
  await runCheck({ jellyfin: jf, tmdb: fakeTmdb({}), options: OPTIONS, now: NOW });
  assert.ok(!jf.calls.some((c) => c[0] === 'POST'));
  const jf2 = fakeJellyfin({ series: [] });
  const result = await runCheck({ jellyfin: jf2, tmdb: null, options: { ...OPTIONS, setDisplayMissing: true }, now: NOW });
  assert.deepEqual(jf2.calls.find((c) => c[0] === 'POST'), [ 'POST', '/Users/u1/Configuration', { DisplayMissingEpisodes: true } ]);
  assert.equal(result.native, true);
});

test('a refused TMDB key does not end the check; a refused media server does', async () => {
  const jf = fakeJellyfin({ displayMissing: true, series: [ series('A', 'A', 1, [ ep(1, 1) ], { seasons: [ 1 ], missing: { 1: [] } }), series('B', 'B', 2, [ ep(1, 1) ], { seasons: [ 1 ], missing: { 1: [] } }) ] });
  const tmdb = fakeTmdb({}, { refuse: true });
  const result = await runCheck({ jellyfin: jf, tmdb, options: OPTIONS, now: NOW });
  assert.equal(result.notes.filter((n) => /TMDB refused the key/.test(n)).length, 1, 'said once');
  assert.equal(tmdb.calls.length, 1, 'not asked again after the refusal');
  assert.equal(result.checkedShows, 2);

  const broken = fakeJellyfin({ displayMissing: true, series: [ series('A', 'A', 1, [ ep(1, 1) ]) ] });
  const realGet = broken.get;
  broken.get = async (p, q) => {
    if (p.startsWith('/Shows/')) { const e = new Error('the media server refused the credentials'); e.status = 401; throw e; }
    return realGet(p, q);
  };
  await assert.rejects(runCheck({ jellyfin: broken, tmdb: null, options: OPTIONS, now: NOW }), (e) => e.status === 401);
});

test('identify by name: only one show with that exact title; ignore list; numbered differently is left out', async () => {
  const jf = fakeJellyfin({
    series: [
      series('A', 'Unique Show', null, [ ep(1, 1) ]),
      series('B', 'Skip Me', null, [ ep(1, 1) ]),
      series('C', 'Anime', 30, [ ep(1, 130) ]),
    ],
  });
  const tmdb = fakeTmdb({
    20: { show: { name: 'Unique Show', status: 'Ended', seasons: [ { season_number: 1, episode_count: 2 } ] }, seasons: { 1: tmdbSeason(1, 2) } },
    30: { show: { name: 'Anime', status: 'Ended', seasons: [ { season_number: 1, episode_count: 24 } ] }, seasons: { 1: tmdbSeason(1, 24) } },
  });
  const result = await runCheck({ jellyfin: jf, tmdb, options: { ...OPTIONS, ignoredShows: 'skip me' }, now: NOW });
  const [ a, b, c ] = result.shows;
  assert.equal(a.tmdbId, '20');
  assert.deepEqual(a.seasons[0].missing.map((m) => m.episode), [ 2 ]);
  assert.equal(b.skipped, 'on the ignore list');
  assert.equal(c.seasons.length, 0);
  assert.ok(result.notes.some((n) => /Anime season 1: numbered differently/.test(n)));
});

test('identify by name refuses an ambiguous answer', async () => {
  const { identify } = require('../src/checker');
  const { titleKeys } = require('../src/release');
  const tmdb = { searchShow: async () => ({ results: [ { id: 1, name: 'Same', first_air_date: '2020-01-01' }, { id: 2, name: 'Same', first_air_date: '2021-05-01' } ] }) };
  assert.equal(await identify(tmdb, 'Same', 0, titleKeys('Same')), null);
  assert.equal(await identify(tmdb, 'Same', 2020, titleKeys('Same')), null, 'both within a year of 2020');
  assert.equal(await identify(tmdb, 'Same', 2019, titleKeys('Same')), '1');
});

// REVIEW: the keys a show is matched by. TMDB names the US show "The Office", which is also the
// UK show's release name; and a year in a release name has to be the show's year.
test('show keys: a country-tagged library name drops the bare TMDB title; years are kept for the release check', async () => {
  const { matchesWanted } = require('../src/release');
  const jf = fakeJellyfin({
    series: [
      series('O', 'The Office (US)', 2316, [ ep(1, 1) ]),
      { item: { Id: 'D', Name: 'Doctor Who', Type: 'Series', ProductionYear: 1963, ProviderIds: { Tmdb: '121' } }, episodes: [ ep(1, 1) ] },
    ],
  });
  const tmdb = fakeTmdb({
    2316: { show: { name: 'The Office', original_name: 'The Office', status: 'Ended', first_air_date: '2005-03-24', seasons: [ { season_number: 1, episode_count: 1 } ] }, seasons: {} },
    121: { show: { name: 'Doctor Who', status: 'Ended', first_air_date: '1963-11-23', seasons: [ { season_number: 1, episode_count: 1 } ] }, seasons: {} },
  });
  const result = await runCheck({ jellyfin: jf, tmdb, options: OPTIONS, now: NOW });
  const wantedOf = (show) => ({ keys: new Set(show.keys), years: show.years, season: 2, episode: 5 });
  const [ office, who ] = result.shows;
  assert.ok(matchesWanted('The.Office.US.S02E05.720p-X', wantedOf(office)));
  assert.equal(matchesWanted('The.Office.S02E05.720p-X', wantedOf(office)), null, 'the bare title is the UK show');
  assert.equal(matchesWanted('Doctor.Who.2005.S02E05.720p-X', wantedOf(who)), null, 'the 2005 show is not the 1963 one');
  assert.ok(matchesWanted('Doctor.Who.1963.S02E05.720p-X', wantedOf(who)));
  assert.ok(matchesWanted('Doctor.Who.S02E05.720p-X', wantedOf(who)));
});

test('live test: native only, a series the media server has not identified is flagged, not reported clean', async () => {
  // Live rig 2026-10-18: media server metadata off -> series without ProviderIds.Tmdb -> no IsMissing rows.
  // The check said "0 show(s) with gaps" for a season with E03 and E05 missing.
  const { summaryText, buildMarkdown } = require('../src/report');
  const jf = fakeJellyfin({ displayMissing: true, series: [ series('A', 'Show A', null, [ ep(1, 1), ep(1, 2), ep(1, 4) ], { seasons: [ 1 ], missing: { 1: [] } }) ] });
  const result = await runCheck({ jellyfin: jf, tmdb: null, options: OPTIONS, now: NOW });
  assert.match(result.shows[0].partial || '', /not identified/);
  assert.ok(result.notes.some((n) => /metadata/.test(n) && /none of/i.test(n)), result.notes.join(' | '));
  assert.match(summaryText(result), /1 show\(s\) not identified/);
  assert.match(buildMarkdown(result), /Not fully checked[\s\S]*Show A: .*not identified/);

  // An identified series (ProviderIds.Tmdb set) is not flagged, and no note
  const jf2 = fakeJellyfin({ displayMissing: true, series: [ series('B', 'Show B', 77, [ ep(1, 1) ], { seasons: [ 1 ], missing: { 1: [] } }) ] });
  const ok = await runCheck({ jellyfin: jf2, tmdb: null, options: OPTIONS, now: NOW });
  assert.equal(ok.shows[0].partial || '', '');
  assert.ok(!ok.notes.some((n) => /metadata/.test(n)));
  assert.doesNotMatch(summaryText(ok), /not identified/);
});
