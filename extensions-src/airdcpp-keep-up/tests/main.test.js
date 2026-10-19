'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SettingDefinitions } = require('../src/settings');

const settingsPath = require.resolve('airdcpp-extension-settings');
let settingValues;
let settingsUpdated = null;
let loadFiresUpdate = false;
require.cache[settingsPath] = {
  id: settingsPath, filename: settingsPath, loaded: true,
  // loadFiresUpdate: like the real airdcpp-extension-settings, load() ends with onValuesUpdated(all values)
  exports: () => ({ load: async () => { if (loadFiresUpdate && settingsUpdated) settingsUpdated({ ...settingValues }); }, getValue: (key) => settingValues[key], set onValuesUpdated(cb) { settingsUpdated = cb; } }),
};

const createMain = require('../src/main.js');

const NOW = Date.parse('2026-10-18T12:00:00Z');
const BASE = 'http://127.0.0.1:8096';
const respond = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });

const ep = (s, e, played, at) => ({
  Type: 'Episode', Id: `e${s}${e}`, SeriesId: 'show1', SeriesName: 'The Show', SeasonId: `season${s}`, ParentIndexNumber: s, IndexNumber: e,
  UserData: { Played: played, LastPlayedDate: at || null },
});

// The world the extension sees: a media server, TMDB and the hubs
const makeWorld = (overrides = {}) => ({
  lastPlayed: '2026-10-17T20:00:00Z',
  held: [ [ 1, 1, true ], [ 1, 2, true ], [ 1, 3, false ] ],
  tmdbEpisodes: { 1: [ [ 1, '2026-09-01' ], [ 2, '2026-09-08' ], [ 3, '2026-09-15' ], [ 4, '2026-10-01' ], [ 5, '2026-10-10' ] ], 2: [ [ 1, '2027-01-01' ] ] },
  providerTmdb: '42',
  missingRows: [],
  bundles: [],
  directoryDownloads: [],
  results: (pattern) => {
    const tag = /S\d\dE\d\d/.exec(pattern)[0];
    return [
      { id: `RES${tag}A`, name: `Another.Show.${tag}.1080p-AAA`, size: 1e9, type: { id: 'directory' }, dupe: null, users: { count: 90 }, slots: { free: 9 } },
      { id: `RES${tag}B`, name: `The.Show.${tag}.1080p.WEB-GRP`, size: 2e9, type: { id: 'directory' }, dupe: null, users: { count: 5 }, slots: { free: 1 } },
    ];
  },
  ...overrides,
});

