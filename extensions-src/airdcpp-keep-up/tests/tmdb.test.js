'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTmdb } = require('../src/tmdb');

const respond = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body || {}) });

const SHOW = { id: 42, name: 'The Show', original_name: 'The Show', first_air_date: '2019-03-01', seasons: [ { season_number: 0, episode_count: 3 }, { season_number: 1, episode_count: 3 }, { season_number: 2, episode_count: 2 } ] };
const SEASONS = {
  1: { episodes: [ { episode_number: 1, air_date: '2019-03-01' }, { episode_number: 2, air_date: '2019-03-08' }, { episode_number: 3, air_date: '2019-03-15' } ] },
  2: { episodes: [ { episode_number: 1, air_date: '2026-10-01' }, { episode_number: 2, air_date: '2026-12-01' } ] },
};

const setup = (key = 'secretkey123') => {
  const calls = [];
  let saved = null;
  let clock = 1_000_000;
  const tmdb = createTmdb({
    getKey: () => key,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const u = new URL(url);
      if (u.pathname === '/3/tv/42') return respond(200, SHOW);
      const season = /\/3\/tv\/42\/season\/(\d+)$/.exec(u.pathname);
      if (season) return respond(200, SEASONS[season[1]]);
      if (u.pathname === '/3/search/tv') return respond(200, { results: [ { id: 7, name: 'The Show Aftershow' }, { id: 42, name: 'The Show', first_air_date: '2019-03-01' } ] });
      if (u.pathname === '/3/tv/401') return respond(401);
      return respond(404);
    },
    loadCache: () => saved,
    saveCache: (c) => { saved = JSON.parse(JSON.stringify(c)); },
    now: () => clock,
  });
  return { tmdb, calls, saved: () => saved, tick: (ms) => { clock += ms; } };
};

test('episodes after the last watched one span seasons, skip specials, and are cached', async () => {
  const t = setup();
  const { episodes, info } = await t.tmdb.episodesAfter(42, 1, 2, 3);
  assert.equal(info.year, 2019);
  assert.deepEqual(episodes.map((e) => `${e.season}x${e.episode}@${e.airDate}`), [ '1x3@2019-03-15', '2x1@2026-10-01', '2x2@2026-12-01' ]);
  const before = t.calls.length;
  await t.tmdb.episodesAfter(42, 1, 2, 3);
  assert.equal(t.calls.length, before, 'served from the cache');
  t.tick(13 * 60 * 60 * 1000);
  await t.tmdb.episodesAfter(42, 1, 2, 3);
  assert.ok(t.calls.length > before, 'refreshed after the TTL');
  assert.ok(t.saved().seasons['42:1']);
});

test('findShow takes only an exact normalised name (and year) match', async () => {
  const t = setup();
  assert.equal(await t.tmdb.findShow('The Show (2019)'), 42);
  const url = new URL(t.calls[0].url);
  assert.equal(url.searchParams.get('query'), 'The Show');
  assert.equal(url.searchParams.get('first_air_date_year'), '2019');
  assert.equal(await t.tmdb.findShow('Show'), null);
});

test('the key is never in an error message; a v4 token goes in a header, not the URL', async () => {
  const t = setup();
  await assert.rejects(t.tmdb.show(401), (e) => e.status === 401 && !e.message.includes('secretkey123'));
  const v4 = setup('eyJhbGciOi.token');
  await v4.tmdb.show(42);
  assert.equal(v4.calls[0].options.headers.Authorization, 'Bearer eyJhbGciOi.token');
  assert.ok(!v4.calls[0].url.includes('eyJ'));
  assert.equal(v4.calls[0].options.redirect, 'error');
});

test('no key: refuses without a request', async () => {
  const t = setup('');
  await assert.rejects(t.tmdb.show(42), /no TMDB key/);
  assert.equal(t.calls.length, 0);
});

test('the last watched episode missing from TMDB numbering yields nothing, flagged', async () => {
  const t = setup();
  const answer = await t.tmdb.episodesAfter(42, 1, 25, 3);
  assert.equal(answer.numberingDiffers, true);
  assert.deepEqual(answer.episodes, []);
});
