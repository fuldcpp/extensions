'use strict';

// Drives main.js against a fake socket, real fixture archives in temporary release folders and
// the real worker threads: what lands on disk, what is never touched, what the client is told,
// and a restart after a kill.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SettingDefinitions } = require('../src/settings');
const { payload } = require('./fixtures/payload');

const settingsPath = require.resolve('airdcpp-extension-settings');
let settingValues;
require.cache[settingsPath] = {
  id: settingsPath, filename: settingsPath, loaded: true,
  exports: () => ({ load: async () => {}, getValue: (key) => settingValues[key], set onValuesUpdated(cb) {} }),
};

const createMain = require('../src/main.js');

const FIX = path.join(__dirname, 'fixtures');
const GIB = 1024 * 1024 * 1024;

const tmpDir = (prefix = 'unpk-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// A release folder: <root>\<name>\ with the files of one or more fixture sets
const makeRelease = (name, fixtures, root = tmpDir()) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [ fixture, sub ] of fixtures) {
    const to = sub ? path.join(dir, sub) : dir;
    fs.mkdirSync(to, { recursive: true });
    for (const f of fs.readdirSync(path.join(FIX, fixture))) fs.copyFileSync(path.join(FIX, fixture, f), path.join(to, f));
  }

  return dir;
};

const snapshot = (dir) => {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = fs.statSync(p).size;
    }
  };
  walk(dir);
  return out;
};

const makeClient = (opts = {}) => {
  const listeners = {};
  const hooks = {};
  const posts = [];
  const events = [];
  const errors = [];
  const infos = [];
  const ref = { free: opts.free === undefined ? 1000 * GIB : opts.free, bundles: opts.bundles || {} };
  const socket = {
    // verbose is dropped by the real logger unless the extension runs with --debug: never written to output.log
    logger: { verbose() {}, info: (m) => infos.push(m), error: (m) => errors.push(m) },
    addListener: async (module, event, cb) => { listeners[event] = cb; },
    addHook: async (module, event, cb, info) => { hooks[event] = { cb, info }; },
    get: async (url) => {
      if (url === 'system/system_info') return { cid: 'MYCID' };
      if (url === 'queue/bundles/0/100000') return Object.values(ref.bundles);
      let m = /^queue\/bundles\/(\d+)$/.exec(url);
      if (m) {
        if (!ref.bundles[m[1]]) throw { message: 'Bundle not found', code: 404 };
        return JSON.parse(JSON.stringify(ref.bundles[m[1]]));
      }

      m = /^filelists\/(\w+)\/items\/(\d+)$/.exec(url);
      if (m && opts.items && opts.items[m[2]]) return opts.items[m[2]];
      throw new Error(`unexpected GET ${url}`);
    },
    post: async (url, body) => {
      posts.push([ url, body ]);
      if (url === 'events') { events.push(body); return undefined; }
      if (url === 'filesystem/disk_info') return body.paths.map((p) => ({ path: p, free_space: ref.free, total_space: 0 }));
      if (url === 'share/refresh/paths') return {};
      if (url === 'share/find_dupe_paths') return (opts.dupes && opts.dupes[body.path]) || [];
      if (/\/status_message$/.test(url)) return undefined;
      if (/^queue\/bundles\/\d+\/remove$/.test(url)) {
        if (opts.removeFails) throw { message: 'Internal error', code: 500 };
        return undefined;
      }
      throw new Error(`unexpected POST ${url}`);
    },
  };

  return { socket, listeners, hooks, posts, events, errors, infos, ref };
};

const setup = (overrides = {}, clientOpts = {}, dir = tmpDir('unpk-cfg-'), mainOpts = {}) => {
  settingValues = SettingDefinitions.reduce((r, d) => ({ ...r, [d.key]: d.default_value }), {});
  Object.assign(settingValues, { settle_seconds: 0 }, overrides);
  const client = makeClient(clientOpts);
  const recycled = [];
  const ext = { name: 'airdcpp-release-unpacker', configPath: dir + path.sep };
  const main = createMain(client.socket, ext, {
    recycle: async (paths) => { recycled.push(...paths); return paths.map((p) => ({ path: p, ok: true })); },
    ...mainOpts,
  });
  return { ...client, ext, main, recycled, configDir: dir };
};

const bundle = (id, dir, extra = {}) => ({
  id, name: path.basename(dir), target: dir + path.sep, type: { id: 'directory' },
  status: { id: 'completed', completed: true, downloaded: true, failed: false }, time_finished: 2_000_000_000, ...extra,
});

const texts = (events) => events.map((e) => e.text);
const workDirsIn = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith('.unpacking-'));