const makeClient = (dir, world, clock) => {
  const listeners = {};
  const posts = [];
  const events = [];
  const deletes = [];
  const sleeps = [];
  const fetches = [];
  const errors = [];
  let nextInstance = 1;
  let nextDirectoryDownload = 1;
  const patterns = new Map();

  const socket = {
    logger: { verbose: (m) => process.env.KDBG && console.log("V", m), info: (m) => process.env.KDBG && console.log("I", m), error: (m) => { errors.push(m); if (process.env.KDBG) console.log("E", m); } },
    addListener: async (module, event, cb) => { listeners[event] = cb; },
    get: async (url) => {
      if (url === 'media_server') return { enabled: true, running: true, address: 'http://0.0.0.0:8096', port: 8096 };
      if (url.startsWith('queue/bundles/')) return world.bundles;
      if (url === 'filelists/directory_downloads') return world.directoryDownloads;
      const results = /^search\/(\d+)\/results\/0\/200$/.exec(url);
      if (results) return world.results(patterns.get(Number(results[1])));
      throw new Error(`unexpected GET ${url}`);
    },
    post: async (url, body) => {
      posts.push([ url, body ]);
      if (url === 'events') { events.push(body.text); return; }
      if (url === 'settings/get') return { download_directory: world.downloadDir || '' };
      if (url === 'search') return { id: nextInstance++ };
      const hub = /^search\/(\d+)\/hub_search$/.exec(url);
      if (hub) {
        if (world.hubSearchFails) throw Object.assign(new Error('No hubs'), { code: 400 });
        patterns.set(Number(hub[1]), body.query.pattern);
        return { queue_time: 0, search_id: 'x', sent: 1 };
      }

      if (/\/download$/.test(url)) return world.downloadAnswer ? world.downloadAnswer(url) : { directory_download_ids: [ { id: nextDirectoryDownload++, state: 'pending' } ] };
      return {};
    },
    delete: async (url) => { deletes.push(url); },
  };

  const fetchImpl = async (url, options) => {
    fetches.push(url);
    const u = new URL(url);
    if (u.origin === BASE) {
      const p = u.pathname;
      if (p === '/Users/AuthenticateByName') return respond(200, { AccessToken: 'tok', User: { Id: 'u1' } });
      if (options.headers['X-Emby-Token'] !== 'tok') return respond(401);
      if (p === '/UserViews') return respond(200, { Items: [ { Id: 'tv', CollectionType: 'tvshows' }, { Id: 'mov', CollectionType: 'movies' } ] });
      if (p === '/Users/u1/Items') {
        assert.equal(u.searchParams.get('Filters'), 'IsPlayed');
        assert.equal(u.searchParams.get('ParentId'), 'tv');
        return respond(200, { Items: world.held.filter((h) => h[2]).map((h) => ({ ...ep(h[0], h[1], true, world.lastPlayed), SeriesName: world.seriesName || 'The Show' })) });
      }

      if (p === '/Users/u1/Items/show1') return respond(200, { Id: 'show1', Name: world.seriesName || 'The Show', ProductionYear: 2019, ProviderIds: world.providerTmdb ? { Tmdb: world.providerTmdb } : {} });
      if (p === '/Shows/show1/Episodes') {
        const held = world.held.map((h) => ep(h[0], h[1], h[2], h[2] ? world.lastPlayed : null));
        if (u.searchParams.get('SeasonId')) return respond(200, { Items: held.filter((e) => e.SeasonId === u.searchParams.get('SeasonId')).concat(world.missingRows) });
        return respond(200, { Items: held });
      }

      return respond(404);
    }

    if (u.hostname === 'api.themoviedb.org') {
      if (u.pathname === '/3/tv/42') return respond(200, { id: 42, name: 'The Show', first_air_date: '2019-01-01', seasons: Object.keys(world.tmdbEpisodes).map((n) => ({ season_number: Number(n), episode_count: 9 })) });
      const season = /\/season\/(\d+)$/.exec(u.pathname);
      if (season) return respond(200, { episodes: world.tmdbEpisodes[season[1]].map(([ e, d ]) => ({ episode_number: e, air_date: d })) });
      return respond(404);
    }

    throw new Error(`unexpected fetch ${url}`);
  };

  const ext = { name: 'airdcpp-keep-up', configPath: dir + path.sep };
  const main = createMain(socket, ext, {
    fetchImpl,
    now: () => clock.value,
    sleep: async (ms) => { sleeps.push(ms); clock.value += ms; },
    ...(world.resultWaitMs !== undefined ? { resultWaitMs: world.resultWaitMs } : {}),
  });
  const searches = () => posts.filter((p) => /hub_search$/.test(p[0])).map((p) => p[1].query.pattern);
  const downloads = () => posts.filter((p) => /\/download$/.test(p[0]));
  return { socket, ext, main, posts, events, deletes, sleeps, fetches, errors, searches, downloads, emit: (event, data, id) => (listeners[event] ? listeners[event](data, id) : undefined) };
};

const setup = (settings = {}, world = {}) => {
  settingValues = SettingDefinitions.reduce((r, d) => ({ ...r, [d.key]: d.default_value }), {});
  Object.assign(settingValues, { media_username: 'ann', media_password: 'pw', tmdb_api_key: 'k' }, settings);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keepup-'));
  const clock = { value: NOW };
  const w = makeWorld(world);
  const client = makeClient(dir, w, clock);
  return { dir, clock, world: w, ...client, restart: () => makeClient(dir, w, clock) };
};

const start = async (t) => {
  await t.ext.onStart();
  // The timers are unref()ed and far away; runs are driven by the test
  return t;
};

