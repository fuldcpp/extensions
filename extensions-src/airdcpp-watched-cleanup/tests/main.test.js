'use strict';

// Drives main.js against a fake client: a fake Web API socket whose share listing mirrors a real
// temporary folder (ids computed the way the core does it: one hash of the lower-cased path, a
// folder's path ending in a separator), a fake media server (per-account watched state), and a
// fake Recycle Bin. Nothing here touches the real Recycle Bin.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { SettingDefinitions } = require('../src/settings');

const settingsPath = require.resolve('airdcpp-extension-settings');
let settingValues;
require.cache[settingsPath] = {
  id: settingsPath, filename: settingsPath, loaded: true,
  exports: () => ({ load: async () => {}, getValue: (key) => settingValues[key], set onValuesUpdated(cb) {} }),
};

const createMain = require('../src/main.js');

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-10-18T12:00:00Z');
const ago = (d) => new Date(NOW - d * DAY).toISOString();

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const toBase32 = (buf) => {
  let bits = 0; let value = 0; let out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
};
const hashOf = (p) => crypto.createHash('sha256').update(p.toLowerCase()).digest().subarray(0, 24);
const idOf = (p) => hashOf(p).subarray(0, 16).toString('hex');
const b32Of = (p) => toBase32(hashOf(p));
const asDir = (p) => (p.endsWith('\\') ? p : `${p}\\`);

const mk = (file, size = 1000) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(size));
  return file;
};

// The library on disk, and what the media server says about it
const world = () => {
  const root = asDir(fs.mkdtempSync(path.join(os.tmpdir(), 'wcl-')));
  const f = {
    film: mk(path.join(root, 'Films', 'Old.Film.2019-GRP', 'old.film.2019.mkv'), 5000),
    nfo: mk(path.join(root, 'Films', 'Old.Film.2019-GRP', 'old.film.2019.nfo'), 10),
    sample: mk(path.join(root, 'Films', 'Old.Film.2019-GRP', 'Sample', 'old-sample.mkv'), 100),
    e1: mk(path.join(root, 'Shows', 'Show', 'S01', 'Show.S01E01.mkv'), 3000),
    e1srt: mk(path.join(root, 'Shows', 'Show', 'S01', 'Show.S01E01.en.srt'), 10),
    e2: mk(path.join(root, 'Shows', 'Show', 'S01', 'Show.S01E02.mkv'), 3000),
    queued: mk(path.join(root, 'Films', 'Queued.Film', 'queued.mkv'), 2000),
    classic: mk(path.join(root, 'Keep', 'Classic', 'classic.mkv'), 2000),
    rec: mk(path.join(root, 'Rec', 'News 20261001 1a2b3c.ts'), 2000),
    fresh: mk(path.join(root, 'Films', 'Fresh', 'fresh.mkv'), 2000),
  };
  const item = (file, extra) => ({ Id: idOf(file), Name: path.basename(file), DateCreated: ago(300), ...extra });
  const items = {
    film: item(f.film, { Type: 'Movie', lib: 'lm' }),
    e1: item(f.e1, { Type: 'Episode', SeriesId: 'ser1', SeriesName: 'Show', ParentIndexNumber: 1, IndexNumber: 1, lib: 'lt' }),
    e2: item(f.e2, { Type: 'Episode', SeriesId: 'ser1', SeriesName: 'Show', ParentIndexNumber: 1, IndexNumber: 2, lib: 'lt' }),
    queued: item(f.queued, { Type: 'Movie', lib: 'lm' }),
    classic: item(f.classic, { Type: 'Movie', lib: 'lm' }),
    rec: item(f.rec, { Type: 'Movie', lib: 'lm' }),
    fresh: item(f.fresh, { Type: 'Movie', lib: 'lm' }),
  };
  const pathOfItem = Object.fromEntries(Object.keys(items).map((k) => [ items[k].Id, f[k] ]));
  return { root, f, items, pathOfItem };
};

const watched = (days = 60, extra = {}) => ({ Played: true, PlayCount: 1, LastPlayedDate: ago(days), IsFavorite: false, PlaybackPositionTicks: 0, ...extra });