test('a finished download (event, then the settle wait) is unpacked next to its archives; archives untouched; share refreshed', async () => {
  const dir = makeRelease('Some.Movie.2019.1080p-GRP', [ [ 'rar4' ] ]);
  const before = snapshot(dir);
  const t = setup({}, { bundles: { 5: bundle(5, dir) } });
  await t.ext.onStart();
  t.listeners.queue_bundle_status(bundle(5, dir));
  await new Promise((r) => setTimeout(r, 50));
  await t.main.idle();
  t.ext.onStop();

  assert.ok(fs.readFileSync(path.join(dir, 'movie.mkv')).equals(payload()));
  assert.ok(fs.readFileSync(path.join(dir, 'movie.srt')).equals(payload(3000, 99)));
  assert.equal(fs.readFileSync(path.join(dir, 'movie.nfo'), 'utf8'), 'nfo text');
  // Every archive volume still there, unchanged
  const after = snapshot(dir);
  for (const [ name, size ] of Object.entries(before)) assert.equal(after[name], size, name);
  assert.deepEqual(workDirsIn(dir), []);
  assert.match(texts(t.events).join('\n'), /unpacked Some\.Movie\.2019\.1080p-GRP: rel\.rar, 3 file\(s\)/);
  assert.deepEqual(t.posts.find((p) => p[0] === 'share/refresh/paths')[1], { paths: [ dir + path.sep ] });
  assert.equal(t.recycled.length, 0);
});

test('a bundle that failed validation, a file bundle, or auto-unpack off: nothing happens', async () => {
  const dir = makeRelease('R', [ [ 'rar4' ] ]);
  const failed = bundle(1, dir, { status: { id: 'completion_validation_error', completed: false, downloaded: true, failed: true } });
  const file = bundle(2, dir, { type: { id: 'file' } });
  const t = setup({}, { bundles: { 1: failed, 2: file, 3: bundle(3, dir) } });
  await t.ext.onStart();
  await t.main.onBundleFinished(1);
  await t.main.onBundleFinished(2);
  settingValues.auto_unpack = false;
  await t.main.onBundleFinished(3);
  await t.main.idle();
  t.ext.onStop();
  assert.equal(fs.existsSync(path.join(dir, 'movie.mkv')), false);
  assert.equal(t.events.length, 0);
});

test('the same download reported twice is unpacked once', async () => {
  const dir = makeRelease('R', [ [ 'rar5' ] ]);
  const t = setup({}, { bundles: { 4: bundle(4, dir) } });
  await t.ext.onStart();
  await t.main.onBundleFinished(4);
  await t.main.idle();
  await t.main.onBundleFinished(4); // "completed", then "shared"
  await t.main.idle();
  t.ext.onStop();
  assert.equal(texts(t.events).filter((x) => /unpacked/.test(x)).length, 1);
  assert.equal(texts(t.events).filter((x) => /existed already|exists already/.test(x)).length, 0);
});

test('a stored set the media server plays already is left packed, silently when automatic, said when asked', async () => {
  const dir = makeRelease('Stored', [ [ 'rar5stored' ] ]);
  const t = setup({}, { bundles: { 1: bundle(1, dir) } });
  await t.ext.onStart();
  await t.main.onBundleFinished(1);
  await t.main.idle();
  assert.equal(fs.existsSync(path.join(dir, 'movie.mkv')), false);
  assert.equal(t.events.length, 0);

  t.main.enqueue({ dir, source: 'manual' });
  await t.main.idle();
  assert.match(texts(t.events).join('\n'), /already plays it/);
  assert.equal(fs.existsSync(path.join(dir, 'movie.mkv')), false);

  settingValues.unpack_stored = true;
  t.main.enqueue({ dir, source: 'manual' });
  await t.main.idle();
  t.ext.onStop();
  assert.ok(fs.readFileSync(path.join(dir, 'movie.mkv')).equals(payload()));
});

test('a quiet skip of an automatic unpack is still written to the extension log (output.log), not the event log', async () => {
  // Live test 2026-10-18: the stored set was skipped with no line anywhere; the README promises "only the extension log".
  const dir = makeRelease('StoredQuiet', [ [ 'rar5stored' ] ]);
  const t = setup({}, { bundles: { 1: bundle(1, dir) } });
  await t.ext.onStart();
  await t.main.onBundleFinished(1);
  await t.main.idle();
  t.ext.onStop();
  assert.equal(t.events.length, 0);
  assert.match(t.infos.join('\n'), /StoredQuiet.*not unpacked, the media server already plays it/);
});

test('password-protected sets are reported and left alone', async () => {
  const dir = makeRelease('Enc', [ [ 'encrypted' ], [ 'encheaders', 'CD2' ] ]);
  const t = setup({}, { bundles: { 1: bundle(1, dir) } });
  await t.ext.onStart();
  await t.main.onBundleFinished(1);
  await t.main.idle();
  t.ext.onStop();
  const all = texts(t.events).join('\n');
  assert.match(all, /(^|\n)airdcpp-release-unpacker: Enc: rel\.rar not unpacked, it is password protected/);
  assert.match(all, /Enc: CD2.rel\.rar not unpacked, it is password protected/);
  assert.doesNotMatch(all, /failed/);
  assert.equal(fs.existsSync(path.join(dir, 'movie.mkv')), false);
  assert.equal(fs.existsSync(path.join(dir, 'CD2', 'movie.mkv')), false);
});

