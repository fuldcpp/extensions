'use strict';

// The media server client and the TMDB client against fake fetches

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createJellyfin } = require('../src/jellyfin');
const { createTmdb, isBearer } = require('../src/tmdb');

const response = (status, body, headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
  headers: { get: (name) => headers[name.toLowerCase()] },
});

const jellyfinWith = (handler, creds = {}) => {
  const calls = [];
  const saved = { token: null };
  const client = createJellyfin({
    getBaseUrl: async () => 'http://127.0.0.1:8096/',
    getCredentials: () => ({ username: 'ext', password: 'secret', deviceId: 'dev1', client: 'airdcpp-season-gaps', version: '1.0.0', ...creds }),
    loadToken: () => saved.token,
    saveToken: (t) => { saved.token = t; },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return handler(url, options, calls.length);
    },
  });
  return { client, calls, saved };
};

test('jellyfin: signs in once, sends the token in X-Emby-Token, never follows redirects', async () => {
  const { client, calls, saved } = jellyfinWith((url) => {
    if (url.endsWith('/Users/AuthenticateByName')) return response(200, { AccessToken: 'tok1' });
    return response(200, { Items: [], TotalRecordCount: 0 });
  });
  await client.get('/Items', { Recursive: 'true', IncludeItemTypes: 'Series' });
  await client.get('/Items');
  assert.equal(calls.length, 3);
  assert.equal(JSON.parse(calls[0].options.body).Username, 'ext');
  assert.match(calls[0].options.headers.Authorization, /^MediaBrowser Client="airdcpp-season-gaps", Device="FulDC\+\+ extension", DeviceId="dev1", Version="1.0.0"$/);
  assert.equal(calls[1].options.headers['X-Emby-Token'], 'tok1');
  assert.equal(calls[1].url, 'http://127.0.0.1:8096/Items?Recursive=true&IncludeItemTypes=Series');
  assert.ok(calls.every((c) => c.options.redirect === 'error'));
  assert.equal(saved.token, 'tok1');
});

test('jellyfin: a stale token gets exactly one fresh sign-in, then the request is repeated', async () => {
  const { client, calls, saved } = jellyfinWith((url, options) => {
    if (url.endsWith('/Users/AuthenticateByName')) return response(200, { AccessToken: 'new' });
    return options.headers['X-Emby-Token'] === 'new' ? response(200, { ok: 1 }) : response(401, {});
  });
  saved.token = 'old';
  assert.deepEqual(await client.get('/Users/Me'), { ok: 1 });
  assert.deepEqual(calls.map((c) => c.url.replace('http://127.0.0.1:8096', '')), [ '/Users/Me', '/Users/AuthenticateByName', '/Users/Me' ]);
});

test('jellyfin: a refused sign-in is not retried at once (the server throttles failures)', async () => {
  const { client, calls } = jellyfinWith(() => response(401, {}));
  await assert.rejects(client.get('/Users/Me'), (e) => e.status === 401);
  await assert.rejects(client.get('/Users/Me'), /refused the sign-in recently/);
  assert.equal(calls.length, 1, 'the second request did not sign in again');
});

test('jellyfin: a pasted token is kept on 401 without credentials; errors carry no secrets', async () => {
  const { client, calls, saved } = jellyfinWith(() => response(401, {}), { username: '', token: 'pasted' });
  await assert.rejects(client.get('/Users/Me'), (e) => e.status === 401 && !/pasted/.test(e.message));
  assert.equal(calls.length, 1);
  assert.equal(saved.token, null);

  const down = jellyfinWith(() => { const e = new Error('connect ECONNREFUSED 127.0.0.1:8096 token=secret'); e.cause = { code: 'ECONNREFUSED' }; throw e; });
  await assert.rejects(down.client.get('/Users/Me'), (e) => e.status === 0 && !/secret/.test(e.message) && /refused the connection/.test(e.message));
});