test('dry run (the default): searches the next aired, missing episodes and only logs what it would queue', async () => {
  const t = await start(setup());
  const summary = await t.main.runOnce();
  // E3 is held; E4 and E5 have aired; S02E01 has not
  assert.deepEqual(t.searches(), [ 'the.show.S01E04 1080p', 'the.show.S01E05 1080p' ]);
  assert.equal(t.downloads().length, 0);
  assert.equal(summary.wouldQueue, 2);
  assert.ok(t.events.some((e) => e.includes('dry run: would queue The.Show.S01E04.1080p.WEB-GRP')));
  assert.ok(!t.events.some((e) => e.includes('Another.Show')));
  // Every search instance is removed again
  assert.deepEqual(t.deletes, [ 'search/1', 'search/2' ]);
  // Not again for a day
  await t.main.runOnce();
  assert.equal(t.searches().length, 2);
});

test('searches are at least 20 s apart and the hourly budget holds across a restart', async () => {
  const t = await start(setup({ searches_per_hour: 1 }));
  const first = await t.main.runOnce();
  assert.equal(t.searches().length, 1);
  assert.match(first.skipped, /budget/);

  const t2 = t.restart();
  await start(t2);
  await t2.main.runOnce();
  assert.equal(t2.searches().length, 0, 'the persisted budget is still used up');

  // With results arriving at once, the spacing alone keeps the searches apart
  const t3 = await start(setup({}, { resultWaitMs: 0 }));
  await t3.main.runOnce();
  assert.deepEqual(t3.sleeps, [ 0, 20 * 1000, 0 ]);
  const state = t3.main.getState();
  assert.equal(state.searches[1] - state.searches[0], 20 * 1000);
});

test('dry run off: queues only the strictly matching release, writes it to disk at once, never queues it again', async () => {
  const t = await start(setup({ dry_run: false }));
  await t.main.runOnce();
  assert.deepEqual(t.downloads().map((d) => d[0]), [ 'search/1/results/RESS01E04B/download', 'search/2/results/RESS01E05B/download' ]);
  assert.deepEqual(t.downloads()[0][1], { target_name: 'The.Show.S01E04.1080p.WEB-GRP' });
  assert.ok(t.events.some((e) => e.includes('queued The.Show.S01E04.1080p.WEB-GRP')));

  // Killed now (no onStop): the file already says so
  const onDisk = JSON.parse(fs.readFileSync(path.join(t.dir, 'keep-up-state.json'), 'utf8'));
  assert.equal(onDisk.episodes['show1:S01E04'].status, 'queued');
  assert.equal(JSON.stringify(onDisk).includes('"pw"'), false, 'no password in the state file');

  // The user removed the downloads from the queue: they are not fetched again
  t.clock.value += 2 * 24 * 60 * 60 * 1000;
  t.world.lastPlayed = new Date(t.clock.value - 3600e3).toISOString();
  const t2 = t.restart();
  await start(t2);
  await t2.main.runOnce();
  assert.equal(t2.searches().length, 0);
});

test('only non-matching results: nothing is queued and the episode backs off', async () => {
  const t = await start(setup({ dry_run: false }, {
    results: (pattern) => [ { id: 'X', name: 'The.Show.S01E04E05.1080p-GRP', size: 1e9, type: { id: 'directory' }, dupe: null, users: { count: 99 }, slots: { free: 9 } },
      { id: 'Y', name: 'The.Show.Aftershow.S01E04.1080p-GRP', size: 1e9, type: { id: 'directory' }, dupe: null, users: { count: 99 }, slots: { free: 9 } } ],
  }));
  const summary = await t.main.runOnce();
  assert.equal(t.downloads().length, 0);
  assert.equal(summary.notFound, 2);
  const record = t.main.getState().episodes['show1:S01E04'];
  assert.equal(record.attempts, 1);
  t.clock.value += 30 * 60 * 1000;
  await t.main.runOnce();
  assert.equal(t.searches().length, 2, 'not before the backoff');
  t.clock.value += 31 * 60 * 1000;
  await t.main.runOnce();
  assert.equal(t.searches().length, 4);
  assert.equal(t.main.getState().episodes['show1:S01E04'].attempts, 2);
});

test('a show not watched within the window is left alone', async () => {
  const t = await start(setup({}, { lastPlayed: '2026-09-01T20:00:00Z' }));
  const summary = await t.main.runOnce();
  assert.equal(t.searches().length, 0);
  assert.match(summary.skipped, /nothing watched/);
});