test('a volume the SFV lists but the folder lacks: reported, nothing unpacked, no decoder run', async () => {
  const dir = makeRelease('Miss', [ [ 'missing' ] ]);
  const t = setup({}, { bundles: { 1: bundle(1, dir) } });
  await t.ext.onStart();
  await t.main.onBundleFinished(1);
  await t.main.idle();
  t.ext.onStop();
  assert.match(texts(t.events).join('\n'), /not unpacked, volumes are missing: rel\.r01/);
  assert.deepEqual(workDirsIn(dir), []);
  assert.equal(t.posts.filter((p) => p[0] === 'filesystem/disk_info').length, 0);
});

test('an existing file is never overwritten: it stays, the rest is unpacked, the archives are kept', async () => {
  const dir = makeRelease('Conflict', [ [ 'rar4' ] ]);
  fs.writeFileSync(path.join(dir, 'movie.srt'), 'my own subtitle');
  const t = setup({ delete_archives: true }, { bundles: { 1: bundle(1, dir) } });
  await t.ext.onStart();
  await t.main.onBundleFinished(1);
  await t.main.idle();
  t.ext.onStop();
  assert.equal(fs.readFileSync(path.join(dir, 'movie.srt'), 'utf8'), 'my own subtitle');
  assert.ok(fs.readFileSync(path.join(dir, 'movie.mkv')).equals(payload()));
  assert.match(texts(t.events).join('\n'), /1 file\(s\) existed already and were left alone: movie\.srt/);
  assert.equal(t.recycled.length, 0); // not every file of the set was unpacked: archives stay
});

test('not enough free space (needed + margin): nothing is created', async () => {
  const dir = makeRelease('Full', [ [ 'rar4' ] ]);
  const t = setup({ free_space_margin_gib: 2 }, { bundles: { 1: bundle(1, dir) }, free: 2 * GIB + 1000 });
  await t.ext.onStart();
  await t.main.onBundleFinished(1);
  await t.main.idle();
  t.ext.onStop();
  assert.match(texts(t.events).join('\n'), /not enough free space/);
  assert.equal(fs.existsSync(path.join(dir, 'movie.mkv')), false);
  assert.deepEqual(workDirsIn(dir), []);
});

test('the free space is asked for the output folder', async () => {
  const dir = makeRelease('Space', [ [ 'rar4' ] ]);
  const t = setup({}, { bundles: { 1: bundle(1, dir) } });
  await t.ext.onStart();
  await t.main.onBundleFinished(1);
  await t.main.idle();
  t.ext.onStop();
  assert.deepEqual(t.posts.find((p) => p[0] === 'filesystem/disk_info')[1], { paths: [ dir ] });
});

test('removing archives (opt-in): exactly the volumes of the unpacked set, the download out of the queue first', async () => {
  const dir = makeRelease('Del', [ [ 'rar4' ] ]);
  fs.writeFileSync(path.join(dir, 'keep.me.rar.txt'), 'x');
  const t = setup({ delete_archives: true }, { bundles: { 9: bundle(9, dir) } });
  await t.ext.onStart();
  await t.main.onBundleFinished(9);
  await t.main.idle();
  t.ext.onStop();
  assert.deepEqual(t.recycled.map((p) => path.basename(p)).sort(), [ 'rel.r00', 'rel.r01', 'rel.r02', 'rel.rar' ]);
  const removeAt = t.posts.findIndex((p) => p[0] === 'queue/bundles/9/remove');
  assert.ok(removeAt >= 0);
  assert.deepEqual(t.posts[removeAt][1], { remove_finished: false });
  assert.match(texts(t.events).join('\n'), /4 archive volume\(s\) moved to the Recycle Bin/);
});

test('removing archives: kept when the download cannot be taken out of the queue', async () => {
  const dir = makeRelease('Del2', [ [ 'rar4' ] ]);
  const t = setup({ delete_archives: true }, { bundles: { 9: bundle(9, dir) }, removeFails: true });
  await t.ext.onStart();
  await t.main.onBundleFinished(9);
  await t.main.idle();
  t.ext.onStop();
  assert.equal(t.recycled.length, 0);
  assert.match(texts(t.events).join('\n'), /archives kept/);
});

test('removing archives is off by default', async () => {
  const dir = makeRelease('Del3', [ [ 'rar4' ] ]);
  const t = setup({}, { bundles: { 9: bundle(9, dir) } });
  await t.ext.onStart();
  await t.main.onBundleFinished(9);
  await t.main.idle();
  t.ext.onStop();
  assert.equal(t.recycled.length, 0);
  assert.equal(t.posts.filter((p) => /\/remove$/.test(p[0])).length, 0);
});

