'use strict';

// main.js against a fake socket, a fake media server and a fake TMDB (one fake fetch)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SettingDefinitions } = require('../src/settings');

const settingsPath = require.resolve('airdcpp-extension-settings');
let settingValues;
require.cache[settingsPath] = {
  id: settingsPath, filename: settingsPath, loaded: true,
  exports: () => ({ load: async () => {}, getValue: (key) => settingValues[key], set onValuesUpdated(cb) {} }),
};

const createMain = require('../src/main.js');

const NOW = Date.UTC(2026, 9, 18, 12);
const SECRETS = [ 'hunter2', 'tmdbsecretkey', 'TOKEN-ABC' ];

const response = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => (body === undefined ? '' : JSON.stringify(body)), headers: { get: () => undefined } });

// One show: season 1 has E1 and E3 of 3, season 2 is missing entirely
const fakeFetch = (log) => async (url, options) => {
  log.push({ url, options });
  const u = new URL(url);
  if (u.hostname === 'api.themoviedb.org') {
    if (u.pathname === '/3/tv/55') return response(200, { name: 'Show Name', status: 'Ended', seasons: [ { season_number: 1, episode_count: 3 }, { season_number: 2, episode_count: 2 } ] });
    const m = /^\/3\/tv\/55\/season\/(\d+)$/.exec(u.pathname);
    if (m) return response(200, { episodes: [ 1, 2, 3 ].slice(0, m[1] === '1' ? 3 : 2).map((n) => ({ episode_number: n, air_date: '2024-01-0' + n, name: `Ep ${n}` })) });
    return response(404, {});
  }

  if (u.pathname === '/Users/AuthenticateByName') {
    const body = JSON.parse(options.body);
    return body.Pw === 'hunter2' ? response(200, { AccessToken: 'TOKEN-ABC' }) : response(401, {});
  }

  if (options.headers['X-Emby-Token'] !== 'TOKEN-ABC') return response(401, {});
  if (u.pathname === '/Users/Me') return { ...response(200, { Id: 'u1', Configuration: { DisplayMissingEpisodes: false } }) };
  if (u.pathname === '/Items') return response(200, { Items: [ { Id: 'S1', Name: 'Show Name', Type: 'Series', ProductionYear: 2019, ProviderIds: { Tmdb: '55' } } ], TotalRecordCount: 1 });
  if (u.pathname === '/Shows/S1/Episodes') return response(200, { Items: [ { ParentIndexNumber: 1, IndexNumber: 1 }, { ParentIndexNumber: 1, IndexNumber: 3 } ], TotalRecordCount: 2 });
  return response(404, {});
};

const makeClient = (dir, { mediaServer = { enabled: true, running: true, address: 'http://0.0.0.0:8096', port: 8096 }, clock } = {}) => {
  const listeners = {};
  const hooks = {};
  const posts = [];
  const logs = [];
  const fetchLog = [];
  const socket = {
    logger: { verbose: (m) => logs.push(m), info: (m) => logs.push(m), error: (m) => logs.push(m) },
    addListener: async (module, event, cb) => { listeners[event] = cb; },
    addHook: async (module, event, cb, info) => { hooks[event] = { cb, info }; },
    get: async (url) => {
      if (url === 'media_server') return mediaServer;
      if (url === 'queue/bundles/0/100000') return [];
      throw new Error(`unexpected GET ${url}`);
    },
    post: async (url, body) => { posts.push([ url, body ]); return null; },
    delete: async () => {},
  };
  const ext = { name: 'airdcpp-season-gaps', configPath: dir + path.sep };
  const main = createMain(socket, ext, { now: () => clock.value, fetchImpl: fakeFetch(fetchLog), sleep: async () => {} });
  return { socket, ext, main, posts, logs, fetchLog, listeners, hooks };
};