test('an episode already in the queue (or its season pack) is not searched', async () => {
  const t = await start(setup({}, { bundles: [ { id: 1, name: 'The.Show.S01E04.720p.HDTV-OTHER', size: 1e9, status: { completed: false } }, { id: 2, name: 'The.Show.S01.1080p-PACK', size: 1e9, status: { completed: true } } ] }));
  await t.main.runOnce();
  assert.deepEqual(t.searches(), []);
});

test('queue caps: count and total size of its own downloads', async () => {
  const count = await start(setup({ dry_run: false, max_active_bundles: 1 }));
  await count.main.runOnce();
  assert.equal(count.downloads().length, 1, 'the second waits for the cap');

  const size = await start(setup({ dry_run: false, max_total_size_gb: 3 }));
  await size.main.runOnce();
  assert.equal(size.downloads().length, 1, '2 GB + 2 GB > 3 GB');
  assert.equal(size.main.getState().episodes['show1:S01E05'].status, 'waiting_size');
});

test('a release whose folder already exists in the download folder is never queued into it', async () => {
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keepup-dl-'));
  fs.mkdirSync(path.join(downloadDir, 'The.Show.S01E04.1080p.WEB-GRP'));
  const t = await start(setup({ dry_run: false }, { downloadDir }));
  await t.main.runOnce();
  assert.deepEqual(t.downloads().map((d) => d[1].target_name), [ 'The.Show.S01E05.1080p.WEB-GRP' ]);
  assert.ok(t.events.some((e) => e.includes('already exists')));
});

test('a search that could not be sent stops the check without blaming the episode', async () => {
  const t = await start(setup({}, { hubSearchFails: true }));
  const summary = await t.main.runOnce();
  assert.match(summary.skipped, /search failed/);
  assert.equal(t.main.getState().episodes['show1:S01E04'], undefined);
  assert.deepEqual(t.deletes, [ 'search/1' ]);
  assert.equal(t.main.getState().searches.length, 0, 'not counted against the budget');
});

test('without a TMDB key the server own missing rows are used', async () => {
  const missing = [
    { Type: 'Episode', LocationType: 'Virtual', ParentIndexNumber: 1, IndexNumber: 4, PremiereDate: '2026-10-01T00:00:00.0000000Z' },
    { Type: 'Episode', LocationType: 'Virtual', ParentIndexNumber: 1, IndexNumber: 5, PremiereDate: '2026-11-01T00:00:00.0000000Z' },
  ];
  const t = await start(setup({ tmdb_api_key: '' }, { missingRows: missing }));
  await t.main.runOnce();
  assert.deepEqual(t.searches(), [ 'the.show.S01E04 1080p' ], 'E5 has not aired');
  assert.ok(!t.fetches.some((u) => u.includes('themoviedb')));
});

test('leaving dry run makes the named episodes due again', async () => {
  const t = await start(setup());
  await t.main.runOnce();
  settingValues.dry_run = false;
  settingsUpdated({ dry_run: false });
  await t.main.runOnce();
  assert.equal(t.downloads().length, 2);
});

test('/keepup status and /keepup run answer as status lines in the asking session', async () => {
  const t = await start(setup());
  await t.emit('hub_text_command', { command: 'keepup', args: [ 'run' ], owner: 'o1' }, 7);
  await t.main.runOnce();
  await t.emit('private_chat_text_command', { command: 'keepup', args: [ 'status' ] }, 'CID');
  const lines = t.posts.filter((p) => p[0].endsWith('/status_message'));
  assert.equal(lines[0][0], 'hubs/7/status_message');
  assert.equal(lines[0][1].owner, 'o1');
  const status = lines.filter((l) => l[0] === 'private_chat/CID/status_message').map((l) => l[1].text);
  assert.ok(status.every((s) => s.startsWith('[keep-up] ')));
  assert.match(status.join('\n'), /dry run is ON/);
  assert.match(status.join('\n'), /following: The Show/);
  assert.match(status.join('\n'), /searches in the last hour: 2 of 20/);
});

test('no account set: no request at all, and a hint in the event log', async () => {
  const t = await start(setup({ media_username: '', media_password: '' }));
  const summary = await t.main.runOnce();
  assert.equal(t.fetches.length, 0);
  assert.match(summary.skipped, /no media-server account/);
  assert.ok(t.events.some((e) => e.includes('set a media-server user name')));
});