test('a configured unpack folder: files go to <folder>\\<release>\\, the release folder gets nothing', async () => {
  const dir = makeRelease('Target.Rel', [ [ 'rar5' ], [ 'zip', 'CD2' ] ]);
  const before = snapshot(dir);
  const target = tmpDir('unpk-target-');
  const t = setup({ target_directory: target + path.sep }, { bundles: { 1: bundle(1, dir) } });
  await t.ext.onStart();
  await t.main.onBundleFinished(1);
  await t.main.idle();
  t.ext.onStop();
  assert.deepEqual(snapshot(dir), before);
  assert.ok(fs.readFileSync(path.join(target, 'Target.Rel', 'movie.mkv')).equals(payload()));
  assert.ok(fs.readFileSync(path.join(target, 'Target.Rel', 'CD2', 'movie.mkv')).equals(payload()));
  assert.deepEqual(t.posts.find((p) => p[0] === 'share/refresh/paths')[1], { paths: [ path.join(target, 'Target.Rel') + path.sep ] });
});

test('Sample folders are skipped unless asked; Proof always; sub folders like CD1 are unpacked in place', async () => {
  const dir = makeRelease('Subs.Rel', [ [ 'rar4', 'CD1' ], [ 'zip', 'Sample' ], [ 'sevenzip', 'Proof' ] ]);
  const t = setup({}, { bundles: { 1: bundle(1, dir) } });
  await t.ext.onStart();
  await t.main.onBundleFinished(1);
  await t.main.idle();
  assert.ok(fs.existsSync(path.join(dir, 'CD1', 'movie.mkv')));
  assert.equal(fs.existsSync(path.join(dir, 'Sample', 'movie.mkv')), false);
  assert.equal(fs.existsSync(path.join(dir, 'Proof', 'movie.mkv')), false);

  settingValues.include_samples = true;
  t.main.enqueue({ dir, source: 'manual' });
  await t.main.idle();
  t.ext.onStop();
  assert.ok(fs.existsSync(path.join(dir, 'Sample', 'movie.mkv')));
  assert.equal(fs.existsSync(path.join(dir, 'Proof', 'movie.mkv')), false);
});

test('an excluded folder is not touched', async () => {
  const dir = makeRelease('Some.XXX.Release', [ [ 'rar4' ] ]);
  const t = setup({ exclude_patterns: '*.xxx.*' }, { bundles: { 1: bundle(1, dir) } });
  await t.ext.onStart();
  await t.main.onBundleFinished(1);
  await t.main.idle();
  t.ext.onStop();
  assert.equal(fs.existsSync(path.join(dir, 'movie.mkv')), false);
});

test('old release of zips holding RAR volumes: the film comes out, the inner volumes do not', async () => {
  const dir = makeRelease('Old.Rel', [ [ 'nested' ] ]);
  const t = setup({}, { bundles: { 1: bundle(1, dir) } });
  await t.ext.onStart();
  await t.main.onBundleFinished(1);
  await t.main.idle();
  assert.ok(fs.readFileSync(path.join(dir, 'movie.mkv')).equals(payload()));
  assert.deepEqual(fs.readdirSync(dir).filter((n) => /^inner\./.test(n)), []);
  assert.deepEqual(workDirsIn(dir), []);

  // Off: the zips' contents (the inner volumes) are what comes out
  const dir2 = makeRelease('Old.Rel2', [ [ 'nested' ] ]);
  settingValues.nested_archives = false;
  settingValues.media_only = false;
  t.main.enqueue({ dir: dir2, source: 'manual' });
  await t.main.idle();
  t.ext.onStop();
  assert.equal(fs.existsSync(path.join(dir2, 'movie.mkv')), false);
  assert.ok(fs.existsSync(path.join(dir2, 'inner.rar')));
});

test('a damaged archive: failure reported, nothing of it kept, the temporary folder removed', async () => {
  const dir = makeRelease('Bad', [ [ 'rar5' ] ]);
  const victim = path.join(dir, 'rel.part2.rar');
  const b = fs.readFileSync(victim);
  b[10000] ^= 0x55;
  fs.writeFileSync(victim, b);
  const t = setup({}, { bundles: { 1: bundle(1, dir) } });
  await t.ext.onStart();
  await t.main.onBundleFinished(1);
  await t.main.idle();
  t.ext.onStop();
  assert.match(texts(t.events).join('\n'), /unpacking rel\.part1\.rar failed, it is damaged.*nothing of it was kept/);
  assert.equal(t.events.find((e) => /failed/.test(e.text)).severity, 'error');
  assert.equal(fs.existsSync(path.join(dir, 'movie.mkv')), false);
  assert.deepEqual(workDirsIn(dir), []);
});

