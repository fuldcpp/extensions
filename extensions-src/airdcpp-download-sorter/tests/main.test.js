'use strict';

// main.js against a fake client and real temporary folders: the order of the API calls (queue
// removal before the move, hash renames after it), dry run, collisions, the source-folder fence
// and the in-use retry.

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
  exports: () => ({ load: async () => {}, getValue: (key) => settingValues[key], set onValuesUpdated(cb) {} }),
};

const createMain = require('../src/main.js');

const setup = (overrides = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sorter-main-'));
  const dl = path.join(root, 'Downloads');
  fs.mkdirSync(dl);
  settingValues = SettingDefinitions.reduce((r, d) => ({ ...r, [d.key]: d.default_value }), {});
  Object.assign(settingValues, { dry_run: false, tv_directory: path.join(root, 'TV'), movies_directory: path.join(root, 'Movies'), source_directory: dl }, overrides);

  const bundles = new Map();
  const calls = [];
  const events = [];
  const socket = {
    logger: { verbose() {}, info() {}, error() {} },
    get: async (url) => {
      const id = url.split('/').pop();
      if (!bundles.has(id)) throw Object.assign(new Error('Bundle not found'), { code: 404 });
      return bundles.get(id);
    },
    post: async (url, body) => {
      if (url === 'events') { events.push(body); return; }
      calls.push([ url, body ]);
      if (url === 'hash/rename_path') {
        // The real store requires the new file to exist already
        assert.ok(fs.existsSync(body.new_path), `rename_path before the file was moved: ${body.new_path}`);
        if (body.old_path.endsWith('.nfo')) throw Object.assign(new Error('not in hash database'), { code: 400 });
      }
      if (url.endsWith('/remove')) bundles.delete(url.split('/')[2]);
    },
  };

  const addRelease = (id, name, { completed = true, dir = dl } = {}) => {
    const folder = path.join(dir, name);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'video.mkv'), 'v');
    fs.writeFileSync(path.join(folder, 'info.nfo'), 'n');
    bundles.set(String(id), { id, name, target: folder + path.sep, status: { id: completed ? 'shared' : 'queued', completed } });
    return folder;
  };

  const ext = { name: 'airdcpp-download-sorter', configPath: root + path.sep };
  return { root, dl, socket, calls, events, bundles, addRelease, ext };
};


test('moves a finished TV release: queue removal first, then hash renames, then share refreshes', async () => {
  const t = setup();
  const src = t.addRelease(1, 'The.Show.S01E02.1080p.WEB.h264-GRP');
  await createMain(t.socket, t.ext).sortBundle('1');
  const dest = path.join(t.root, 'TV', 'The Show', 'Season 01', 'The.Show.S01E02.1080p.WEB.h264-GRP');
  assert.ok(fs.existsSync(path.join(dest, 'video.mkv')));
  assert.equal(fs.existsSync(src), false);
  const urls = t.calls.map((c) => c[0]);
  assert.equal(urls[0], 'queue/bundles/1/remove');
  assert.deepEqual(t.calls[0][1], { remove_finished: false });
  assert.deepEqual(urls.filter((u) => u === 'hash/rename_path').length, 2);
  assert.deepEqual(t.calls.filter((c) => c[0] === 'share/refresh/paths').map((c) => c[1].paths[0]),
    [ t.dl, path.join(t.root, 'TV', 'The Show', 'Season 01') ]);
  assert.match(t.events.at(-1).text, /moved The\.Show\.S01E02.* \(1 hashed file\(s\) kept\)/);
});

test('dry run logs and touches nothing', async () => {
  const t = setup({ dry_run: true });
  const src = t.addRelease(2, 'Some.Movie.2019.1080p.BluRay.x264-GRP');
  await createMain(t.socket, t.ext).sortBundle('2');
  assert.ok(fs.existsSync(src));
  assert.deepEqual(t.calls, []);
  assert.match(t.events[0].text, /^airdcpp-download-sorter: dry run: would move .*Some\.Movie.* \(movies\)$/);
});

test('an existing destination: not removed from the queue, not moved', async () => {
  const t = setup();
  const src = t.addRelease(3, 'Some.Movie.2019.1080p.BluRay.x264-GRP');
  fs.mkdirSync(path.join(t.root, 'Movies', 'Some.Movie.2019.1080p.BluRay.x264-GRP'), { recursive: true });
  await createMain(t.socket, t.ext).sortBundle('3');
  assert.ok(fs.existsSync(path.join(src, 'video.mkv')));
  assert.deepEqual(t.calls, []);
  assert.equal(t.events[0].severity, 'warning');
});