test('a broken state file is replaced, not fatal', async () => {
  const t = setup();
  fs.writeFileSync(path.join(t.dir, 'keep-up-state.json'), '{not json');
  await start(t);
  await t.main.runOnce();
  assert.equal(t.searches().length, 2);
});

test('a show numbered differently from TMDB (the last watched is not in TMDB) is left alone', async () => {
  // Without the guard, TMDB's "next" after S01E25 would be its aired S02E01: the library's S01E26
  const t = await start(setup({}, { held: [ [ 1, 24, true ], [ 1, 25, true ] ], tmdbEpisodes: { 1: [ [ 1, '2026-09-01' ], [ 2, '2026-09-08' ] ], 2: [ [ 1, '2026-10-01' ], [ 2, '2026-10-08' ] ] } }));
  await t.main.runOnce();
  assert.deepEqual(t.searches(), []);
});

test('a show name that leaves no searchable word is never searched as a bare SxxEyy', async () => {
  // With TMDB: searched by its TMDB name
  const withKey = await start(setup({}, { seriesName: '進撃の巨人' }));
  await withKey.main.runOnce();
  assert.deepEqual(withKey.searches(), [ 'the.show.S01E04 1080p', 'the.show.S01E05 1080p' ]);
  // Without: no name to search by, so no search at all
  const missing = [ { Type: 'Episode', LocationType: 'Virtual', ParentIndexNumber: 1, IndexNumber: 4, PremiereDate: '2026-10-01T00:00:00.0000000Z' } ];
  const t = await start(setup({ tmdb_api_key: '' }, { seriesName: '進撃の巨人', missingRows: missing }));
  await t.main.runOnce();
  assert.deepEqual(t.searches(), []);
  assert.equal(t.main.getState().searches.length, 0);
  assert.equal(t.main.getState().episodes['show1:S01E04'].status, 'unsearchable');
});

test('a second /keepup run while a check is running starts nothing new', async () => {
  const t = await start(setup());
  const first = t.main.runOnce();
  const second = t.main.runOnce();
  assert.equal(first, second);
  await first;
  assert.equal(t.searches().length, 2);
});

test('queue caps count a directory download that is not a bundle yet', async () => {
  const t = await start(setup({ dry_run: false, max_active_bundles: 1 }));
  await t.main.runOnce();
  assert.equal(t.downloads().length, 1);
  // The source's file list has not arrived: no bundle, the directory download still pending
  t.world.directoryDownloads.push({ id: 1, state: 'pending', queue_info: null });
  t.clock.value += 2 * 3600e3;
  await t.main.runOnce();
  assert.equal(t.downloads().length, 1, 'the pending one counts against the cap');
  // Its bundle arrives under another name (the processed event names its id): still counted
  await t.emit('filelist_directory_download_processed', { directory_download: { id: 1, state: 'queued' }, result: { bundle: { id: 501 } } });
  t.world.directoryDownloads.length = 0;
  t.world.bundles.push({ id: 501, name: 'Something else', size: 2e9, status: { completed: false } });
  t.clock.value += 2 * 3600e3;
  await t.main.runOnce();
  assert.equal(t.downloads().length, 1);
  // Finished: the next one may go
  t.world.bundles[0].status.completed = true;
  t.clock.value += 2 * 3600e3;
  await t.main.runOnce();
  assert.equal(t.downloads().length, 2);
});

test('queue caps count a file bundle by its id after the user renamed it', async () => {
  const fileResults = (pattern) => {
    const tag = /S\d\dE\d\d/.exec(pattern)[0];
    return [ { id: `F${tag}`, name: `The.Show.${tag}.1080p.WEB-GRP.mkv`, size: 2e9, type: { id: 'file' }, dupe: null, users: { count: 5 }, slots: { free: 1 } } ];
  };
  const t = await start(setup({ dry_run: false, max_active_bundles: 1 }, { results: fileResults, downloadAnswer: () => ({ bundle_info: { id: 77, merged: false } }) }));
  await t.main.runOnce();
  assert.equal(t.downloads().length, 1);
  t.world.bundles.push({ id: 77, name: 'renamed by the user.mkv', size: 2e9, status: { completed: false } });
  t.clock.value += 2 * 3600e3;
  await t.main.runOnce();
  assert.equal(t.downloads().length, 1, 'still its download, whatever it is called now');
});

