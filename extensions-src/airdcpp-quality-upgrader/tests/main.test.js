'use strict';

// main.js against a fake client and real temporary folders.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SettingDefinitions } = require('../src/settings');
const { moveInto } = require('../src/mover');

const settingsPath = require.resolve('airdcpp-extension-settings');
let settingValues;
require.cache[settingsPath] = {
  id: settingsPath, filename: settingsPath, loaded: true,
  // Like airdcpp-extension-settings 1.2.2: load() ends by calling the onValuesUpdated handler with
  // EVERY value (settings-manager.js, end of load)
  exports: () => {
    let onValues = null;
    return {
      load: async () => { if (onValues) onValues({ ...settingValues }); },
      getValue: (key) => settingValues[key],
      set onValuesUpdated(cb) { onValues = cb; },
    };
  },
};

const createMain = require('../src/main.js');

const HOUR = 3600 * 1000;

const mkRelease = (dir, name, file = 'video.mkv', size = 10) => {
  const folder = path.join(dir, name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, file), 'v'.repeat(size));
  fs.writeFileSync(path.join(folder, 'info.nfo'), 'n');
  return folder;
};

const setup = (overrides = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrader-main-'));
  const share = path.join(root, 'Share');
  const config = path.join(root, 'config');
  fs.mkdirSync(share);
  fs.mkdirSync(config);
  settingValues = SettingDefinitions.reduce((r, d) => ({ ...r, [d.key]: d.default_value }), {});
  Object.assign(settingValues, overrides);

  const calls = [];
  const events = [];
  const replies = [];
  const deleted = [];
  const bundles = new Map();
  let searchResults = [];
  let instance = 100;
  const socket = {
    logger: { verbose() {}, info() {}, error() {} },
    get: async (url) => {
      calls.push([ 'GET', url ]);
      if (url === 'share_roots') return [ { path: share + path.sep } ];
      if (url === 'media_server') return { enabled: true, running: true, address: 'http://0.0.0.0:8096', port: 8096 };
      if (/^search\/\d+\/results\//.test(url)) return searchResults;
      if (url === 'queue/bundles/0/100000') return [ ...bundles.values() ];
      const m = /^queue\/bundles\/(\w+)$/.exec(url);
      if (m) {
        if (!bundles.has(m[1])) throw Object.assign(new Error('Bundle not found'), { code: 404 });
        return bundles.get(m[1]);
      }

      throw Object.assign(new Error(`unexpected GET ${url}`), { code: 500 });
    },
    post: async (url, body) => {
      if (url === 'events') { events.push(body); return; }
      if (/status_message$/.test(url)) { replies.push(body.text); return; }
      calls.push([ 'POST', url, body ]);
      if (url === 'search') return { id: ++instance };
      if (/hub_search$/.test(url)) return { queue_time: 0, queued_count: 2 };
      if (url === 'hash/rename_path') {
        assert.ok(fs.existsSync(body.new_path), `rename_path before the move: ${body.new_path}`);
        return;
      }

      if (/\/download$/.test(url)) return { directory_download_ids: [ 1 ] };
      if (/^queue\/bundles\/\w+\/remove$/.test(url)) {
        bundles.delete(url.split('/')[2]);
      }
    },
    delete: async (url) => { deleted.push(url); },
    addListener: async () => () => {},
  };

  const ext = { name: 'airdcpp-quality-upgrader', configPath: config + path.sep, onStart: null, onStop: null };
  const make = (deps = {}) => createMain(socket, ext, { sleep: async () => {}, settleMs: 0, ...deps });
  return {
    root, share, config, socket, calls, events, replies, deleted, bundles, ext, make,
    setResults: (r) => { searchResults = r; },
  };
};

const dirResult = (name, extra = {}) => ({ id: `ID${name.length}${name.slice(-6)}`, name, type: { id: 'directory' }, dupe: null, hits: 3, ...extra });

const urls = (t, method) => t.calls.filter((c) => c[0] === method).map((c) => c[1]);

test('report only: finds the strict upgrade, ignores the rest, never downloads, removes its search', async () => {
  const t = setup();
  mkRelease(path.join(t.share, 'TV'), 'The.Show.S01E02.720p.HDTV.x264-GRP');
  const main = t.make();
  await main.init();
  await main.refreshInventory();
  assert.equal(main.getInventory().size, 1);

  t.setResults([
    dirResult('The.Show.S01E03.1080p.WEB.h264-TOP', { hits: 99 }), // first, most hits, wrong episode
    dirResult('The.Show.S01E02.2160p.WEB.h265-UHD'), // above the maximum
    dirResult('The.Show.S01E02.1080p.WEB.h264-NEW'),
    dirResult('The.Show.S01E02.1080p.WEB.h264-HAVE', { dupe: { id: 'share_full' } }),
  ]);
  assert.equal(await main.searchOnce(), true);

  const hub = t.calls.find((c) => /hub_search$/.test(c[1]));
  assert.deepEqual(hub[2], { query: { pattern: 'the show S01E02', file_type: 'directory' } });
  const found = Object.values(main.getState().found);
  assert.equal(found.length, 1);
  assert.equal(found[0].candidate, 'The.Show.S01E02.1080p.WEB.h264-NEW');
  assert.equal(found[0].reason, '720p -> 1080p');
  assert.equal(urls(t, 'POST').filter((u) => /download$/.test(u)).length, 0);
  assert.deepEqual(t.deleted, [ 'search/101' ]);
  assert.match(t.events.at(-1).text, /^airdcpp-quality-upgrader: upgrade found for The\.Show\.S01E02\.720p\.HDTV\.x264-GRP: The\.Show\.S01E02\.1080p\.WEB\.h264-NEW/);

  main.writeReport();
  const report = fs.readFileSync(path.join(t.config, 'upgrades.md'), 'utf8');
  assert.match(report, /\| The\.Show\.S01E02\.720p\.HDTV\.x264-GRP \| The\.Show\.S01E02\.1080p\.WEB\.h264-NEW \| 720p -> 1080p \| found \(report only\)/);
});

test('no matching result: nothing is reported (no fallback to the top result)', async () => {
  const t = setup();
  mkRelease(t.share, 'Some.Movie.2019.720p.BluRay.x264-GRP');
  const main = t.make();
  await main.init();
  await main.refreshInventory();
  t.setResults([ dirResult('Some.Movie.2020.1080p.BluRay.x264-TOP', { hits: 99 }), dirResult('Some.Movie.Returns.2019.1080p.BluRay.x264-X') ]);
  await main.searchOnce();
  assert.deepEqual(main.getState().found, {});
});

test('the global budget: spacing, searches per hour, persisted rotation', async () => {
  const t = setup({ searches_per_hour: 3, search_spacing_seconds: 20 });
  for (let i = 1; i <= 5; i++) mkRelease(t.share, `The.Show.S01E0${i}.720p.HDTV.x264-GRP`);
  let clock = 1_000_000_000_000;
  const main = t.make({ now: () => clock });
  await main.init();
  await main.refreshInventory();
  t.setResults([]);

  assert.equal(await main.searchOnce(), true);
  assert.equal(await main.searchOnce(), false); // spacing
  clock += 20000;
  assert.equal(await main.searchOnce(), true);
  clock += 20000;
  assert.equal(await main.searchOnce(), true);
  clock += 20000;
  assert.equal(await main.searchOnce(), false); // 3 per hour used
  assert.equal(urls(t, 'POST').filter((u) => u === 'search').length, 3);

  // A restart keeps the budget and the rotation: the next one is a title not checked yet
  const again = t.make({ now: () => clock });
  await again.init();
  await again.refreshInventory();
  assert.equal(await again.searchOnce(), false);
  clock += HOUR;
  assert.equal(await again.searchOnce(), true);
  const patterns = t.calls.filter((c) => /hub_search$/.test(c[1])).map((c) => c[2].query.pattern);
  assert.equal(new Set(patterns).size, 4);
});

test('personal folders and non-release names are not in the inventory', async () => {
  const t = setup();
  mkRelease(t.share, 'Holiday 2019 1080p');
  mkRelease(t.share, 'Some Movie 2019');
  mkRelease(t.share, 'Music-Album-2019-GRP');
  const main = t.make();
  await main.init();
  await main.refreshInventory();
  assert.equal(main.getInventory().size, 0);
  assert.equal(await main.searchOnce(), false);
});

const autoSetup = (extra = {}) => {
  const t = setup({ auto_queue: true, ...extra });
  t.staging = path.join(t.root, 'Staging');
  t.holding = path.join(t.root, 'Holding');
  settingValues.staging_directory = t.staging;
  settingValues.holding_directory = t.holding;
  return t;
};

// The client downloads the queued release into the staging folder and reports it complete
const completeDownload = (t, name, size = 20) => {
  mkRelease(t.staging, name, 'new.mkv', size);
  const bundle = { id: 'b1', name, target: path.join(t.staging, name) + path.sep, status: { id: 'shared', completed: true } };
  t.bundles.set('b1', bundle);
  return bundle;
};

test('auto queue: download to staging, then the new copy beside the old, the old into holding', async () => {
  const t = autoSetup();
  const old = mkRelease(path.join(t.share, 'Movies'), 'Some.Movie.2019.720p.BluRay.x264-GRP');
  const main = t.make();
  await main.init();
  await main.refreshInventory();
  t.setResults([ dirResult('Some.Movie.2019.1080p.BluRay.x264-NEW') ]);
  await main.searchOnce();

  const dl = t.calls.find((c) => /download$/.test(c[1]));
  assert.equal(dl[1], `search/101/results/${dirResult('Some.Movie.2019.1080p.BluRay.x264-NEW').id}/download`);
  assert.deepEqual(dl[2], { target_directory: t.staging + path.sep, target_name: 'Some.Movie.2019.1080p.BluRay.x264-NEW' });
  const job = Object.values(main.getState().jobs)[0];
  assert.equal(job.state, 'queued');

  main.onBundleStatus(completeDownload(t, 'Some.Movie.2019.1080p.BluRay.x264-NEW'));
  await new Promise((r) => setTimeout(r, 10));
  await main.idle();

  const placed = path.join(t.share, 'Movies', 'Some.Movie.2019.1080p.BluRay.x264-NEW');
  assert.ok(fs.existsSync(path.join(placed, 'new.mkv')));
  assert.equal(fs.existsSync(old), false);
  assert.ok(fs.existsSync(path.join(t.holding, 'Some.Movie.2019.720p.BluRay.x264-GRP', 'video.mkv')));
  assert.equal(job.state, 'done');

  // Queue removal before anything moved; hash renames after; refresh of the shared folder
  const posts = t.calls.filter((c) => c[0] === 'POST').map((c) => c[1]);
  const removeAt = posts.indexOf('queue/bundles/b1/remove');
  assert.ok(removeAt > 0);
  assert.deepEqual(t.calls.find((c) => c[1] === 'queue/bundles/b1/remove')[2], { remove_finished: false });
  assert.ok(posts.indexOf('hash/rename_path') > removeAt);
  assert.ok(posts.includes('share/refresh/paths'));
  assert.equal(main.getState().held.length, 1);
});

test('auto queue refuses: holding folder inside the share, a release name already beside the old copy, a busy limit', async () => {
  const t = autoSetup();
  settingValues.holding_directory = path.join(t.share, 'Old');
  mkRelease(t.share, 'Some.Movie.2019.720p.BluRay.x264-GRP');
  const main = t.make();
  await main.init();
  await main.refreshInventory();
  t.setResults([ dirResult('Some.Movie.2019.1080p.BluRay.x264-NEW') ]);
  await main.searchOnce();
  assert.equal(t.calls.filter((c) => /download$/.test(c[1])).length, 0);
  assert.match(Object.values(main.getState().found)[0].note, /holding folder is inside the share/);

  const t2 = autoSetup();
  mkRelease(t2.share, 'Some.Movie.2019.720p.BluRay.x264-GRP');
  fs.mkdirSync(path.join(t2.share, 'Some.Movie.2019.1080p.BluRay.x264-NEW.txt'));
  const m2 = t2.make();
  await m2.init();
  await m2.refreshInventory();
  // The candidate name exists beside the old copy already (as a non-release folder of the same name)
  fs.renameSync(path.join(t2.share, 'Some.Movie.2019.1080p.BluRay.x264-NEW.txt'), path.join(t2.share, 'Some.Movie.2019.1080p.BluRay.x264-NEW'));
  t2.setResults([ dirResult('Some.Movie.2019.1080p.BluRay.x264-NEW') ]);
  await m2.searchOnce();
  assert.equal(t2.calls.filter((c) => /download$/.test(c[1])).length, 0);
  assert.match(Object.values(m2.getState().found)[0].note, /already exists beside the old copy/);
});

test('a release folder holding other folders is never replaced automatically', async () => {
  const t = autoSetup();
  const old = mkRelease(t.share, 'Some.Movie.2019.720p.BluRay.x264-GRP');
  fs.mkdirSync(path.join(old, 'My home videos'));
  const main = t.make();
  await main.init();
  await main.refreshInventory();
  t.setResults([ dirResult('Some.Movie.2019.1080p.BluRay.x264-NEW') ]);
  await main.searchOnce();
  assert.equal(t.calls.filter((c) => /download$/.test(c[1])).length, 0);
  assert.match(Object.values(main.getState().found)[0].note, /holds other folders/);
});

const queuedJob = async (t, main) => {
  await main.init();
  await main.refreshInventory();
  t.setResults([ dirResult('Some.Movie.2019.1080p.BluRay.x264-NEW') ]);
  await main.searchOnce();
  return Object.values(main.getState().jobs)[0];
};

test('an old copy in use: both copies kept, retried with backoff, finished once free', async () => {
  const t = autoSetup();
  const old = mkRelease(t.share, 'Some.Movie.2019.720p.BluRay.x264-GRP');
  let clock = 1_000_000_000_000;
  let busy = true;
  const moveImpl = async (src, dir, opts) => {
    if (busy && src === old) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return moveInto(src, dir, opts);
  };
  const main = t.make({ now: () => clock, moveImpl });
  const job = await queuedJob(t, main);
  main.onBundleStatus(completeDownload(t, 'Some.Movie.2019.1080p.BluRay.x264-NEW'));
  await new Promise((r) => setTimeout(r, 10));
  await main.idle();
  assert.equal(job.state, 'placed');
  assert.ok(fs.existsSync(old));
  assert.ok(fs.existsSync(path.join(t.share, 'Some.Movie.2019.1080p.BluRay.x264-NEW', 'new.mkv')));
  assert.match(t.events.at(-1).text, /EBUSY; trying again later/);

  // A restart reads the job back; not due yet, then due and free
  const again = t.make({ now: () => clock, moveImpl });
  await again.init();
  clock += 30 * 1000;
  await again.processDue();
  assert.equal(again.getState().jobs[job.id].state, 'placed');
  busy = false;
  clock += 2 * 60 * 1000;
  await again.processDue();
  assert.equal(again.getState().jobs[job.id].state, 'done');
  assert.equal(fs.existsSync(old), false);
  assert.ok(fs.existsSync(path.join(t.holding, 'Some.Movie.2019.720p.BluRay.x264-GRP')));
});

test('an old copy still in use after a day: given up, both copies kept', async () => {
  const t = autoSetup();
  const old = mkRelease(t.share, 'Some.Movie.2019.720p.BluRay.x264-GRP');
  let clock = 1_000_000_000_000;
  const moveImpl = async (src, dir, opts) => {
    if (src === old) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return moveInto(src, dir, opts);
  };
  const main = t.make({ now: () => clock, moveImpl });
  const job = await queuedJob(t, main);
  main.onBundleStatus(completeDownload(t, 'Some.Movie.2019.1080p.BluRay.x264-NEW'));
  await new Promise((r) => setTimeout(r, 10));
  await main.idle();
  clock += 25 * HOUR;
  await main.processDue();
  assert.equal(job.state, 'failed');
  assert.ok(fs.existsSync(path.join(old, 'video.mkv')));
  assert.match(job.note, /both copies are kept/);
});

test('killed after a move, before it was written down: the next start carries on, nothing is lost', async () => {
  const t = autoSetup();
  const old = mkRelease(t.share, 'Some.Movie.2019.720p.BluRay.x264-GRP');
  const main = t.make();
  const job = await queuedJob(t, main);
  completeDownload(t, 'Some.Movie.2019.1080p.BluRay.x264-NEW');

  // State on disk says "downloaded", but the new copy was already moved beside the old one
  job.state = 'downloaded';
  job.bundleId = 'b1';
  main.saveState();
  fs.renameSync(path.join(t.staging, 'Some.Movie.2019.1080p.BluRay.x264-NEW'), path.join(t.share, 'Some.Movie.2019.1080p.BluRay.x264-NEW'));

  const again = t.make();
  await again.init();
  await again.processDue();
  const j = again.getState().jobs[job.id];
  assert.equal(j.state, 'done');
  assert.ok(fs.existsSync(path.join(t.share, 'Some.Movie.2019.1080p.BluRay.x264-NEW', 'new.mkv')));
  assert.equal(fs.existsSync(old), false);
  assert.ok(fs.existsSync(path.join(t.holding, 'Some.Movie.2019.720p.BluRay.x264-GRP', 'video.mkv')));
});

test('a partial cross-drive copy left by a kill is removed at start; the original stays', async () => {
  const t = autoSetup();
  mkRelease(t.share, 'Some.Movie.2019.720p.BluRay.x264-GRP');
  const main = t.make();
  const job = await queuedJob(t, main);
  completeDownload(t, 'Some.Movie.2019.1080p.BluRay.x264-NEW');
  job.state = 'downloaded';
  main.saveState();
  const partial = path.join(t.share, 'Some.Movie.2019.1080p.BluRay.x264-NEW.upgrader-partial');
  fs.mkdirSync(partial);
  const again = t.make();
  await again.init();
  await again.cleanPartials();
  assert.equal(fs.existsSync(partial), false);
  assert.ok(fs.existsSync(path.join(t.staging, 'Some.Movie.2019.1080p.BluRay.x264-NEW', 'new.mkv')));
});

test('a download removed from the queue cancels the job; the old copy is never touched', async () => {
  const t = autoSetup();
  const old = mkRelease(t.share, 'Some.Movie.2019.720p.BluRay.x264-GRP');
  const main = t.make();
  const job = await queuedJob(t, main);
  main.onBundleRemoved({ id: 'b9', target: path.join(t.staging, 'Some.Movie.2019.1080p.BluRay.x264-NEW') + path.sep });
  assert.equal(job.state, 'cancelled');
  await main.processDue();
  assert.ok(fs.existsSync(old));
});

test('a destination that appeared meanwhile is never overwritten', async () => {
  const t = autoSetup();
  const old = mkRelease(t.share, 'Some.Movie.2019.720p.BluRay.x264-GRP');
  const main = t.make();
  const job = await queuedJob(t, main);
  mkRelease(t.share, 'Some.Movie.2019.1080p.BluRay.x264-NEW', 'mine.mkv');
  main.onBundleStatus(completeDownload(t, 'Some.Movie.2019.1080p.BluRay.x264-NEW'));
  await new Promise((r) => setTimeout(r, 10));
  await main.idle();
  assert.equal(job.state, 'failed');
  assert.ok(fs.existsSync(path.join(t.share, 'Some.Movie.2019.1080p.BluRay.x264-NEW', 'mine.mkv')));
  assert.ok(fs.existsSync(path.join(t.staging, 'Some.Movie.2019.1080p.BluRay.x264-NEW', 'new.mkv')));
  assert.ok(fs.existsSync(old));
  // Not taken out of the queue either
  assert.equal(t.calls.filter((c) => /remove$/.test(c[1])).length, 0);
});

test('other searches: a better copy seen there is reported and searched for next; own results ignored', async () => {
  const t = setup();
  mkRelease(t.share, 'The.Show.S01E02.720p.HDTV.x264-GRP');
  mkRelease(t.share, 'The.Show.S01E03.720p.HDTV.x264-GRP');
  const main = t.make();
  await main.init();
  await main.refreshInventory();

  main.onSearchResult({ search_id: 'x', result: dirResult('The.Show.S01E09.1080p.WEB.h264-NEW') }, 7);
  main.onSearchResult({ search_id: 'x', result: { name: 'The.Show.S01E03.1080p.WEB.h264-NEW', type: { id: 'file' } } }, 7);
  assert.deepEqual(main.getState().found, {});

  main.onSearchResult({ search_id: 'x', result: dirResult('The.Show.S01E03.1080p.WEB.h264-NEW') }, 7);
  const found = Object.values(main.getState().found);
  assert.equal(found.length, 1);
  assert.equal(found[0].passive, true);

  t.setResults([]);
  await main.searchOnce();
  assert.equal(t.calls.find((c) => /hub_search$/.test(c[1]))[2].query.pattern, 'the show S01E03');

  // A late result of this extension's own search (instance 101) is not "another search"
  main.onSearchResult({ search_id: 'y', result: dirResult('The.Show.S01E02.1080p.WEB.h264-LATE') }, 101);
  assert.equal(Object.keys(main.getState().found).length, 1);
  main.onSearchResult({ search_id: 'y', result: dirResult('The.Show.S01E02.1080p.WEB.h264-LATE') }, 102);
  assert.equal(Object.keys(main.getState().found).length, 2);

  // Switched off: nothing
  settingValues.watch_other_searches = false;
  main.onSearchResult({ search_id: 'y', result: dirResult('The.Show.S01E02.1080p.WEB.h264-OFF') }, 102);
  assert.equal(Object.keys(main.getState().found).length, 2);
});

test('library mode: films from the media server, joined to the share by file name, picture size wins', async () => {
  const t = setup({ media_username: 'me' });
  mkRelease(t.share, 'Some.Movie.2019.BluRay.x264-GRP', 'grp-somemovie.mkv');
  mkRelease(t.share, 'Other.Movie.2018.720p.BluRay.x264-GRP', 'other.mkv');
  const main = t.make();
  await main.init();
  main.setJellyfin({
    userId: async () => 'u1',
    get: async (p, q) => {
      assert.equal(p, '/Users/u1/Items');
      assert.equal(q.IncludeItemTypes, 'Movie,Episode');
      return { Items: [ { Id: 'j1', Name: 'Some Movie', Path: 'fuldc:/j1/grp-somemovie.mkv', Width: 1280, Height: 720, UserData: { Played: true } } ], TotalRecordCount: 1 };
    },
    post: async () => {},
  });
  await main.refreshInventory();
  assert.equal(main.getMode(), 'library');
  const inv = [ ...main.getInventory().values() ];
  assert.equal(inv.length, 1);
  assert.equal(inv[0].best.parsed.resolution, 720);
  assert.equal(inv[0].best.jellyfinId, 'j1');
  assert.ok(inv[0].best.path.endsWith('Some.Movie.2019.BluRay.x264-GRP'));
});

test('library mode falls back to the share when the media server cannot be read', async () => {
  const t = setup({ media_username: 'me' });
  mkRelease(t.share, 'Other.Movie.2018.720p.BluRay.x264-GRP');
  const main = t.make();
  await main.init();
  main.setJellyfin({ userId: async () => { throw Object.assign(new Error('media server: HTTP 401'), { status: 401 }); }, get: async () => ({}), post: async () => {} });
  await main.refreshInventory();
  assert.equal(main.getMode(), 'share');
  assert.equal(main.getInventory().size, 1);
  assert.match(t.events.at(-1).text, /could not read the media library \(media server: HTTP 401\)/);
});

test('watched state: read before the old copy goes, written to the new copy once the library lists it', async () => {
  const t = autoSetup({ media_username: 'me' });
  const old = mkRelease(t.share, 'Some.Movie.2019.720p.BluRay.x264-GRP', 'old.mkv');
  let clock = 1_000_000_000_000;
  const library = [ { Id: 'old1', Path: 'fuldc:/old1/old.mkv', Height: 720, Width: 1280 } ];
  const posted = [];
  const userData = { old1: { Played: true, PlaybackPositionTicks: 0 } };
  const main = t.make({ now: () => clock });
  await main.init();
  main.setJellyfin({
    userId: async () => 'u1',
    get: async (p) => {
      if (p === '/Users/u1/Items') return { Items: library, TotalRecordCount: library.length };
      const m = /^\/UserItems\/(\w+)\/UserData$/.exec(p);
      if (m) return userData[m[1]] || { Played: false, PlaybackPositionTicks: 0 };
      throw new Error(`unexpected ${p}`);
    },
    post: async (p, body) => { posted.push([ p, body ]); },
  });
  const job = await (async () => {
    await main.refreshInventory();
    t.setResults([ dirResult('Some.Movie.2019.1080p.BluRay.x264-NEW') ]);
    await main.searchOnce();
    return Object.values(main.getState().jobs)[0];
  })();
  assert.equal(job.oldJellyfinId, 'old1');

  main.onBundleStatus(completeDownload(t, 'Some.Movie.2019.1080p.BluRay.x264-NEW'));
  await new Promise((r) => setTimeout(r, 10));
  await main.idle();
  // Placed; waiting for the library to list the new copy, the old one stays meanwhile
  assert.equal(job.state, 'placed');
  assert.ok(fs.existsSync(old));
  assert.deepEqual(job.watched, { Played: true, PlaybackPositionTicks: 0 });

  library.push({ Id: 'new1', Path: 'fuldc:/new1/new.mkv', Height: 1080, Width: 1920 });
  clock += 6 * 60 * 1000;
  await main.processDue();
  assert.equal(job.state, 'done');
  assert.equal(fs.existsSync(old), false);
  assert.deepEqual(posted, [ [ '/UserItems/new1/UserData', { Played: true, PlaybackPositionTicks: 0 } ] ]);
});

test('watched state already on the new copy (the server adopted it) is not written again', async () => {
  const t = autoSetup({ media_username: 'me' });
  mkRelease(t.share, 'Some.Movie.2019.720p.BluRay.x264-GRP', 'old.mkv');
  const library = [ { Id: 'old1', Path: 'fuldc:/old1/old.mkv', Height: 720, UserData: { Played: true } }, { Id: 'new1', Path: 'fuldc:/new1/new.mkv', Height: 1080 } ];
  const posted = [];
  const main = t.make();
  await main.init();
  main.setJellyfin({
    userId: async () => 'u1',
    get: async (p) => (p === '/Users/u1/Items' ? { Items: library } : (p.includes('new1') ? { Played: true } : { Played: true })),
    post: async (p, body) => { posted.push([ p, body ]); },
  });
  await main.refreshInventory();
  t.setResults([ dirResult('Some.Movie.2019.1080p.BluRay.x264-NEW') ]);
  await main.searchOnce();
  const job = Object.values(main.getState().jobs)[0];
  main.onBundleStatus(completeDownload(t, 'Some.Movie.2019.1080p.BluRay.x264-NEW'));
  await new Promise((r) => setTimeout(r, 10));
  await main.idle();
  assert.equal(job.state, 'done');
  assert.deepEqual(posted, []);
});

test('the holding folder is never purged by default; with a limit, only what this extension put there', async () => {
  const t = autoSetup();
  let clock = 1_000_000_000_000;
  const main = t.make({ now: () => clock });
  await main.init();
  const ours = mkRelease(t.holding, 'Old.Movie.2010.720p.BluRay.x264-GRP');
  const theirs = mkRelease(t.holding, 'Someone.Elses.2010.720p.BluRay.x264-GRP');
  const outside = mkRelease(t.share, 'Outside.2010.720p.BluRay.x264-GRP');
  main.getState().held.push({ path: ours, at: clock, holdingDir: t.holding }, { path: outside, at: clock, holdingDir: t.holding });
  clock += 400 * 24 * HOUR;
  await main.purgeHolding();
  assert.ok(fs.existsSync(ours));

  settingValues.holding_purge_days = 30;
  await main.purgeHolding();
  assert.equal(fs.existsSync(ours), false);
  assert.ok(fs.existsSync(theirs));
  assert.ok(fs.existsSync(outside));
  assert.deepEqual(main.getState().held, []);
});

test('/upgrade list and status answer locally with a prefix; other commands are ignored', async () => {
  const t = setup();
  mkRelease(t.share, 'The.Show.S01E02.720p.HDTV.x264-GRP');
  const main = t.make();
  await main.init();
  await main.refreshInventory();
  t.setResults([ dirResult('The.Show.S01E02.1080p.WEB.h264-NEW') ]);
  await main.searchOnce();
  const handler = main.onTextCommand('hubs');
  await handler({ command: 'upgrade', args: [ 'list' ] }, 5);
  assert.match(t.replies[0], /^\[upgrade\] The\.Show\.S01E02\.720p\.HDTV\.x264-GRP -> The\.Show\.S01E02\.1080p\.WEB\.h264-NEW \(720p -> 1080p; report only\)$/);
  assert.ok(t.replies.every((r) => r.startsWith('[upgrade] ')));
  const before = t.replies.length;
  await handler({ command: 'upgrade', args: [ 'status' ] }, 5);
  assert.equal(t.replies.length, before + 3);
  await handler({ command: 'seen', args: [] }, 5);
  await handler(null, 5);
  assert.equal(t.replies.length, before + 3);
});

test('a broken state file is set aside and the extension starts clean', async () => {
  const t = setup();
  fs.writeFileSync(path.join(t.config, 'state.json'), '{ not json');
  const main = t.make();
  await main.init();
  assert.deepEqual(main.getState().jobs, {});
  assert.ok(fs.readdirSync(t.config).some((f) => f.startsWith('state.json.bad-')));
});

test('a failing search API is logged, the search counted, the extension keeps going', async () => {
  const t = setup();
  mkRelease(t.share, 'The.Show.S01E02.720p.HDTV.x264-GRP');
  const main = t.make();
  await main.init();
  await main.refreshInventory();
  const orig = t.socket.post;
  t.socket.post = async (url, body) => {
    if (/hub_search$/.test(url)) throw Object.assign(new Error('Search queue overflow'), { code: 503 });
    return orig(url, body);
  };
  assert.equal(await main.searchOnce(), true);
  assert.equal(main.getState().searches.length, 1);
  assert.deepEqual(t.deleted, [ 'search/101' ]);
});

// ---- review fixes ------------------------------------------------------------------------

test('the job is on disk before the download is queued (a kill in between leaves no unknown download)', async () => {
  const t = autoSetup();
  mkRelease(t.share, 'Some.Movie.2019.720p.BluRay.x264-GRP');
  const main = t.make();
  let onDisk = null;
  const orig = t.socket.post;
  t.socket.post = async (url, body) => {
    if (/download$/.test(url)) onDisk = JSON.parse(fs.readFileSync(path.join(t.config, 'state.json'), 'utf8'));
    return orig(url, body);
  };
  await queuedJob(t, main);
  assert.ok(onDisk, 'download queued');
  const jobs = Object.values(onDisk.jobs);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].stagingPath, path.join(t.staging, 'Some.Movie.2019.1080p.BluRay.x264-NEW'));

  // A failing download leaves no job behind
  const t2 = autoSetup();
  mkRelease(t2.share, 'Some.Movie.2019.720p.BluRay.x264-GRP');
  const o2 = t2.socket.post;
  t2.socket.post = async (url, body) => {
    if (/download$/.test(url)) throw Object.assign(new Error('nope'), { code: 500 });
    return o2(url, body);
  };
  const m2 = t2.make();
  await queuedJob(t2, m2);
  assert.deepEqual(m2.getState().jobs, {});
  assert.match(Object.values(m2.getState().found)[0].note, /could not queue it/);
});