test('killed mid-unpack: the next start removes ITS temporary folder (only that one) and unpacks again', async () => {
  const dir = makeRelease('Killed', [ [ 'rar4' ] ]);
  const cfg = tmpDir('unpk-cfg-');
  // The state a kill leaves: an active job with a recorded temporary folder holding a partial file
  const ours = path.join(dir, '.unpacking-7-1');
  fs.mkdirSync(ours);
  fs.writeFileSync(path.join(ours, 'movie.mkv'), 'half');
  // Recorded by mistake: a folder named like ours but of another job, and a user folder
  const foreign = path.join(dir, '.unpacking-8-1');
  fs.mkdirSync(foreign);
  const userDir = path.join(dir, 'My.Stuff');
  fs.mkdirSync(userDir);
  fs.writeFileSync(path.join(userDir, 'keep.txt'), 'x');
  fs.writeFileSync(path.join(cfg, 'unpack-state.json'), JSON.stringify({
    version: 1, queue: [], handled: {}, lastSeen: 0, nextId: 8,
    active: { id: 7, dir, name: 'Killed', source: 'manual', bundleId: null, addedAt: 1, workDirs: [ ours, userDir, foreign ], committed: [] },
  }));

  const t = setup({}, {}, cfg);
  await t.ext.onStart();
  await t.main.idle();
  t.ext.onStop();
  assert.equal(fs.existsSync(ours), false);
  assert.equal(fs.existsSync(foreign), true);
  assert.equal(fs.readFileSync(path.join(userDir, 'keep.txt'), 'utf8'), 'x');
  assert.ok(fs.readFileSync(path.join(dir, 'movie.mkv')).equals(payload()));
  assert.match(texts(t.events).join('\n'), /unpacked Killed/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cfg, 'unpack-state.json'), 'utf8')).active, null);
});

test('killed while moving files in: the ones already moved count as done, not as "existed already"', async () => {
  const dir = makeRelease('Half.Moved', [ [ 'rar4' ] ]);
  const cfg = tmpDir('unpk-cfg-');
  fs.writeFileSync(path.join(dir, 'movie.mkv'), payload()); // moved in before the kill
  fs.writeFileSync(path.join(cfg, 'unpack-state.json'), JSON.stringify({
    version: 1, queue: [], handled: {}, lastSeen: 0, nextId: 3,
    active: { id: 2, dir, name: 'Half.Moved', source: 'manual', bundleId: null, addedAt: 1, workDirs: [], committed: [ path.join(dir, 'movie.mkv') ] },
  }));
  const t = setup({}, {}, cfg);
  await t.ext.onStart();
  await t.main.idle();
  t.ext.onStop();
  assert.ok(fs.existsSync(path.join(dir, 'movie.srt')));
  assert.doesNotMatch(texts(t.events).join('\n'), /existed already/);
});

test('every temporary folder is in the state file before it exists', async () => {
  const dir = makeRelease('Order', [ [ 'rar4' ] ]);
  const t = setup({}, { bundles: { 1: bundle(1, dir) } });
  const realMkdir = fs.mkdirSync;
  const seen = [];
  fs.mkdirSync = function (p, o) {
    if (path.basename(String(p)).startsWith('.unpacking-')) {
      const state = JSON.parse(fs.readFileSync(path.join(t.configDir, 'unpack-state.json'), 'utf8'));
      seen.push(state.active && state.active.workDirs.includes(p));
    }
    return realMkdir.call(this, p, o);
  };
  try {
    await t.ext.onStart();
    await t.main.onBundleFinished(1);
    await t.main.idle();
  } finally {
    fs.mkdirSync = realMkdir;
    t.ext.onStop();
  }
  assert.deepEqual(seen, [ true ]);
});

test('/unpack: queues a folder, answers in the chat it was typed in, prefixed; status; bad paths refused', async () => {
  const dir = makeRelease('Chat.Rel', [ [ 'zip' ] ]);
  const t = setup({ auto_unpack: false });
  await t.ext.onStart();
  await t.listeners.hub_text_command({ command: 'unpack', args: dir.split(' '), owner: 'o1' }, 3);
  await t.main.idle();
  await t.listeners.private_chat_text_command({ command: 'unpack', args: [] }, 'CID1');
  await t.listeners.hub_text_command({ command: 'unpack', args: [ 'relative\\path' ] }, 3);
  await t.listeners.hub_text_command({ command: 'help', args: [] }, 3);
  t.ext.onStop();
  const replies = t.posts.filter((p) => /status_message$/.test(p[0]));
  assert.equal(replies[0][0], 'hubs/3/status_message');
  assert.equal(replies[0][1].owner, 'o1');
  assert.match(replies[0][1].text, /^\[unpack\] queued Chat\.Rel/);
  assert.equal(replies[1][0], 'private_chat/CID1/status_message');
  assert.equal(replies[1][1].text, '[unpack] nothing queued');
  assert.match(replies[2][1].text, /^\[unpack\] give the full path/);
  assert.match(replies[3][1].text, /^\/unpack <folder>/);
  assert.ok(replies.every((r) => r[1].text.startsWith('[unpack]') || r[1].text.startsWith('/unpack')));
  assert.ok(fs.existsSync(path.join(dir, 'movie.mkv')));
});