const tmdbWith = (handler, extra = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaps-tmdb-'));
  const calls = [];
  const clock = { value: Date.UTC(2026, 9, 18) };
  const slept = [];
  const client = createTmdb({
    getKey: () => 'v3key123',
    getLanguage: () => 'en-US',
    cacheDir: dir,
    now: () => clock.value,
    sleep: async (ms) => { slept.push(ms); clock.value += ms; },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return handler(url, options, calls.length);
    },
    ...extra,
  });
  return { client, calls, dir, clock, slept };
};

test('tmdb: cached on disk, 1 day for a running show and 7 for an ended one', async () => {
  const t = tmdbWith((url) => response(200, url.includes('/tv/1?') ? { id: 1, status: 'Returning Series' } : { id: 2, status: 'Ended' }));
  await t.client.getShow(1);
  await t.client.getShow(2);
  t.clock.value += 2 * 24 * 60 * 60 * 1000;
  await t.client.getShow(1);
  await t.client.getShow(2);
  assert.equal(t.calls.length, 3, 'the running show was asked again, the ended one was not');
  assert.ok(t.calls[0].url.includes('api_key=v3key123') && t.calls[0].url.includes('language=en-US'));
  assert.equal(t.calls[0].options.redirect, 'error');
});

test('tmdb: spacing between requests, 429 waits and retries once, 401 and 404 are told apart', async () => {
  let n = 0;
  const t = tmdbWith(() => {
    n++;
    if (n === 2) return response(429, {}, { 'retry-after': '3' });
    if (n === 4) return response(401, { status_message: 'Invalid API key: v3key123' });
    if (n === 5) return response(404, {});
    return response(200, { episodes: [] });
  });
  await t.client.getSeason(5, 1, false);
  await t.client.getSeason(5, 2, false);
  assert.ok(t.slept.includes(3000), 'Retry-After honoured');
  assert.ok(t.slept.some((ms) => ms > 0 && ms <= 250), 'requests are spaced');
  await assert.rejects(t.client.getSeason(5, 3, false), (e) => e.status === 401 && e.fromTmdb && !/v3key123/.test(e.message));
  await assert.rejects(t.client.getSeason(5, 4, false), (e) => e.status === 404);
  await assert.rejects(t.client.getSeason(5, 4, false), (e) => e.status === 404);
  assert.equal(t.calls.length, 5, 'a 404 is remembered');
  assert.throws(() => t.client.getShow('../etc'), /not a TMDB id/);
});

test('tmdb: a v4 token goes in the Authorization header, not the URL; stale cache beats a network error', async () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abc_DEF-123';
  assert.ok(isBearer(jwt));
  let fail = false;
  const t = tmdbWith(() => {
    if (fail) throw new Error('getaddrinfo ENOTFOUND api.themoviedb.org');
    return response(200, { id: 9, status: 'Returning Series' });
  }, { getKey: () => jwt });
  await t.client.getShow(9);
  assert.equal(t.calls[0].options.headers.Authorization, `Bearer ${jwt}`);
  assert.ok(!t.calls[0].url.includes(jwt));
  fail = true;
  t.clock.value += 3 * 24 * 60 * 60 * 1000;
  assert.deepEqual(await t.client.getShow(9), { id: 9, status: 'Returning Series' });
});

test('tmdb: prune removes only old cache files of its own', async () => {
  const t = tmdbWith(() => response(200, {}));
  fs.writeFileSync(path.join(t.dir, 'tv-1.json'), '{}');
  fs.writeFileSync(path.join(t.dir, 'mine.txt'), 'x');
  t.clock.value += 40 * 24 * 60 * 60 * 1000;
  assert.equal(t.client.prune(), 1);
  assert.ok(fs.existsSync(path.join(t.dir, 'mine.txt')));
});

test('tmdb: a network error names no URL and no key', async () => {
  const t = tmdbWith(() => { throw new Error('request to https://api.themoviedb.org/3/tv/1?api_key=v3key123 failed'); });
  await assert.rejects(t.client.getShow(1), (e) => e.status === 0 && e.message === 'could not reach TMDB');
});