test('a completed download removed from the queue is still put in place', async () => {
  const t = autoSetup();
  const old = mkRelease(t.share, 'Some.Movie.2019.720p.BluRay.x264-GRP');
  const main = t.make();
  const job = await queuedJob(t, main);
  const bundle = completeDownload(t, 'Some.Movie.2019.1080p.BluRay.x264-NEW');
  t.bundles.delete('b1'); // "Remove completed" in the queue
  main.onBundleRemoved(bundle);
  await main.idle();
  assert.equal(job.state, 'done');
  assert.ok(fs.existsSync(path.join(t.share, 'Some.Movie.2019.1080p.BluRay.x264-NEW', 'new.mkv')));
  assert.equal(fs.existsSync(old), false);
  assert.ok(fs.existsSync(path.join(t.holding, 'Some.Movie.2019.720p.BluRay.x264-GRP')));
});

test('a completed bundle that vanished while the extension was not running is put in place at start', async () => {
  const t = autoSetup();
  const old = mkRelease(t.share, 'Some.Movie.2019.720p.BluRay.x264-GRP');
  const main = t.make({ settleMs: 100000 });
  const job = await queuedJob(t, main);
  // Completion seen, then killed during the settle wait; the core removed the bundle on exit
  main.onBundleStatus(completeDownload(t, 'Some.Movie.2019.1080p.BluRay.x264-NEW'));
  main.onStop && main.onStop();
  t.ext.onStop && t.ext.onStop();
  t.bundles.clear();

  const again = t.make();
  await again.init();
  await again.reconcileQueue();
  await again.processDue();
  assert.equal(again.getState().jobs[job.id].state, 'done');
  assert.equal(fs.existsSync(old), false);
  assert.ok(fs.existsSync(path.join(t.share, 'Some.Movie.2019.1080p.BluRay.x264-NEW', 'new.mkv')));
});