const fakeServer = (w, accounts, { users, collections = {} } = {}) => {
  const calls = [];
  const res = (status, body) => ({ ok: status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push(`${init.method} ${u.pathname}${u.search}`);
    assert.equal(u.host, '127.0.0.1:8096');
    if (u.pathname === '/Users/AuthenticateByName') {
      const body = JSON.parse(init.body);
      const acc = accounts.find((a) => a.name === body.Username && a.password === body.Pw);
      return acc ? res(200, { AccessToken: `tok-${acc.name}` }) : res(401);
    }

    const acc = accounts.find((a) => `tok-${a.name}` === init.headers['X-Emby-Token']);
    if (!acc) return res(401);
    const q = Object.fromEntries(u.searchParams);
    if (u.pathname === '/Users/Me') return res(200, { Id: acc.id, Name: acc.name });
    if (u.pathname === '/Users') return res(200, users || accounts.map((a) => ({ Id: a.id, Name: a.name, Policy: { IsDisabled: false } })));
    if (u.pathname === `/Users/${acc.id}/Views`) return res(200, { Items: [ { Id: 'lm', CollectionType: 'movies' }, { Id: 'lt', CollectionType: 'tvshows' }, { Id: 'lx', CollectionType: 'music' } ] });
    if (u.pathname === `/Users/${acc.id}/Items`) {
      if (!q.ParentId) return res(200, { Items: [ { Id: 'lm' }, { Id: 'lt' }, { Id: idOf(w.root) } ], TotalRecordCount: 3 });
      const types = q.IncludeItemTypes.split(',');
      const list = Object.values(w.items).filter((i) => i.lib === q.ParentId && types.includes(i.Type)).map((i) => ({ ...i, UserData: acc.state[i.Id] || { Played: false } }))
        .filter((i) => (q.Filters === 'IsPlayed' ? i.UserData.Played : q.Filters === 'IsResumable' ? i.UserData.PlaybackPositionTicks > 0 : i.UserData.IsFavorite));
      return res(200, { Items: list, TotalRecordCount: list.length });
    }

    let m = /^\/Items\/([0-9a-f]+)\/Ancestors$/.exec(u.pathname);
    if (m) {
      const file = w.pathOfItem[m[1]];
      const chain = [];
      for (let dir = asDir(path.dirname(file)); ; dir = asDir(path.dirname(dir.slice(0, -1)))) {
        chain.push({ Id: idOf(dir), Type: 'Folder' });
        if (dir.toLowerCase() === w.root.toLowerCase()) break;
      }
      return res(200, chain);
    }

    m = /^\/Items\/([0-9a-f]+)\/Collections$/.exec(u.pathname);
    if (m) return res(200, { Items: (collections[m[1]] || []).map((Name) => ({ Name })) });
    return res(404);
  };
  return { fetchImpl, calls };
};

const fakeSocket = (w, { queued = new Set() } = {}) => {
  const listeners = {};
  const posts = [];
  const errors = [];
  const socket = {
    logger: { verbose() {}, info() {}, error: (m) => errors.push(m) },
    addListener: async (module, event, cb) => { listeners[event] = cb; },
    get: async (url) => {
      if (url === 'media_server') return { enabled: true, running: true, address: 'http://0.0.0.0:8096', port: 8096 };
      if (url === 'share_roots') return [ { path: w.root, virtual_name: 'Media' } ];
      throw new Error(`unexpected GET ${url}`);
    },
    post: async (url, body) => {
      posts.push([ url, body ]);
      if (url === 'share/directories/by_real') return { id: b32Of(body.path), path: body.path };
      if (url.startsWith('share/directories/by_real/content/')) {
        const [ start, count ] = url.split('/').slice(-2).map(Number);
        const all = fs.readdirSync(body.path, { withFileTypes: true }).map((d) => {
          const p = d.isDirectory() ? asDir(path.join(body.path, d.name)) : path.join(body.path, d.name);
          return { id: b32Of(p), path: p, name: d.name, size: d.isDirectory() ? 0 : fs.statSync(p).size, type: { id: d.isDirectory() ? 'directory' : 'file' } };
        });
        if (all.length > 0 && start >= all.length) throw new Error('Invalid range');
        return all.slice(start, start + count);
      }
      if (url === 'queue/check_path_queued') return { bundle: queued.has(body.path.toLowerCase()) ? { id: 1, completed: false } : null };
      return undefined;
    },
  };
  return { socket, posts, errors, emit: (event, data, id) => listeners[event](data, id) };
};

const fakeRecycler = ({ fail = new Set() } = {}) => {
  const calls = [];
  return {
    calls,
    recycle: async (items) => {
      calls.push(items);
      return items.map((i) => (fail.has(i.path) ? { path: i.path, ok: false, reason: 'in use', in_bin: false } : { path: i.path, ok: true, reason: '', in_bin: true }));
    },
  };
};

const setup = ({ overrides = {}, accounts, users, queued, collections, fail } = {}) => {
  settingValues = SettingDefinitions.reduce((r, d) => ({ ...r, [d.key]: d.default_value }), {});
  const w = world();
  Object.assign(settingValues, { server_user: 'me', server_password: 'pw', keep_folders: [ path.join(w.root, 'Keep') ] }, overrides);
  const allWatched = {
    [w.items.film.Id]: watched(), [w.items.e1.Id]: watched(), [w.items.e2.Id]: watched(), [w.items.queued.Id]: watched(),
    [w.items.classic.Id]: watched(), [w.items.rec.Id]: watched(), [w.items.fresh.Id]: watched(3),
  };
  const accs = (accounts || [ { name: 'me', password: 'pw', id: 'u1' } ]).map((a) => ({ state: allWatched, ...a, state: a.state ? a.state(w, allWatched) : allWatched }));
  const server = fakeServer(w, accs, { users, collections: collections ? collections(w) : {} });
  const client = fakeSocket(w, { queued: new Set((queued ? queued(w) : [ w.f.queued ]).map((p) => p.toLowerCase())) });
  const recycler = fakeRecycler({ fail: new Set(fail ? fail(w) : []) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcc-'));
  const ext = { name: 'airdcpp-watched-cleanup', configPath: dir + path.sep };
  const main = createMain(client.socket, ext, { now: () => NOW, fetchImpl: server.fetchImpl, recycler });
  return { w, server, client, recycler, dir, ext, main };
};

const primary = (calls) => calls.filter((c) => c[0].is_dir || c[0].size > 0);
const statusLines = (posts) => posts.filter((p) => p[0].endsWith('/status_message')).map((p) => p[1].text);

test('list: the watched film goes as its folder, the old episode with its subtitle; everything else is left alone for its reason', async () => {
  const t = setup();
  const result = await t.main.survey();
  const planned = Object.fromEntries(result.planned.map((p) => [ p.item.Id, p ]));
  assert.deepEqual(Object.keys(planned).sort(), [ t.w.items.film.Id, t.w.items.e1.Id ].sort());
  assert.equal(planned[t.w.items.film.Id].kind, 'folder');
  assert.deepEqual(planned[t.w.items.film.Id].paths, [ path.dirname(t.w.f.film) ]);
  assert.equal(planned[t.w.items.film.Id].bytes, 5110);
  assert.deepEqual(planned[t.w.items.e1.Id].paths, [ t.w.f.e1, t.w.f.e1srt ]);

  const reasons = Object.fromEntries(result.skipped.map((s) => [ s.item.Id, s.reason ]));
  assert.equal(reasons[t.w.items.classic.Id], 'in a keep-forever folder');
  assert.equal(reasons[t.w.items.queued.Id], 'in the download queue');
  assert.equal(reasons[t.w.items.rec.Id], 'a recording (the client manages those)');
  assert.equal(reasons[t.w.items.fresh.Id], undefined); // not even a candidate: watched 3 days ago
  assert.equal(t.recycler.calls.length, 0);

  const report = fs.readFileSync(path.join(t.dir, 'watched-cleanup-report.md'), 'utf8');
  assert.match(report, /## 2 item\(s\)/);
  assert.match(report, /old\.film\.2019-GRP.*\(folder\)/i);
  assert.match(report, /watched recently: 1/);
  assert.match(report, /one of the last watched episodes: 1/);
});

test('/cleanup list answers in local status lines, each tagged, and moves nothing', async () => {
  const t = setup();
  await t.ext.onStart();
  t.ext.onStop();
  await t.client.emit('hub_text_command', { command: 'cleanup', args: [ 'list' ], owner: 'o1' }, 5);
  const lines = statusLines(t.client.posts);
  assert.ok(lines.length >= 3);
  assert.ok(lines.every((l) => l.startsWith('[cleanup] ')), lines.join('\n'));
  assert.match(lines[0], /Could be moved to the Recycle Bin: 2 item\(s\)/);
  assert.ok(t.client.posts.filter((p) => p[0].endsWith('/status_message')).every((p) => p[0] === 'hubs/5/status_message' && p[1].owner === 'o1'));
  assert.equal(t.recycler.calls.length, 0);
  assert.ok(!t.client.posts.some((p) => p[0] === 'share/refresh/paths'));
});

test('/cleanup run: dry run listed first, then recycled, then the share refreshed', async () => {
  const t = setup();
  await t.ext.onStart();
  t.ext.onStop();
  await t.client.emit('private_chat_text_command', { command: 'cleanup', args: [ 'run' ] }, 'CID');
  const lines = statusLines(t.client.posts);
  assert.match(lines[0], /Dry run first: 2 item\(s\)/);
  assert.match(lines[lines.length - 1], /Moved 2 item\(s\)/);
  const moved = t.recycler.calls.map((c) => c.map((i) => i.path));
  assert.deepEqual(moved.flat().sort(), [ path.dirname(t.w.f.film), t.w.f.e1, t.w.f.e1srt ].sort());
  const folderCall = t.recycler.calls.find((c) => c[0].is_dir);
  assert.equal(folderCall[0].size, 5110);
  const refresh = t.client.posts.find((p) => p[0] === 'share/refresh/paths');
  assert.deepEqual(refresh[1].paths.sort(), [ asDir(path.join(t.w.root, 'Films')), asDir(path.dirname(t.w.f.e1)) ].sort());
  const history = fs.readFileSync(path.join(t.dir, 'cleanup-history.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(history.map((h) => h.action), [ 'recycling', 'recycled', 'recycling', 'recycled' ]);
});

test('an item put in the download queue is left alone', async () => {
  const t = setup({ queued: (w) => [ w.f.e1, w.f.queued ] });
  const result = await t.main.survey();
  assert.deepEqual(result.planned.map((p) => p.item.Id), [ t.w.items.film.Id ]);
  assert.ok(result.skipped.some((s) => s.item.Id === t.w.items.e1.Id && s.reason === 'in the download queue'));
});

test('an item queued between the list and the move is skipped at the last check', async () => {
  const t = setup();
  const result = await t.main.survey();
  // The folder becomes a download target after the survey
  const realPost = t.client.socket.post;
  t.client.socket.post = async (url, body) => (url === 'queue/check_path_queued' && body.path.toLowerCase() === asDir(path.dirname(t.w.f.film)).toLowerCase()
    ? { bundle: { id: 9 } } : realPost(url, body));
  const lines = [];
  const { moved } = await t.main.clean(result, (l) => lines.push(l));
  assert.equal(moved, 1);
  assert.ok(lines.some((l) => /skipped .*in the download queue/.test(l)), lines.join('\n'));
  assert.ok(!t.recycler.calls.flat().some((i) => i.path === path.dirname(t.w.f.film)));
});

test('another account on the server whose state is unknown: run refuses, list still works', async () => {
  const t = setup({ users: [ { Id: 'u1', Name: 'me' }, { Id: 'u2', Name: 'kid' }, { Id: 'u3', Name: 'old', Policy: { IsDisabled: true } } ] });
  const result = await t.main.survey();
  assert.deepEqual(result.uncovered, [ 'kid' ]);
  assert.equal(result.planned.length, 2);
  const lines = [];
  await t.main.clean(result, (l) => lines.push(l));
  assert.match(lines[0], /Not cleaning: .*kid/);
  assert.equal(t.recycler.calls.length, 0);

  settingValues.ignore_other_accounts = true;
  await t.main.clean(result, () => {});
  assert.equal(primary(t.recycler.calls).length, 2);
});

test('a second counted account that has not watched the film keeps it', async () => {
  const t = setup({
    overrides: { extra_accounts: [ { username: 'kid', password: 'kpw' } ] },
    accounts: [
      { name: 'me', password: 'pw', id: 'u1' },
      { name: 'kid', password: 'kpw', id: 'u2', state: (w, all) => ({ ...all, [w.items.film.Id]: { Played: false } }) },
    ],
  });
  const result = await t.main.survey();
  assert.deepEqual(result.uncovered, []);
  assert.deepEqual(result.planned.map((p) => p.item.Id), [ t.w.items.e1.Id ]);
  assert.match(fs.readFileSync(path.join(t.dir, 'watched-cleanup-report.md'), 'utf8'), /Accounts counted: me, kid/);
});

test('a keep-forever collection keeps its films', async () => {
  const t = setup({ overrides: { keep_collections: [ 'Classics ' ] }, collections: (w) => ({ [w.items.film.Id]: [ 'classics' ] }) });
  const result = await t.main.survey();
  assert.deepEqual(result.planned.map((p) => p.item.Id), [ t.w.items.e1.Id ]);
});

test('caps: one item per run moves only the oldest-watched one', async () => {
  const t = setup({ overrides: { max_items_per_run: 1 } });
  const result = await t.main.survey();
  await t.main.clean(result, () => {});
  assert.equal(primary(t.recycler.calls).length, 1);
});

test('a file that changed on disk since the share saw it is left alone', async () => {
  const t = setup();
  const realPost = t.client.socket.post;
  t.client.socket.post = async (url, body) => {
    const answer = await realPost(url, body);
    if (url.startsWith('share/directories/by_real/content/') && Array.isArray(answer)) {
      return answer.map((e) => (e.path === t.w.f.e1 ? { ...e, size: e.size + 1 } : e));
    }
    return answer;
  };
  const result = await t.main.survey();
  assert.ok(result.skipped.some((s) => s.item.Id === t.w.items.e1.Id && /changed/.test(s.reason)));
});

test('a failed move is reported and nothing claims success', async () => {
  const t = setup({ fail: (w) => [ w.f.e1 ] });
  const result = await t.main.survey();
  const lines = [];
  const { moved } = await t.main.clean(result, (l) => lines.push(l));
  assert.equal(moved, 1);
  assert.ok(lines.some((l) => /not moved .*in use/.test(l)), lines.join('\n'));
  const refresh = t.client.posts.find((p) => p[0] === 'share/refresh/paths');
  assert.ok(refresh[1].paths.every((p) => !p.toLowerCase().includes('s01')), JSON.stringify(refresh[1].paths));
});

test('periodic pass: report + event summary, no move unless clean_automatically', async () => {
  const t = setup();
  await t.main.periodicPass();
  const events = t.client.posts.filter((p) => p[0] === 'events').map((p) => p[1].text);
  assert.equal(events.length, 1);
  assert.match(events[0], /watched and done with: 2 item\(s\)/);
  assert.equal(t.recycler.calls.length, 0);
  assert.ok(t.main.getState().lastPassAt === NOW);

  settingValues.clean_automatically = true;
  await t.main.periodicPass();
  assert.equal(primary(t.recycler.calls).length, 2);
});

test('no account configured: the periodic pass does nothing and says nothing', async () => {
  const t = setup({ overrides: { server_user: '', server_password: '' } });
  await t.main.periodicPass();
  assert.equal(t.client.posts.length, 0);
});

test('the media server being down is an error line, not a crash', async () => {
  const t = setup();
  t.client.socket.get = async () => ({ enabled: true, running: false, address: '' });
  await t.ext.onStart();
  t.ext.onStop();
  await t.client.emit('hub_text_command', { command: 'cleanup', args: [ 'run' ] }, 1);
  assert.match(statusLines(t.client.posts)[0], /Failed: The media server is not running/);
  assert.equal(t.recycler.calls.length, 0);
});

test('the token is kept in the state file and reused by the next process; the device id is stable', async () => {
  const t = setup();
  await t.main.survey();
  const first = JSON.parse(fs.readFileSync(path.join(t.dir, 'state.json'), 'utf8'));
  assert.equal(first.tokens.me, 'tok-me');
  const again = createMain(t.client.socket, t.ext, { now: () => NOW, fetchImpl: t.server.fetchImpl, recycler: t.recycler });
  again.loadState();
  const before = t.server.calls.filter((c) => c.includes('AuthenticateByName')).length;
  await again.survey();
  assert.equal(t.server.calls.filter((c) => c.includes('AuthenticateByName')).length, before);
  assert.equal(again.getState().deviceId, first.deviceId);
});

test('a second command while a pass runs is answered "busy", not run twice', async () => {
  const t = setup();
  await t.ext.onStart();
  t.ext.onStop();
  await Promise.all([
    t.client.emit('hub_text_command', { command: 'cleanup', args: [ 'run' ] }, 1),
    t.client.emit('hub_text_command', { command: 'cleanup', args: [ 'run' ] }, 2),
  ]);
  assert.ok(statusLines(t.client.posts).some((l) => /Already working/.test(l)));
  assert.equal(primary(t.recycler.calls).length, 2);
});

test('a release folder holding a junction (a link to elsewhere) is never moved as a whole', async () => {
  const t = setup();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'wcl-elsewhere-'));
  fs.writeFileSync(path.join(elsewhere, 'precious.txt'), 'x');
  // Named like an allowed extra, so only its being a link can keep the folder
  fs.symlinkSync(elsewhere, path.join(path.dirname(t.w.f.film), 'poster.jpg'), 'junction');
  const result = await t.main.survey();
  const film = result.planned.find((p) => p.item.Id === t.w.items.film.Id);
  // Only the film and its own sidecar go; the folder (and the link in it) stays
  assert.equal(film.kind, 'files');
  assert.deepEqual(film.paths, [ t.w.f.film, t.w.f.nfo ]);
});

// Review 2026-10-18: an account that cannot be read is never counted as "has watched it"
test('a counted account whose sign-in or listing fails mid-pass stops the run; nothing is moved', async () => {
  const accounts = [
    { name: 'me', password: 'pw', id: 'u1' },
    { name: 'kid', password: 'kpw', id: 'u2' },
  ];
  // Wrong password for the second account
  let t = setup({ overrides: { extra_accounts: [ { username: 'kid', password: 'wrong' } ] }, accounts });
  await t.ext.onStart();
  t.ext.onStop();
  await t.client.emit('hub_text_command', { command: 'cleanup', args: [ 'run' ] }, 1);
  assert.match(statusLines(t.client.posts)[0], /Failed: Account kid/);
  assert.equal(t.recycler.calls.length, 0);

  // Signed in, but its in-progress list fails half way through the pass
  t = setup({ overrides: { extra_accounts: [ { username: 'kid', password: 'kpw' } ] }, accounts });
  const realFetch = t.server.fetchImpl;
  const broken = async (url, init) => (init.headers['X-Emby-Token'] === 'tok-kid' && url.includes('IsResumable')
    ? { ok: false, status: 500, text: async () => '' } : realFetch(url, init));
  const main = createMain(t.client.socket, t.ext, { now: () => NOW, fetchImpl: broken, recycler: t.recycler });
  await assert.rejects(main.survey(), /Account kid: Media server answered 500/);
  await main.periodicPass();
  assert.equal(t.recycler.calls.length, 0);
});

// Live test 2026-10-19: with a WRONG password for the second account in the settings, "/cleanup run"
// still moved the film. The token saved by the earlier, correct sign-in was found by user name and
// used as it was, so the changed password was never tried. A changed password (or token) must drop
// the saved token: the account then signs in again, and a refused sign-in stops the run.
test('a password changed to a wrong one is tried, not bypassed by the token saved before; run refuses', async () => {
  const accounts = [
    { name: 'me', password: 'pw', id: 'u1' },
    { name: 'kid', password: 'kpw', id: 'u2' },
  ];
  const t = setup({ overrides: { extra_accounts: [ { username: 'kid', password: 'kpw' } ] }, accounts });
  await t.main.survey(); // both sign in; their tokens are saved
  settingValues.extra_accounts = [ { username: 'kid', password: 'wrong' } ];
  await t.ext.onStart();
  t.ext.onStop();
  await t.client.emit('hub_text_command', { command: 'cleanup', args: [ 'run' ] }, 1);
  assert.match(statusLines(t.client.posts)[0], /Failed: Account kid/);
  assert.equal(t.recycler.calls.length, 0);

  // The same through a new process that reads the saved state
  const again = createMain(t.client.socket, t.ext, { now: () => NOW, fetchImpl: t.server.fetchImpl, recycler: t.recycler });
  again.loadState();
  await assert.rejects(again.survey(), /Account kid/);

  // Put right again: it signs in and works
  settingValues.extra_accounts = [ { username: 'kid', password: 'kpw' } ];
  const result = await again.survey();
  assert.ok(result.planned.length > 0);
});