test('a directory download that fails before it is a bundle is searched again later', async () => {
  const t = await start(setup({ dry_run: false, max_active_bundles: 1 }));
  await t.main.runOnce();
  assert.equal(t.downloads().length, 1);
  await t.emit('filelist_directory_download_failed', { directory_download: { id: 1, state: 'failed' }, error: 'User went offline' });
  assert.notEqual(t.main.getState().episodes['show1:S01E04'].status, 'queued');
  t.clock.value += 2 * 3600e3;
  await t.main.runOnce();
  assert.deepEqual(t.downloads().map((d) => d[1].target_name), [ 'The.Show.S01E04.1080p.WEB-GRP', 'The.Show.S01E04.1080p.WEB-GRP' ]);
});

test('the dry run keeps to the queue caps, as the real run would', async () => {
  const t = await start(setup({ max_active_bundles: 1 }));
  const summary = await t.main.runOnce();
  assert.equal(summary.wouldQueue, 1);
  assert.equal(t.searches().length, 1);
  assert.equal(t.downloads().length, 0);
  const size = await start(setup({ max_total_size_gb: 3 }));
  const s2 = await size.main.runOnce();
  assert.equal(s2.wouldQueue, 1, '2 GB + 2 GB > 3 GB');
  assert.equal(size.downloads().length, 0);
});

test('the library and TMDB years both reach the match: a release of another year is not taken', async () => {
  const t = await start(setup({ dry_run: false }, {
    results: (pattern) => {
      const tag = /S\d\dE\d\d/.exec(pattern)[0];
      return [ { id: `Y${tag}`, name: `The.Show.2024.${tag}.1080p.WEB-GRP`, size: 2e9, type: { id: 'directory' }, dupe: null, users: { count: 9 }, slots: { free: 1 } } ];
    },
  }));
  await t.main.runOnce();
  assert.equal(t.downloads().length, 0, 'the show is from 2019');
});

test('live test: without a TMDB key, a show the media server has not identified is named, not passed over silently', async () => {
  // Live rig 2026-10-19: media server metadata off -> no ProviderIds.Tmdb and no missing rows; the
  // status said "0 queued, 0 would be queued, 0 not found", which reads as "nothing to fetch"
  const t = await start(setup({ tmdb_api_key: '' }, { providerTmdb: null, missingRows: [] }));
  const run = await t.main.runOnce();
  assert.deepEqual(run.unknown, [ 'The Show' ]);
  assert.equal(t.searches().length, 0);
  await t.emit('hub_text_command', { command: 'keepup', args: [ 'status' ] }, 7);
  const status = t.posts.filter((p) => p[0] === 'hubs/7/status_message').map((p) => p[1].text).join('\n');
  assert.match(status, /next episodes unknown for: The Show/);

  // Identified by the server (it has the TMDB id) but nothing missing: nothing to say
  const t2 = await start(setup({ tmdb_api_key: '' }, { missingRows: [] }));
  const run2 = await t2.main.runOnce();
  assert.deepEqual(run2.unknown || [], []);
});

test('live test: the settings load at start is not taken for a change (no error, the sign-in is kept)', async () => {
  // Live rig 2026-10-19: error.log "Settings update failed: Cannot set properties of null (setting 'token')"
  // at every start: the settings library calls onValuesUpdated with every value at the end of load(),
  // before the state was loaded. Handled as a change, it would also drop the stored sign-in each start.
  loadFiresUpdate = true;
  try {
    const t = await start(setup());
    assert.deepEqual(t.errors, []);
    await t.main.runOnce();
    assert.equal(t.fetches.filter((u) => u.endsWith('/Users/AuthenticateByName')).length, 1);
    const again = t.restart();
    await again.ext.onStart();
    assert.deepEqual(again.errors, []);
    await again.main.runOnce();
    assert.equal(again.fetches.filter((u) => u.endsWith('/Users/AuthenticateByName')).length, 0, 'the stored token is reused');

    // A real change afterwards still drops it
    settingValues.media_password = 'other';
    settingsUpdated({ media_password: 'other' });
    assert.equal(again.main.getState().token, null);
  } finally {
    loadFiresUpdate = false;
  }
});