test('a bundle removed before it completed still cancels; a queued job without completion is left alone at start', async () => {
  const t = autoSetup();
  const old = mkRelease(t.share, 'Some.Movie.2019.720p.BluRay.x264-GRP');
  const main = t.make();
  const job = await queuedJob(t, main);
  // Partly downloaded files in staging, bundle never completed and no longer in the queue
  mkRelease(t.staging, 'Some.Movie.2019.1080p.BluRay.x264-NEW', 'new.mkv');
  await main.reconcileQueue();
  assert.equal(job.state, 'queued');
  main.onBundleRemoved({ id: 'b1', target: path.join(t.staging, 'Some.Movie.2019.1080p.BluRay.x264-NEW') + path.sep, status: { completed: false } });
  assert.equal(job.state, 'cancelled');
  await main.processDue();
  assert.ok(fs.existsSync(old));
});

test('the old copy stays when the new copy is gone before it is replaced', async () => {
  const t = autoSetup({ media_username: 'me' });
  const old = mkRelease(t.share, 'Some.Movie.2019.720p.BluRay.x264-GRP', 'old.mkv');
  let clock = 1_000_000_000_000;
  const library = [ { Id: 'old1', Path: 'fuldc:/old1/old.mkv', Height: 720, Width: 1280 } ];
  const main = t.make({ now: () => clock });
  await main.init();
  main.setJellyfin({
    userId: async () => 'u1',
    get: async (p) => (p === '/Users/u1/Items' ? { Items: library, TotalRecordCount: library.length } : { Played: false }),
    post: async () => {},
  });
  await main.refreshInventory();
  t.setResults([ dirResult('Some.Movie.2019.1080p.BluRay.x264-NEW') ]);
  await main.searchOnce();
  const job = Object.values(main.getState().jobs)[0];
  main.onBundleStatus(completeDownload(t, 'Some.Movie.2019.1080p.BluRay.x264-NEW'));
  await new Promise((r) => setTimeout(r, 10));
  await main.idle();
  assert.equal(job.state, 'placed');

  // The user deletes the new copy while the extension waits for the library
  fs.rmSync(path.join(t.share, 'Some.Movie.2019.1080p.BluRay.x264-NEW'), { recursive: true });
  clock += 3 * HOUR;
  await main.processDue();
  assert.ok(fs.existsSync(path.join(old, 'old.mkv')));
  assert.equal(job.state, 'failed');
  assert.match(job.note, /new copy/);
});