test('menus: answered at once; queue bundle and own-share folder are unpacked; another user\'s list is refused', async () => {
  const dir = makeRelease('Menu.Rel', [ [ 'rar4' ] ]);
  const dir2 = makeRelease('Own.Share.Rel', [ [ 'zip' ] ]);
  const t = setup({ auto_unpack: false }, {
    bundles: { 11: bundle(11, dir) },
    items: { 77: { id: 77, name: 'Own.Share.Rel', path: '/Movies/Own.Share.Rel/', type: { id: 'directory' } } },
    dupes: { '/Movies/Own.Share.Rel/': [ dir2 + path.sep ] },
  });
  await t.ext.onStart();

  const answered = [];
  t.hooks.queue_bundle_list_menuitems.cb({ selected_ids: [ 11 ] }, (r) => answered.push(r));
  t.hooks.filelist_item_list_menuitems.cb({ selected_ids: [ 77 ], entity_id: 'MYCID' }, (r) => answered.push(r));
  t.hooks.filelist_item_list_menuitems.cb({ selected_ids: [ 77 ], entity_id: 'OTHERCID' }, (r) => answered.push(r));
  assert.deepEqual(answered.map((a) => a.menuitems.length), [ 1, 1, 0 ]);
  assert.equal(t.hooks.queue_bundle_list_menuitems.info.id, 'airdcpp-release-unpacker');

  t.listeners.queue_bundle_menuitem_selected({ hook_id: 'airdcpp-release-unpacker', menuitem_id: 'unpack_release', selected_ids: [ 11 ] });
  t.listeners.filelist_item_menuitem_selected({ hook_id: 'airdcpp-release-unpacker', menuitem_id: 'unpack_release', selected_ids: [ 77 ], entity_id: 'MYCID' });
  t.listeners.filelist_item_menuitem_selected({ hook_id: 'airdcpp-release-unpacker', menuitem_id: 'unpack_release', selected_ids: [ 77 ], entity_id: 'OTHERCID' });
  // Someone else's menu item: ignored
  t.listeners.queue_bundle_menuitem_selected({ hook_id: 'other-ext', menuitem_id: 'unpack_release', selected_ids: [ 11 ] });
  await new Promise((r) => setTimeout(r, 20));
  await t.main.idle();
  t.ext.onStop();
  assert.ok(fs.existsSync(path.join(dir, 'movie.mkv')));
  assert.ok(fs.existsSync(path.join(dir2, 'movie.mkv')));
  assert.match(texts(t.events).join('\n'), /own share's file list only/);
  assert.equal(texts(t.events).filter((x) => /unpacked Menu\.Rel/.test(x)).length, 1);
});

test('catching up: never on the first run; later, downloads that finished while it was not running', async () => {
  const cfg = tmpDir('unpk-cfg-');
  const dir = makeRelease('Old.Done', [ [ 'rar4' ] ]);
  const dir2 = makeRelease('New.Done', [ [ 'rar5' ] ]);
  const first = setup({}, { bundles: { 1: bundle(1, dir, { time_finished: 900_000_000 }) } }, cfg);
  await first.ext.onStart();
  await new Promise((r) => setTimeout(r, 30));
  await first.main.idle();
  first.ext.onStop();
  assert.equal(fs.existsSync(path.join(dir, 'movie.mkv')), false);

  const lastSeen = JSON.parse(fs.readFileSync(path.join(cfg, 'unpack-state.json'), 'utf8')).lastSeen;
  const second = setup({}, { bundles: {
    1: bundle(1, dir, { time_finished: lastSeen - 100 }),
    2: bundle(2, dir2, { time_finished: lastSeen + 5 }),
  } }, cfg);
  await second.ext.onStart();
  await new Promise((r) => setTimeout(r, 30));
  await second.main.idle();
  second.ext.onStop();
  assert.equal(fs.existsSync(path.join(dir, 'movie.mkv')), false);
  assert.ok(fs.existsSync(path.join(dir2, 'movie.mkv')));
});

test('a corrupt state file starts empty instead of crashing', async () => {
  const cfg = tmpDir('unpk-cfg-');
  fs.writeFileSync(path.join(cfg, 'unpack-state.json'), '{not json');
  const t = setup({}, {}, cfg);
  await t.ext.onStart();
  t.ext.onStop();
  assert.deepEqual(t.main.getState().queue, []);
});

test('the unpack folder inside the release itself is refused', async () => {
  const dir = makeRelease('Loop', [ [ 'rar4' ] ]);
  const t = setup({ target_directory: path.join(dir, 'out') });
  await t.ext.onStart();
  t.main.enqueue({ dir, source: 'manual' });
  await t.main.idle();
  t.ext.onStop();
  assert.match(texts(t.events).join('\n'), /inside this release/);
  assert.equal(fs.existsSync(path.join(dir, 'out')), false);
});

test('a drive root is refused; a folder with more archive sets than one release has is not unpacked', async () => {
  const t = setup({ auto_unpack: false });
  await t.ext.onStart();
  assert.equal(t.main.enqueue({ dir: path.parse(os.tmpdir()).root, source: 'manual' }).added, false);
  assert.deepEqual(t.main.enqueue({ dir: '\\\\server\\share\\', source: 'manual' }), { added: false, why: 'a whole drive is not a release folder' });
  const root = tmpDir();
  const many = path.join(root, 'Everything');
  for (let i = 0; i < 61; i++) makeRelease(`Rel${i}`, [ [ 'zip' ] ], many);
  t.main.enqueue({ dir: many, source: 'manual' });
  await t.main.idle();
  t.ext.onStop();
  assert.match(texts(t.events).join('\n'), /61 archive sets in one folder; not unpacked/);
  assert.equal(fs.existsSync(path.join(many, 'Rel0', 'movie.mkv')), false);
});

test('a release that was interrupted three times is given up instead of blocking the queue', async () => {
  const dir = makeRelease('Poison', [ [ 'rar4' ] ]);
  const cfg = tmpDir('unpk-cfg-');
  fs.writeFileSync(path.join(cfg, 'unpack-state.json'), JSON.stringify({
    version: 1, queue: [], handled: {}, lastSeen: 0, nextId: 2,
    active: { id: 1, dir, name: 'Poison', source: 'manual', bundleId: null, addedAt: 1, workDirs: [], committed: [], attempts: 3 },
  }));
  const t = setup({}, {}, cfg);
  await t.ext.onStart();
  await t.main.idle();
  t.ext.onStop();
  assert.match(texts(t.events).join('\n'), /Poison: given up after 3 interrupted attempts/);
  assert.equal(fs.existsSync(path.join(dir, 'movie.mkv')), false);
  assert.equal(t.main.getState().active, null);
  assert.deepEqual(t.main.getState().queue, []);
});

test('removing archives of a folder queued by hand: its finished download leaves the queue first; one still downloading keeps them', async () => {
  const dir = makeRelease('ByHand', [ [ 'rar4' ] ]);
  const t = setup({ delete_archives: true, auto_unpack: false }, { bundles: { 21: bundle(21, dir) } });
  await t.ext.onStart();
  t.main.enqueue({ dir, source: 'manual' });
  await t.main.idle();
  assert.ok(t.posts.some((p) => p[0] === 'queue/bundles/21/remove'));
  assert.equal(t.recycled.length, 4);

  const dir2 = makeRelease('StillLoading', [ [ 'rar5' ] ]);
  t.ref.bundles[22] = bundle(22, dir2, { status: { id: 'queued', completed: false, downloaded: false, failed: false } });
  t.main.enqueue({ dir: dir2, source: 'manual' });
  await t.main.idle();
  t.ext.onStop();
  assert.equal(t.posts.some((p) => p[0] === 'queue/bundles/22/remove'), false);
  assert.equal(t.recycled.length, 4);
  assert.match(texts(t.events).join('\n'), /StillLoading: archives kept, it is still downloading/);
});

test('the LAST volume missing, which only the SFV shows: reported before any decoder runs', async () => {
  const dir = makeRelease('Last.Missing', [ [ 'rar4' ] ]);
  fs.unlinkSync(path.join(dir, 'rel.r02'));
  const t = setup({}, { bundles: { 1: bundle(1, dir) } });
  await t.ext.onStart();
  await t.main.onBundleFinished(1);
  await t.main.idle();
  t.ext.onStop();
  assert.match(texts(t.events).join('\n'), /not unpacked, volumes are missing: rel\.r02/);
  assert.equal(t.posts.filter((p) => p[0] === 'filesystem/disk_info').length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'movie.mkv')), false);
});

