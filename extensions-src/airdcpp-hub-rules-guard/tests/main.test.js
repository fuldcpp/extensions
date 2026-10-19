'use strict';

// Drives main.js against a fake socket and a temporary config directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SettingDefinitions } = require('../src/settings');
const { GIB } = require('../src/rules');

const settingsPath = require.resolve('airdcpp-extension-settings');
let settingValues;
let settingsCallback = null;
require.cache[settingsPath] = {
  id: settingsPath, filename: settingsPath, loaded: true,
  exports: () => ({
    load: async () => {},
    getValue: (key) => settingValues[key],
    set onValuesUpdated(cb) { settingsCallback = cb; },
  }),
};

const createMain = require('../src/main.js');

const MY_CID = 'MYCID';
const notFound = (what) => Object.assign(new Error(`${what} not found`), { code: 404 });

const world = () => ({
  hubs: [
    { id: 1, hub_url: 'adcs://hub-a.example:1511', identity: { name: 'Hub A' }, connect_state: { id: 'connected' }, share_profile: { id: 10, str: 'Default' }, settings: { nick: null } },
  ],
  own: { 1: { nick: 'me', cid: MY_CID, tag: '<FulDC++ 1.11,M:A,H:3/1/0,S:4>', upload_slots: 4, share_size: 60 * GIB, flags: [ 'self' ] } },
  profiles: { 10: 60 * GIB, 20: 5 * GIB, default: 60 * GIB },
  uploadSlots: 4,
  hublist: null, // null = module missing (404)
  failStatus: false,
  failHubs: false,
});

const makeClient = (dir, w, clock) => {
  const listeners = {};
  const posts = [];
  const gets = [];
  const errors = [];
  const socket = {
    logger: { verbose() {}, info() {}, error: (m) => errors.push(m) },
    addListener: async (module, event, cb) => { listeners[event] = cb; },
    get: async (url) => {
      gets.push(url);
      if (url === 'system/system_info') return { cid: MY_CID };
      if (url === 'hubs') {
        if (w.failHubs) throw new Error('socket closed');
        return JSON.parse(JSON.stringify(w.hubs));
      }
      if (url === 'hublists/entries') {
        if (!w.hublist) throw notFound('Module');
        return w.hublist;
      }
      if (url === 'share/stats') return { total_size: 60 * GIB };
      let m = /^hubs\/(\d+)\/users\/(\w+)$/.exec(url);
      if (m) {
        if (m[2] !== MY_CID || !w.own[m[1]]) throw notFound('User');
        return w.own[m[1]];
      }
      m = /^share_profiles\/(\w+)$/.exec(url);
      if (m) {
        if (!(m[1] in w.profiles)) throw notFound('Profile');
        return { id: m[1], size: w.profiles[m[1]] };
      }
      throw new Error(`unexpected GET ${url}`);
    },
    post: async (url, body) => {
      if (url === 'settings/get') return { upload_slots: w.uploadSlots };
      if (url.endsWith('/status_message') && w.failStatus) throw new Error('socket closed');
      posts.push([ url, body ]);
    },
  };
  const ext = { name: 'airdcpp-hub-rules-guard', configPath: dir + path.sep };
  const main = createMain(socket, ext, { now: () => clock.value });
  const emit = async (event, data, id) => {
    await listeners[event](data, id);
    await main.idle();
  };
  return { socket, ext, main, posts, gets, errors, listeners, emit };
};

const setup = (overrides = {}) => {
  settingValues = SettingDefinitions.reduce((r, d) => ({ ...r, [d.key]: d.default_value }), {});
  Object.assign(settingValues, overrides);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rules-'));
  const w = world();
  const clock = { value: 1_000_000 };
  return { dir, w, clock, ...makeClient(dir, w, clock), restart: () => makeClient(dir, w, clock) };
};