const setup = (overrides = {}, clientOptions = {}) => {
  settingValues = SettingDefinitions.reduce((r, d) => ({ ...r, [d.key]: d.default_value }), {});
  Object.assign(settingValues, { media_server_user: 'ext', media_server_password: 'hunter2', tmdb_key: 'tmdbsecretkey' }, overrides);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaps-main-'));
  const clock = { value: NOW };
  return { dir, clock, ...makeClient(dir, { clock, ...clientOptions }), restart: (opts = {}) => makeClient(dir, { clock, ...clientOptions, ...opts }) };
};

const statusOf = (posts, prefix) => posts.filter((p) => p[0].startsWith(prefix) && p[0].endsWith('/status_message')).map((p) => p[1].text);

test('/gaps check answers in the asking hub as status lines, writes the report, logs a summary', async () => {
  const t = setup();
  await t.ext.onStart();
  await t.listeners.hub_text_command({ command: 'gaps', args: [ 'check' ], owner: 'o1' }, 7);
  t.ext.onStop();

  const lines = statusOf(t.posts, 'hubs/7/');
  assert.equal(lines[0], 'Checking the media library for missing episodes...');
  assert.match(lines[1], /1 show\(s\) with gaps, 3 aired episode\(s\) missing/);
  assert.match(lines[2], /Show Name: 3 missing \(S01: E02; S02: whole season, E01-E02\)/);
  assert.ok(!t.posts.some((p) => p[0].endsWith('/chat_message')), 'nothing is said in the hub');
  assert.ok(t.posts.filter((p) => p[0].endsWith('status_message')).every((p) => p[1].owner === 'o1'));

  const md = fs.readFileSync(path.join(t.dir, 'season-gaps.md'), 'utf8');
  assert.match(md, /## Show Name/);
  assert.match(md, /S02E01 \(2024-01-01\) Ep 1/);
  const event = t.posts.find((p) => p[0] === 'events');
  assert.match(event[1].text, /^airdcpp-season-gaps: 1 show\(s\) with gaps/);

  // The media server was reached on loopback, not on 0.0.0.0
  assert.ok(t.fetchLog.filter((f) => !f.url.includes('themoviedb')).every((f) => f.url.startsWith('http://127.0.0.1:8096/')));
});

test('no secret reaches a log line, an event, a chat line or the report', async () => {
  const t = setup();
  await t.ext.onStart();
  await t.listeners.hub_text_command({ command: 'gaps', args: [ 'check' ] }, 7);
  await t.listeners.hub_text_command({ command: 'gaps', args: [] }, 7);
  settingValues.media_server_password = 'wrong';
  const s = t.main.getState();
  s.token = null;
  await t.main.check().catch(() => {});
  t.ext.onStop();

  const texts = [ ...t.logs, ...t.posts.map((p) => JSON.stringify(p[1])), fs.readFileSync(path.join(t.dir, 'season-gaps.md'), 'utf8'), fs.readFileSync(path.join(t.dir, 'last-check.json'), 'utf8') ];
  for (const secret of SECRETS) {
    assert.ok(!texts.some((x) => x.includes(secret)), `"${secret}" leaked`);
  }
});

test('the token and device id are kept on disk and reused after a restart; no second sign-in', async () => {
  const t = setup();
  await t.ext.onStart();
  await t.main.check();
  t.ext.onStop();
  const saved = JSON.parse(fs.readFileSync(path.join(t.dir, 'state.json'), 'utf8'));
  assert.equal(saved.token, 'TOKEN-ABC');

  const r = t.restart();
  await r.ext.onStart();
  await r.main.check();
  r.ext.onStop();
  assert.equal(r.main.getState().deviceId, saved.deviceId);
  assert.ok(!r.fetchLog.some((f) => f.url.endsWith('/Users/AuthenticateByName')));
  assert.ok(r.fetchLog.find((f) => f.url.includes('/Users/Me')).options.headers.Authorization.includes(`DeviceId="${saved.deviceId}"`));
});

test('auto fill is off by default; /gaps fill <show> S02 queues only that season for searching', async () => {
  const t = setup();
  await t.ext.onStart();
  await t.main.check();
  assert.equal(t.main.getState().pending.length, 0, 'nothing searched for without being asked');

  await t.listeners.private_chat_text_command({ command: 'gaps', args: [ 'fill', 'show', 'name', 'S02' ] }, 'CID1');
  t.ext.onStop();
  assert.deepEqual(t.main.getState().pending.map((p) => p.key), [ 'S1|S02E01', 'S1|S02E02' ]);
  const lines = statusOf(t.posts, 'private_chat/CID1/');
  assert.match(lines[0], /Show Name: 2 episode\(s\) added/);
  assert.match(lines[1], /download-sorter/);
  // Pending survives a kill: it is on disk
  assert.equal(JSON.parse(fs.readFileSync(path.join(t.dir, 'state.json'), 'utf8')).pending.length, 2);
});

test('auto fill on: every missing aired episode is queued for searching after a check', async () => {
  const t = setup({ auto_fill: true });
  await t.ext.onStart();
  await t.main.check();
  t.ext.onStop();
  assert.equal(t.main.getState().pending.length, 3);
});

test('auto fill takes at most auto_fill_max episodes per check', async () => {
  const t = setup({ auto_fill: true, auto_fill_max: 2 });
  await t.ext.onStart();
  await t.main.check();
  t.ext.onStop();
  assert.equal(t.main.getState().pending.length, 2);
});

test('media server not running: the check fails with an event and is tried again within the hour', async () => {
  const t = setup({}, { mediaServer: { enabled: true, running: false, address: '', port: 8096 } });
  await t.ext.onStart();
  await assert.rejects(t.main.check(), /enabled but not running/);
  const event = t.posts.find((p) => p[0] === 'events');
  assert.equal(event[1].severity, 'error');

  const before = t.posts.length;
  t.main.maybeScheduledCheck();
  assert.equal(t.posts.length, before, 'not again at once');
  t.clock.value += 61 * 60 * 1000;
  t.main.maybeScheduledCheck();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  t.ext.onStop();
  assert.ok(t.posts.filter((p) => p[0] === 'events').length >= 2, 'tried again after an hour');
});

test('a scheduled check runs once per interval', async () => {
  const t = setup();
  await t.ext.onStart();
  t.main.maybeScheduledCheck();
  await t.main.check();
  const count = t.fetchLog.filter((f) => f.url.includes('/Items')).length;
  t.clock.value += 23 * 60 * 60 * 1000;
  t.main.maybeScheduledCheck();
  assert.equal(t.fetchLog.filter((f) => f.url.includes('/Items')).length, count);
  t.ext.onStop();
});

test('the menu item is offered only on this extension\'s own row and starts a check', async () => {
  const t = setup();
  await t.ext.onStart();
  const hook = t.hooks.extension_list_menuitems;
  const answers = [];
  hook.cb({ selected_ids: [ 'airdcpp-other' ] }, (a) => answers.push(a));
  hook.cb({ selected_ids: [ 'airdcpp-season-gaps' ] }, (a) => answers.push(a));
  assert.deepEqual(answers[0].menuitems, []);
  assert.equal(answers[1].menuitems[0].id, 'check_now');

  await t.listeners.extension_menuitem_selected({ hook_id: 'someone-else', menuitem_id: 'check_now' });
  assert.equal(t.fetchLog.length, 0);
  await t.listeners.extension_menuitem_selected({ hook_id: 'airdcpp-season-gaps', menuitem_id: 'check_now' });
  await t.main.check();
  t.ext.onStop();
  assert.ok(t.fetchLog.some((f) => f.url.includes('/Items')));
});

test('/gaps without a check yet, /gaps <show>, /gaps stop, /help', async () => {
  const t = setup();
  await t.ext.onStart();
  await t.listeners.hub_text_command({ command: 'gaps', args: [] }, 1);
  await t.main.check();
  await t.listeners.hub_text_command({ command: 'gaps', args: [ 'show' ] }, 1);
  await t.listeners.hub_text_command({ command: 'gaps', args: [ 'fill', 'Show', 'Name' ] }, 1);
  await t.listeners.hub_text_command({ command: 'gaps', args: [ 'stop' ] }, 1);
  await t.listeners.hub_text_command({ command: 'help', args: [] }, 1);
  await t.listeners.hub_text_command({ command: 'away', args: [] }, 1);
  t.ext.onStop();
  const lines = statusOf(t.posts, 'hubs/1/');
  assert.equal(lines[0], 'No check has run yet. Type /gaps check to run one now.');
  assert.equal(lines[1], 'Show Name: 3 missing');
  assert.ok(lines.includes('3 waiting episode(s) removed from the search list. Downloads already queued are not touched.'));
  assert.ok(lines.some((l) => l.startsWith('/gaps fill <show> [S02]')));
  assert.equal(t.main.getState().pending.length, 0);
});

test('a corrupt state file starts fresh instead of crashing', async () => {
  const t = setup();
  fs.writeFileSync(path.join(t.dir, 'state.json'), '{nope');
  await t.ext.onStart();
  t.ext.onStop();
  assert.equal(t.main.getState().pending.length, 0);
  assert.match(t.main.getState().deviceId, /^[0-9a-f]{24}$/);
});

test('two checks asked at once share one run', async () => {
  const t = setup();
  await t.ext.onStart();
  await Promise.all([ t.main.check(), t.main.check(), t.listeners.hub_text_command({ command: 'gaps', args: [ 'check' ] }, 3) ]);
  t.ext.onStop();
  assert.equal(t.fetchLog.filter((f) => new URL(f.url).pathname === '/Items').length, 1);
});

test('every timer is unref()ed: the extension never keeps the process alive on its own', async () => {
  const t = setup();
  const realInterval = global.setInterval;
  const realTimeout = global.setTimeout;
  const made = [];
  const wrap = (real) => (...args) => {
    const timer = real(...args);
    const entry = { unrefed: false };
    made.push(entry);
    const unref = timer.unref.bind(timer);
    timer.unref = () => { entry.unrefed = true; return unref(); };
    return timer;
  };
  global.setInterval = wrap(realInterval);
  global.setTimeout = wrap(realTimeout);
  try {
    await t.ext.onStart();
  } finally {
    global.setInterval = realInterval;
    global.setTimeout = realTimeout;
    t.ext.onStop();
  }

  assert.ok(made.length >= 3);
  assert.ok(made.every((m) => m.unrefed));
});

// REVIEW: a restart (TerminateProcess, then start) must not hand out a fresh search budget
test('the search budget survives a restart; pending items carry the show years', async () => {
  const t = setup();
  await t.ext.onStart();
  await t.main.check();
  await t.listeners.hub_text_command({ command: 'gaps', args: [ 'fill', 'Show', 'Name' ] }, 1);
  assert.ok(t.main.getState().pending.every((p) => Array.isArray(p.years) && p.years.includes(2019)), 'years travel with the waiting episodes');
  await t.main.filler.tick();
  t.ext.onStop();
  assert.equal(t.main.getState().searches.length, 1);

  const r = t.restart();
  await r.ext.onStart();
  const searchesBefore = r.posts.filter((p) => p[0] === 'search').length;
  assert.equal(await r.main.filler.tick(), false, 'inside the spacing after a restart');
  assert.equal(r.posts.filter((p) => p[0] === 'search').length, searchesBefore);
  r.ext.onStop();
  assert.equal(r.main.getState().searches.length, 1, 'the search before the restart still counts');
});

// REVIEW 2: the failed-folder-download event reaches the filler
test('a failed folder download event is listened to and handled', async () => {
  const t = setup();
  await t.ext.onStart();
  assert.equal(typeof t.listeners.filelist_directory_download_failed, 'function');
  const s = t.main.getState();
  s.attempts['S1|S01E02'] = { at: t.clock.value, outcome: 'queued X', directoryDownloadId: 'dd9' };
  await t.listeners.filelist_directory_download_failed({ directory_download: { id: 'dd9' }, error: 'offline' });
  t.ext.onStop();
  assert.match(t.main.getState().attempts['S1|S01E02'].outcome, /could not be queued/);
  assert.match(JSON.parse(fs.readFileSync(path.join(t.dir, 'state.json'), 'utf8')).attempts['S1|S01E02'].outcome, /could not be queued/, 'saved at once');
});