test('downloads outside the source folder, unfinished ones and unknown categories are left alone', async () => {
  const t = setup();
  const elsewhere = t.addRelease(4, 'The.Show.S01E03.720p.HDTV-GRP', { dir: path.join(t.root, 'Elsewhere') });
  const running = t.addRelease(5, 'The.Show.S01E04.720p.HDTV-GRP', { completed: false });
  const unknown = t.addRelease(6, 'Holiday photos');
  const main = createMain(t.socket, t.ext);
  for (const id of [ '4', '5', '6', '99' ]) {
    await main.sortBundle(id);
  }

  assert.ok(fs.existsSync(elsewhere) && fs.existsSync(running) && fs.existsSync(unknown));
  assert.deepEqual(t.calls, []);
});

test('the client download folder is the default source', async () => {
  const t = setup({ source_directory: '' });
  t.socket.post = ((orig) => async (url, body) => (url === 'settings/get' ? { download_directory: t.dl + path.sep } : orig(url, body)))(t.socket.post);
  t.socket.addListener = async () => {};
  const ext = t.ext;
  const main = createMain(t.socket, ext);
  await ext.onStart();
  ext.onStop();
  const src = t.addRelease(7, 'The.Show.S01E05.720p.HDTV-GRP');
  await main.sortBundle('7');
  assert.equal(fs.existsSync(src), false);
});

test('a release in use stays pending with backoff, survives a restart, and moves once free', async () => {
  const t = setup();
  const src = t.addRelease(8, 'The.Show.S01E06.720p.HDTV-GRP');
  let clock = 1_000_000;
  let busy = true;
  const moveImpl = async (source, dir) => {
    if (busy) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return moveInto(source, dir);
  };
  const main = createMain(t.socket, t.ext, { moveImpl, now: () => clock });
  await main.sortBundle('8');
  assert.ok(fs.existsSync(src));
  assert.equal(Object.values(main.getPending())[0].attempts, 1);
  assert.match(t.events.at(-1).text, /is in use \(EBUSY\); it will be moved once it is free/);

  // Not due yet: no attempt
  clock += 30 * 1000;
  await main.processPending();
  assert.equal(Object.values(main.getPending())[0].attempts, 1);

  // A new process (restart) reads the record and finishes the job once the file is free
  busy = false;
  clock += 2 * 60 * 1000;
  const main2 = createMain(t.socket, t.ext, { moveImpl, now: () => clock });
  main2.loadPending();
  await main2.processPending();
  assert.equal(fs.existsSync(src), false);
  assert.deepEqual(main2.getPending(), {});
  assert.match(t.events.at(-1).text, /^airdcpp-download-sorter: moved The\.Show\.S01E06/);
});

test('a release still in use after 24 hours is given up on, loudly, with its files in place', async () => {
  const t = setup();
  const src = t.addRelease(9, 'The.Show.S01E07.720p.HDTV-GRP');
  let clock = 1_000_000;
  const moveImpl = async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
  const main = createMain(t.socket, t.ext, { moveImpl, now: () => clock });
  await main.sortBundle('9');
  clock += 25 * 60 * 60 * 1000;
  await main.processPending();
  assert.deepEqual(main.getPending(), {});
  assert.ok(fs.existsSync(path.join(src, 'video.mkv')));
  assert.equal(t.events.at(-1).severity, 'error');
  assert.match(t.events.at(-1).text, /could not move .* \(EBUSY\); it stays in/);
});

test('a partial copy left by an interrupted move is removed at start, the original kept', async () => {
  const t = setup();
  const src = t.addRelease(10, 'Some.Movie.2019.1080p.BluRay.x264-GRP');
  const dest = path.join(t.root, 'Movies');
  fs.mkdirSync(path.join(dest, 'Some.Movie.2019.1080p.BluRay.x264-GRP.sorter-partial'), { recursive: true });
  fs.writeFileSync(path.join(t.root, 'pending-moves.json'), JSON.stringify({ version: 1, pending: { [src]: { source: src, directory: dest, name: 'x', attempts: 1, since: Date.now(), nextAt: Date.now() + 1e9 } } }));
  const main = createMain(t.socket, t.ext);
  main.loadPending();
  await main.cleanPartials();
  assert.equal(fs.existsSync(path.join(dest, 'Some.Movie.2019.1080p.BluRay.x264-GRP.sorter-partial')), false);
  assert.ok(fs.existsSync(path.join(src, 'video.mkv')));
});