test('switching automatic replacing off pauses jobs under way; on again, they finish', async () => {
  const t = autoSetup();
  const old = mkRelease(t.share, 'Some.Movie.2019.720p.BluRay.x264-GRP');
  const main = t.make();
  const job = await queuedJob(t, main);
  settingValues.auto_queue = false;
  main.onBundleStatus(completeDownload(t, 'Some.Movie.2019.1080p.BluRay.x264-NEW'));
  await new Promise((r) => setTimeout(r, 10));
  await main.idle();
  await main.processDue();
  assert.equal(job.state, 'downloaded');
  assert.ok(fs.existsSync(old));
  assert.ok(fs.existsSync(path.join(t.staging, 'Some.Movie.2019.1080p.BluRay.x264-NEW', 'new.mkv')));
  assert.equal(fs.existsSync(path.join(t.share, 'Some.Movie.2019.1080p.BluRay.x264-NEW')), false);

  settingValues.auto_queue = true;
  await main.processDue();
  assert.equal(job.state, 'done');
  assert.equal(fs.existsSync(old), false);
});

test('library mode: a personal file sharing the release file name is not joined, so nothing is replaced', async () => {
  const t = autoSetup({ media_username: 'me' });
  mkRelease(t.share, 'Some.Movie.2019.1080p.BluRay.x264-GRP', 'movie.mkv');
  mkRelease(t.share, 'Home videos', 'movie.mkv');
  const main = t.make();
  await main.init();
  main.setJellyfin({
    userId: async () => 'u1',
    // Only the personal file is in the library; it is small
    get: async () => ({ Items: [ { Id: 'h1', Path: 'fuldc:/h1/movie.mkv', Width: 640, Height: 360 } ], TotalRecordCount: 1 }),
    post: async () => {},
  });
  await main.refreshInventory();
  for (const entry of main.getInventory().values()) {
    assert.equal(entry.best.path, null);
  }
});