const statusOf = (posts, id = 1) => posts.filter((p) => p[0] === `hubs/${id}/status_message`).map((p) => p[1]);
const eventsOf = (posts) => posts.filter((p) => p[0] === 'events').map((p) => p[1]);
const stateOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'hub-rules.json'), 'utf8'));
const hubState = (dir) => (fs.existsSync(path.join(dir, 'hub-rules.json')) && stateOf(dir).hubs[KEY]) || {};
const KEY = 'hub-a.example:1511';

const tick = async (t, ctx, ms) => {
  ctx.mock.timers.tick(ms);
  await new Promise((r) => setImmediate(r));
  await t.main.idle();
};

const serverLine = (text) => ({ text, type: 'server', label: '', severity: 'info' });

test('a minimum share announced by the hub: learned, saved with its source, warned locally once', async (ctx) => {
  ctx.mock.timers.enable({ apis: [ 'setTimeout', 'setInterval' ] });
  const t = setup();
  await t.ext.onStart();
  assert.deepEqual(statusOf(t.posts), []);

  await t.emit('hub_status', serverLine('Welcome to Hub A. Rules: Min share: 100 GB, Max hubs: 10'), 1);
  const saved = stateOf(t.dir).hubs[KEY];
  assert.equal(saved.limits.chat.min_share.value, 100 * GIB);
  assert.equal(saved.limits.chat.max_hubs.value, 10);
  assert.match(saved.limits.chat.min_share.text, /Min share: 100 GB/);

  await tick(t, ctx, 5000);
  const status = statusOf(t.posts);
  assert.equal(status.length, 1);
  assert.deepEqual(status[0], { text: "[rules] your share 60.0 GiB is below the hub's minimum of 100.0 GiB (hub message). Type /rules for details.", severity: 'warning', type: 'system' });
  assert.deepEqual(eventsOf(t.posts), [ { text: "airdcpp-hub-rules-guard: Hub A: your share 60.0 GiB is below the hub's minimum of 100.0 GiB (hub message)", severity: 'warning' } ]);

  // Nothing is ever said to the hub, no setting is changed
  assert.equal(t.posts.filter((p) => p[0].endsWith('/chat_message') || p[0].startsWith('settings/set')).length, 0);

  // Same hour: quiet; an hour later: once more
  await t.main.checkAll();
  assert.equal(statusOf(t.posts).length, 1);
  t.clock.value += 3600;
  await t.main.checkAll();
  assert.equal(statusOf(t.posts).length, 2);
  t.ext.onStop();

  // The last warning time is on disk: a restart (after a kill) does not repeat it within the hour
  const t2 = t.restart();
  await t2.ext.onStart();
  assert.equal(statusOf(t2.posts).length, 0);
  t2.ext.onStop();
});