// ---------------------------------------------------------------------------------------------
// Review 2026-10-18

test('removing archives: a download that went back to downloading during the unpack keeps its archives and stays queued', async () => {
  // More files added to a finished download's folder put it back in the queue; removing it
  // then would delete the partial files of those (QueueManager::removeBundle)
  const dir = makeRelease('Requeued', [ [ 'rar4' ] ]);
  const t = setup({ delete_archives: true }, { bundles: { 9: bundle(9, dir) } });
  const basePost = t.socket.post;
  t.socket.post = async (url, body) => {
    if (url === 'filesystem/disk_info') t.ref.bundles[9].status = { id: 'queued', completed: false, downloaded: false, failed: false };
    return basePost(url, body);
  };
  await t.ext.onStart();
  await t.main.onBundleFinished(9);
  await t.main.idle();
  t.ext.onStop();
  assert.ok(fs.existsSync(path.join(dir, 'movie.mkv')));
  assert.equal(t.posts.some((p) => p[0] === 'queue/bundles/9/remove'), false);
  assert.equal(t.recycled.length, 0);
  assert.match(texts(t.events).join('\n'), /Requeued: archives kept, it is still downloading/);
});

test('removing archives: a recheck running on the download keeps them', async () => {
  const dir = makeRelease('Recheck', [ [ 'rar4' ] ]);
  const t = setup({ delete_archives: true }, { bundles: { 9: bundle(9, dir) } });
  const basePost = t.socket.post;
  t.socket.post = async (url, body) => {
    if (url === 'filesystem/disk_info') t.ref.bundles[9].status = { id: 'recheck', completed: false, downloaded: false, failed: false };
    return basePost(url, body);
  };
  await t.ext.onStart();
  await t.main.onBundleFinished(9);
  await t.main.idle();
  t.ext.onStop();
  assert.equal(t.posts.some((p) => /\/remove$/.test(p[0])), false);
  assert.equal(t.recycled.length, 0);
});