test('a pending move without a destination is dropped at load, not thrown on at every start', async () => {
  const t = setup();
  const src = t.addRelease(13, 'Torn.Entry.2019.1080p.BluRay.x264-GRP');
  fs.writeFileSync(path.join(t.root, 'pending-moves.json'), JSON.stringify({ version: 1, pending: {
    [src]: { source: src, name: 'x', attempts: 1, since: Date.now(), nextAt: Date.now() + 1e9 },
    other: null,
  } }));
  const main = createMain(t.socket, t.ext);
  main.loadPending();
  assert.deepEqual(main.getPending(), {});
  await main.cleanPartials();   // used to throw (path.join(undefined)), which ended the start
});

test('a destination that cannot even be looked at is logged, and the other partial copies are still removed', async () => {
  const t = setup();
  const good = t.addRelease(14, 'Some.Movie.2019.1080p.BluRay.x264-GRP');
  const dest = path.join(t.root, 'Movies');
  const partial = path.join(dest, 'Some.Movie.2019.1080p.BluRay.x264-GRP.sorter-partial');
  fs.mkdirSync(partial, { recursive: true });
  // A NUL in the path makes lstat throw something other than ENOENT, as EPERM on a changed share does
  const unreadable = path.join(t.root, 'No\u0000Look');
  fs.writeFileSync(path.join(t.root, 'pending-moves.json'), JSON.stringify({ version: 1, pending: {
    a: { source: good + 'x', directory: unreadable, name: 'a', attempts: 1, since: Date.now(), nextAt: Date.now() + 1e9 },
    [good]: { source: good, directory: dest, name: 'x', attempts: 1, since: Date.now(), nextAt: Date.now() + 1e9 },
  } }));
  const errors = [];
  t.socket.logger.error = (text) => errors.push(text);
  const main = createMain(t.socket, t.ext);
  main.loadPending();
  await main.cleanPartials();   // used to reject on the first entry, before the second was looked at
  assert.equal(fs.existsSync(partial), false);
  assert.ok(errors.some((e) => /Could not check for a partial copy/.test(e)), errors.join(' | '));
});

test('guards: relative folders, a missing drive, releases around destinations are refused before the queue removal', async () => {
  // Relative own-rule folder: rejected as a rule, so the release is left alone
  const t = setup({ custom_rules: '^Rel => TV', tv_directory: '', movies_directory: '' });
  const a = t.addRelease(11, 'Rel.Something');
  await createMain(t.socket, t.ext).sortBundle('11');
  assert.ok(fs.existsSync(a));
  assert.deepEqual(t.calls, []);

  // A destination on a drive that does not exist
  if (!fs.existsSync('Q:\\')) {
    const t2 = setup({ movies_directory: 'Q:\\NoSuchDrive\\Movies\\' });
    const b = t2.addRelease(12, 'Some.Movie.2019.1080p.BluRay.x264-GRP');
    await createMain(t2.socket, t2.ext).sortBundle('12');
    assert.ok(fs.existsSync(b));
    assert.deepEqual(t2.calls, []);
    assert.match(t2.events.at(-1).text, /is not available/);
  }

  // A release sitting under a destination folder (already sorted) is never moved again
  const t3 = setup();
  settingValues.tv_directory = path.join(t3.dl, 'TV');
  const c = t3.addRelease(13, 'The.Show.S01E08.720p.HDTV-GRP', { dir: settingValues.tv_directory });
  await createMain(t3.socket, t3.ext).sortBundle('13');
  assert.ok(fs.existsSync(c));
  assert.deepEqual(t3.calls, []);

  // The source folder itself (target equal to the source) is never a release
  const t4 = setup();
  t4.bundles.set('14', { id: 14, name: 'The.Show.S01E09.720p.HDTV-GRP', target: t4.dl + path.sep, status: { id: 'shared', completed: true } });
  await createMain(t4.socket, t4.ext).sortBundle('14');
  assert.ok(fs.existsSync(t4.dl));
  assert.deepEqual(t4.calls, []);
});