test('who may teach a rule: hub, bots and operators yes; users, ourselves and other extensions no', async () => {
  const t = setup();
  await t.ext.onStart();
  await t.emit('hub_message', { text: 'Min share: 900 GB', from: { nick: 'troll', cid: 'X', flags: [] } }, 1);
  await t.emit('hub_message', { text: 'Min share: 900 GB', from: { nick: 'me', cid: MY_CID, flags: [ 'self', 'op' ] } }, 1);
  await t.emit('hub_status', { text: 'Min share: 900 GB', type: 'system', label: 'other-extension', severity: 'info' }, 1);
  await t.emit('hub_status', { text: 'Min share: 900 GB', type: 'system', label: '', severity: 'info' }, 1);
  await t.emit('hub_status', { text: 'Min share: 900 GB', type: 'server', label: 'other-extension', severity: 'info' }, 1);
  await t.emit('hub_status', { text: '[rules] min share 900 GB', type: 'server', label: '', severity: 'info' }, 1);
  await t.emit('hub_message', { text: 'Min share: 900 GB', to: { nick: 'me' }, from: { nick: 'Bot', cid: 'B', flags: [ 'bot' ] } }, 1);
  assert.equal((hubState(t.dir).limits || {}).chat, undefined);

  await t.emit('hub_message', { text: 'Min slots: 6', from: { nick: 'PtokaX', cid: 'P', flags: [ 'bot' ] } }, 1);
  await t.emit('hub_message', { text: 'Max hubs: 12', from: { nick: 'Hub A', cid: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', flags: [] } }, 1);
  await t.emit('hub_message', { text: 'Min share: 10 GB', from: { nick: 'SomeOp', cid: 'O', flags: [ 'op' ] } }, 1);
  const chat = stateOf(t.dir).hubs[KEY].limits.chat;
  assert.deepEqual(Object.keys(chat).sort(), [ 'max_hubs', 'min_share', 'min_slots' ]);
  t.ext.onStop();
});

test('learning from chat can be turned off', async () => {
  const t = setup({ learn_from_chat: false });
  await t.ext.onStart();
  await t.emit('hub_status', serverLine('Min share: 100 GB'), 1);
  await t.emit('hub_status', serverLine('me was kicked: Min share 100 GB'), 1);
  assert.ok(!hubState(t.dir).kick);
  assert.equal((hubState(t.dir).limits || {}).chat, undefined);
  t.ext.onStop();
});

test('kicked for a rule: recorded, survives a kill, shown on the next connect', async (ctx) => {
  ctx.mock.timers.enable({ apis: [ 'setTimeout', 'setInterval' ] });
  const t = setup();
  await t.ext.onStart();
  await t.emit('hub_status', serverLine('You are being kicked because: min share is 100 GB'), 1);
  await t.emit('hub_updated', { connect_state: { id: 'disconnected', str: 'Disconnected' } }, 1);
  const kick = stateOf(t.dir).hubs[KEY].kick;
  assert.deepEqual(kick.rules, [ 'min_share' ]);
  assert.equal(stateOf(t.dir).hubs[KEY].limits.kick.min_share.value, 100 * GIB);
  assert.match(eventsOf(t.posts).map((e) => e.text).join('\n'), /Hub A disconnected you for: min share 100.0 GiB/);

  // Killed (no onStop). Next run, the hub connects:
  const t2 = t.restart();
  t.w.hubs[0].connect_state = { id: 'disconnected' };
  await t2.ext.onStart();
  t.w.hubs[0].connect_state = { id: 'connected' };
  await t2.emit('hub_updated', { connect_state: { id: 'connected' } }, 1);
  await tick(t2, ctx, 20 * 1000);
  const lines = statusOf(t2.posts).map((s) => s.text);
  assert.match(lines[0], /^\[rules\] On .* this hub disconnected you for: min share 100.0 GiB\. Type \/rules/);
  assert.match(lines[1], /below the hub's minimum of 100.0 GiB \(kick message\)/);
  t2.ext.onStop();
  t.ext.onStop();
});

test('a rule message before a disconnect is not a kick when we met that rule', async () => {
  const t = setup();
  await t.ext.onStart(); // values known: 60 GiB, 4 slots
  await t.emit('hub_status', serverLine('You need to share at least 20 GB'), 1);
  await t.emit('hub_updated', { connect_state: { id: 'disconnected' } }, 1);
  assert.equal(stateOf(t.dir).hubs[KEY].kick, null);
  // ...and an old message (> 60 s) does not explain a later disconnect either
  t.w.hubs[0].connect_state = { id: 'connected' };
  await t.emit('hub_updated', { connect_state: { id: 'connected' } }, 1);
  await t.emit('hub_status', serverLine('Your share is too small'), 1);
  t.clock.value += 120;
  await t.emit('hub_updated', { connect_state: { id: 'disconnected' } }, 1);
  assert.equal(stateOf(t.dir).hubs[KEY].kick, null);
  t.ext.onStop();
});

test('"<our nick> was kicked" names a rule without a number: recorded at once', async () => {
  const t = setup();
  await t.ext.onStart();
  await t.emit('hub_status', serverLine('bob was kicked: User is on too many hubs.'), 1);
  assert.ok(!hubState(t.dir).kick);
  await t.emit('hub_status', serverLine('me was kicked by OpBot: User is on too many hubs.'), 1);
  const kick = stateOf(t.dir).hubs[KEY].kick;
  assert.deepEqual(kick.rules, [ 'max_hubs' ]);
  assert.deepEqual(kick.limits, {});
  t.ext.onStop();
});

test('each hub is measured with its own share profile', async () => {
  const t = setup();
  t.w.hubs.push({ id: 2, hub_url: 'dchub://hub-b.example', identity: { name: 'Hub B' }, connect_state: { id: 'connected' }, share_profile: { id: 20, str: 'Small' } });
  t.w.own[2] = { nick: 'me', tag: '<FulDC++ 1.11,M:A,H:3/1/0,S:4>', upload_slots: 4 };
  await t.ext.onStart();
  await t.emit('hub_text_command', { command: 'rules', args: [ 'set', 'minshare', '10GB' ] }, 1);
  await t.emit('hub_text_command', { command: 'rules', args: [ 'set', 'minshare', '10GB' ] }, 2);
  await t.main.checkAll();
  assert.equal(statusOf(t.posts, 1).filter((s) => s.severity === 'warning').length, 0);
  const b = statusOf(t.posts, 2).filter((s) => s.severity === 'warning');
  assert.equal(b.length, 1);
  assert.match(b[0].text, /your share 5.0 GiB is below the hub's minimum of 10.0 GiB \(set by you\)/);
  assert.ok(t.gets.includes('share_profiles/20'));
  t.ext.onStop();
});

test('hub counts and slots come from our own tag on that hub; ratio uses them', async () => {
  const t = setup();
  await t.ext.onStart();
  await t.emit('hub_status', serverLine('Rules: max hubs 3, min slots 5, slot ratio 1.5'), 1);
  await t.main.checkAll();
  const texts = statusOf(t.posts).map((s) => s.text).join('\n');
  assert.match(texts, /you are on 4 hubs, the hub allows at most 3/);
  assert.match(texts, /you have 4 upload slot\(s\), the hub wants at least 5/);
  assert.match(texts, /4 slot\(s\) for 4 hubs \(1 per hub\), the hub wants at least 1.5 per hub/);
  t.ext.onStop();
});

test('without our own user on the hub: falls back to the slot setting and counted hubs', async () => {
  const t = setup();
  t.w.own = {};
  t.w.uploadSlots = 2;
  await t.ext.onStart();
  await t.emit('hub_text_command', { command: 'rules', args: [ 'set', 'minslots', '3' ] }, 1);
  await t.main.checkAll();
  assert.match(statusOf(t.posts).map((s) => s.text).join('\n'), /you have 2 upload slot\(s\), the hub wants at least 3/);
  t.ext.onStop();
});

test('the public hub list is used when the client has it, and its absence is fine', async () => {
  const t = setup();
  t.w.hublist = [ { name: 'Hub A', server: 'adcs://HUB-A.example:1511', min_share: 200 * GIB, min_slots: 0, max_hubs: 0 } ];
  await t.ext.onStart();
  const saved = stateOf(t.dir).hubs[KEY].limits.hublist;
  assert.deepEqual(Object.keys(saved), [ 'min_share' ]);
  assert.match(statusOf(t.posts)[0].text, /minimum of 200.0 GiB \(public hub list\)/);
  // never asked the client to download it
  assert.equal(t.posts.filter((p) => p[0].startsWith('hublists/')).length, 0);
  t.ext.onStop();

  const t2 = setup(); // hublist module missing: 404
  await t2.ext.onStart();
  t2.clock.value += 31 * 60;
  await t2.main.checkAll();
  assert.equal(t2.gets.filter((g) => g === 'hublists/entries').length, 1); // not retried
  assert.deepEqual(t2.errors, []);
  t2.ext.onStop();
});

test('a share change and a slot change trigger a check', async (ctx) => {
  ctx.mock.timers.enable({ apis: [ 'setTimeout', 'setInterval' ] });
  const t = setup();
  await t.ext.onStart();
  await t.emit('hub_text_command', { command: 'rules', args: [ 'set', 'minshare', '50GB' ] }, 1);
  await tick(t, ctx, 1000);
  assert.equal(statusOf(t.posts).filter((s) => s.severity !== 'info').length, 0);

  t.w.profiles[10] = 40 * GIB; // a root was removed
  await t.emit('share_root_removed', { id: 'x' });
  await tick(t, ctx, 29 * 1000);
  assert.equal(statusOf(t.posts).filter((s) => s.severity === 'warning').length, 0);
  await tick(t, ctx, 1000);
  assert.equal(statusOf(t.posts).filter((s) => s.severity === 'warning').length, 1);

  await t.emit('hub_text_command', { command: 'rules', args: [ 'set', 'minslots', '4' ] }, 1);
  await tick(t, ctx, 1000);
  assert.equal(statusOf(t.posts).filter((s) => /upload slot/.test(s.text)).length, 0);
  t.w.own[1].upload_slots = 3;
  t.w.uploadSlots = 3;
  await tick(t, ctx, 60 * 1000); // the slot poll notices
  await tick(t, ctx, 5 * 1000);
  assert.equal(statusOf(t.posts).filter((s) => /you have 3 upload slot\(s\), the hub wants at least 4/.test(s.text)).length, 1);
  assert.ok(t.gets.filter((g) => g === 'hubs').length >= 3);
  t.ext.onStop();
});

test('/rules shows limits vs values; set, clear and forget', async () => {
  const t = setup();
  await t.ext.onStart();
  await t.emit('hub_status', serverLine('Min share: 100 GB'), 1);
  await t.emit('hub_text_command', { command: 'rules', args: [], owner: 'session-1' }, 1);
  const shown = t.posts.filter((p) => p[1].owner === 'session-1').map((p) => p[1].text);
  assert.deepEqual(shown, [ 'Rules known for Hub A:', '  min share 100.0 GiB (hub message): yours 60.0 GiB  <- NOT MET' ]);

  await t.emit('hub_text_command', { command: 'rules', args: [ 'set', 'minshare', '10', 'GB' ] }, 1);
  assert.equal(stateOf(t.dir).hubs[KEY].limits.user.min_share.value, 10 * GIB);
  await t.emit('hub_text_command', { command: 'rules', args: [ 'forget' ] }, 1);
  assert.deepEqual(Object.keys(stateOf(t.dir).hubs[KEY].limits), [ 'user' ]);
  await t.emit('hub_text_command', { command: 'rules', args: [ 'clear', 'all' ] }, 1);
  assert.deepEqual(stateOf(t.dir).hubs[KEY].limits, {});
  await t.emit('hub_text_command', { command: 'rules', args: [ 'set', 'minshare', 'lots' ] }, 1);
  assert.match(statusOf(t.posts).pop().text, /Give a size with a unit/);
  await t.emit('hub_text_command', { command: 'help', args: [] }, 1);
  assert.match(statusOf(t.posts).pop().text, /^\/rules: the rules known/);
  await t.emit('hub_text_command', { command: 'away', args: [] }, 1);
  t.ext.onStop();
});

test('failures are contained: a failing hub window, a failing hub list read, a failing hubs request', async () => {
  const t = setup();
  t.w.failStatus = true;
  await t.ext.onStart();
  await t.emit('hub_status', serverLine('Min share: 100 GB'), 1);
  await t.main.checkAll();
  assert.match(t.errors.join('\n'), /Could not post to Hub A: socket closed/);
  assert.equal(eventsOf(t.posts).length, 1); // the event log still got it

  t.w.failHubs = true;
  await t.emit('share_refresh_completed', {});
  await t.main.checkAll().catch((error) => t.errors.push(`direct: ${error.message}`));
  t.w.failHubs = false;
  t.w.failStatus = false;
  await t.emit('hub_text_command', { command: 'rules', args: [] }, 1);
  assert.ok(statusOf(t.posts).length > 0);
  t.ext.onStop();
});

test('a corrupt state file starts empty instead of failing', async () => {
  const t = setup();
  fs.writeFileSync(path.join(t.dir, 'hub-rules.json'), '{not json');
  await t.ext.onStart();
  assert.match(t.errors.join('\n'), /Could not read hub-rules.json/);
  await t.emit('hub_status', serverLine('Min share: 1 GB'), 1);
  assert.equal(stateOf(t.dir).hubs[KEY].limits.chat.min_share.value, GIB);
  t.ext.onStop();
});

test('a setting change rechecks', async (ctx) => {
  ctx.mock.timers.enable({ apis: [ 'setTimeout', 'setInterval' ] });
  const t = setup();
  await t.ext.onStart();
  const before = t.gets.filter((g) => g === 'hubs').length;
  settingsCallback({ share_margin_percent: 10 });
  await tick(t, ctx, 1000);
  assert.equal(t.gets.filter((g) => g === 'hubs').length, before + 1);
  t.ext.onStop();
});

test('review: on NMDC an ordinary user cannot pose as the hub or a bot', async () => {
  const t = setup();
  t.w.hubs[0].hub_url = 'dchub://hub-a.example:1511';
  await t.ext.onStart();
  // NmdcHub.cpp turns a user's main chat line containing "is kicking ... because:" (or
  // "Hub-Security" + "was kicked by") into a server status line, nick prefix included
  await t.emit('hub_status', serverLine('<troll> is kicking me because: min share 9000 TB'), 1);
  await t.emit('hub_status', serverLine('<troll> Hub-Security: me was kicked by x because: max hubs 1'), 1);
  // ...and flags any user with an empty connection field as a bot
  await t.emit('hub_message', { text: 'Min share: 9000 TB', from: { nick: 'fakebot', cid: 'F', flags: [ 'bot', 'nmdc' ] } }, 1);
  assert.ok(!hubState(t.dir).kick);
  assert.equal((hubState(t.dir).limits || {}).chat, undefined);

  // the hub's security bot and an operator seen in main chat are still read
  await t.emit('hub_status', serverLine('<Hub-Security> bob was kicked by SomeOp because: Max hubs: 12'), 1);
  assert.equal(stateOf(t.dir).hubs[KEY].limits.chat.max_hubs.value, 12);
  await t.emit('hub_message', { text: 'hello', from: { nick: 'SomeOp', cid: 'O', flags: [ 'op', 'nmdc' ] } }, 1);
  await t.emit('hub_status', serverLine('<SomeOp> is kicking me because: min share 500 GB'), 1);
  assert.equal(stateOf(t.dir).hubs[KEY].kick.limits.min_share, 500 * GIB);
  t.ext.onStop();
});

test('review: a disconnect before the first check is not a kick for a rule we meet', async () => {
  const t = setup();
  const hub = t.w.hubs[0];
  t.w.hubs = [];
  await t.ext.onStart();
  t.w.hubs = [ { ...hub, connect_state: { id: 'connected' } } ];
  await t.emit('hub_created', { ...hub, connect_state: { id: 'connecting' } });
  await t.emit('hub_updated', { connect_state: { id: 'connected' } }, 1);
  // the welcome text, then the connection drops (or a redirect) before the 20 s check ran
  await t.emit('hub_status', serverLine('Welcome! You need to share at least 20 GB here.'), 1);
  await t.emit('hub_updated', { connect_state: { id: 'disconnected' } }, 1);
  assert.ok(!hubState(t.dir).kick, 'we share 60 GiB: not kicked for a 20 GB minimum');
  t.ext.onStop();
});