test('removing archives of a folder inside a bigger download: kept while that download runs; taken out of the queue when finished', async () => {
  const root = tmpDir();
  const dir = makeRelease('Inner.Rel', [ [ 'rar4' ] ], root);
  const parent = { ...bundle(40, root), status: { id: 'queued', completed: false, downloaded: false, failed: false } };
  const t = setup({ delete_archives: true, auto_unpack: false }, { bundles: { 40: parent } });
  await t.ext.onStart();
  t.main.enqueue({ dir, source: 'manual' });
  await t.main.idle();
  assert.equal(t.posts.some((p) => /\/remove$/.test(p[0])), false);
  assert.equal(t.recycled.length, 0);
  assert.match(texts(t.events).join('\n'), /Inner\.Rel: archives kept, it is still downloading/);

  // Finished now: out of the queue first, then the volumes
  const dir2 = makeRelease('Inner.Rel2', [ [ 'rar4' ] ], root);
  t.ref.bundles[40] = bundle(40, root);
  t.main.enqueue({ dir: dir2, source: 'manual' });
  await t.main.idle();
  t.ext.onStop();
  assert.ok(t.posts.some((p) => p[0] === 'queue/bundles/40/remove'));
  assert.equal(t.recycled.length, 4);
});

test('a decoder that never finishes is ended at the timeout; the queue goes on', async () => {
  const dirA = makeRelease('Hangs', [ [ 'rar4' ] ]);
  const dirB = makeRelease('Next', [ [ 'zip' ] ]);
  const t = setup({ auto_unpack: false }, {}, undefined, {
    workerFile: path.join(FIX, 'hang-worker.js'), vendor: {}, timeoutOf: () => 300,
  });
  await t.ext.onStart();
  try {
    t.main.enqueue({ dir: dirA, source: 'manual' });
    t.main.enqueue({ dir: dirB, source: 'manual' });
    const outcome = await Promise.race([
      t.main.idle().then(() => 'idle'),
      new Promise((resolve) => setTimeout(() => resolve('still busy after 8 s'), 8000).unref()),
    ]);
    assert.equal(outcome, 'idle');
    const all = texts(t.events).join('\n');
    assert.match(all, /Hangs: rel\.rar not unpacked, the decoder did not finish/);
    assert.match(all, /Next: rel\.zip not unpacked, the decoder did not finish/);
    assert.equal(t.main.getState().active, null);
  } finally {
    t.ext.onStop();
  }
});

test('a decoder thread that dies on its own fails that set only; the other sets of the release are unpacked', async () => {
  const dir = makeRelease('Crashy', [ [ 'rar4' ], [ 'zip', 'CD2' ] ]);
  const t = setup({ auto_unpack: false }, {}, undefined, { workerFile: path.join(FIX, 'crash-worker.js') });
  await t.ext.onStart();
  t.main.enqueue({ dir, source: 'manual' });
  await t.main.idle();
  t.ext.onStop();
  assert.ok(fs.readFileSync(path.join(dir, 'CD2', 'movie.mkv')).equals(payload()));
  assert.match(texts(t.events).join('\n'), /unpacked Crashy: CD2/);
  assert.equal(fs.existsSync(path.join(dir, 'movie.mkv')), false);
});

test('a drive without hard links (FAT, exFAT, some network shares): files still go in by rename, an existing one is still left alone', async () => {
  const dir = makeRelease('No.Links', [ [ 'rar4' ] ]);
  fs.writeFileSync(path.join(dir, 'movie.srt'), 'mine');
  const realLink = fs.linkSync;
  fs.linkSync = () => { const e = new Error('EPERM: operation not permitted, link'); e.code = 'EPERM'; throw e; };
  try {
    const t = setup({ auto_unpack: false });
    await t.ext.onStart();
    t.main.enqueue({ dir, source: 'manual' });
    await t.main.idle();
    t.ext.onStop();
    assert.ok(fs.readFileSync(path.join(dir, 'movie.mkv')).equals(payload()));
    assert.equal(fs.readFileSync(path.join(dir, 'movie.srt'), 'utf8'), 'mine');
    assert.deepEqual(workDirsIn(dir), []);
  } finally {
    fs.linkSync = realLink;
  }
});