test('killed after a cross-drive copy was committed: carried on as placed, the staging leftover noted, nothing deleted', async () => {
  const t = autoSetup();
  const old = mkRelease(t.share, 'Some.Movie.2019.720p.BluRay.x264-GRP');
  const main = t.make();
  const job = await queuedJob(t, main);
  completeDownload(t, 'Some.Movie.2019.1080p.BluRay.x264-NEW');
  job.state = 'downloaded';
  job.bundleId = 'b1';
  job.moveStarted = true;
  main.saveState();
  // The copy reached its final name; the staging original was not deleted yet
  fs.cpSync(path.join(t.staging, 'Some.Movie.2019.1080p.BluRay.x264-NEW'), path.join(t.share, 'Some.Movie.2019.1080p.BluRay.x264-NEW'), { recursive: true });

  const again = t.make();
  await again.init();
  await again.processDue();
  const j = again.getState().jobs[job.id];
  assert.equal(j.state, 'done');
  assert.equal(fs.existsSync(old), false);
  assert.ok(fs.existsSync(path.join(t.staging, 'Some.Movie.2019.1080p.BluRay.x264-NEW', 'new.mkv')));
  assert.match(j.note, /staging/);
});

// Live test 2026-10-19: the client was killed while an upgrade waited in "placed"; after the restart
// state.json was empty and the new copy stayed beside the old one, both shared, for good. load()
// calls onValuesUpdated with every value, the handler saw media_username and saved the state, and
// that state was still the empty default because loadState() ran only after load().
test('a start keeps state.json: jobs, finds and the search budget survive a restart', async () => {
  const t = setup({ media_username: 'qa', media_password: 'pw' });
  const staging = path.join(t.root, 'staging');
  const holding = path.join(t.root, 'holding');
  Object.assign(settingValues, { staging_directory: staging, holding_directory: holding });
  const saved = {
    version: 1, deviceId: 'dev1', token: { accessToken: 'tok', userId: 'u1' },
    items: { 'movie:some film (2019)': { lastChecked: Date.now() - 1000, priority: 0 } },
    searches: [ Date.now() - 60000 ],
    found: { 'movie:some film (2019)|x': { id: 'movie:some film (2019)|x', key: 'movie:some film (2019)', candidate: 'X', status: 'placed', jobId: 'j1' } },
    jobs: { j1: { id: 'j1', key: 'movie:some film (2019)', state: 'placed', created: Date.now(), nextAt: Date.now() + 3600000, parentDir: t.share, newName: 'X', oldPath: path.join(t.share, 'old'), stagingPath: path.join(staging, 'X'), holdingDir: holding } },
    held: [],
  };
  fs.writeFileSync(path.join(t.config, 'state.json'), JSON.stringify(saved));
  t.make();
  await t.ext.onStart();
  t.ext.onStop();
  const after = JSON.parse(fs.readFileSync(path.join(t.config, 'state.json'), 'utf8'));
  assert.equal(after.deviceId, 'dev1');
  assert.deepEqual(Object.keys(after.jobs), [ 'j1' ]);
  assert.equal(after.jobs.j1.state, 'placed');
  assert.equal(Object.keys(after.found).length, 1);
  assert.equal(after.searches.length, 1);
});
