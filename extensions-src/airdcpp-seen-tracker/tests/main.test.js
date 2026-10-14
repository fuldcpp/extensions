'use strict';

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

const makeClient = (dir, clockRef, onlineRef) => {
  const listeners = {};
  const posts = [];
  const errors = [];
  const socket = {
    logger: { verbose() {}, info() {}, error: (m) => errors.push(m) },
    addListener: async (module, event, cb) => { listeners[event] = cb; },
    post: async (url, body) => {
      if (url === 'users/search_nicks') {
        posts.push([ url, body ]);
        return onlineRef.value.filter((u) => !body.hub_urls || body.hub_urls.includes(u.hub_url));
      }
      if (socket.failPosts) throw new Error('socket closed');
      posts.push([ url, body ]);
    },
  };
  const ext = { name: 'airdcpp-seen-tracker', configPath: dir + path.sep };
  const main = createMain(socket, ext, { now: () => clockRef.value });
  return { socket, ext, main, posts, errors, emit: (event, data, id) => listeners[event](data, id) };
};

const setup = (overrides = {}) => {
  settingValues = SettingDefinitions.reduce((r, d) => ({ ...r, [d.key]: d.default_value }), {});
  Object.assign(settingValues, overrides);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seen-'));
  const clock = { value: 1_000_000 };
  const online = { value: [] };
  return { dir, clock, online, ...makeClient(dir, clock, online), restart: () => makeClient(dir, clock, online) };
};

const bob = { nick: 'bob', cid: 'CIDBOB', hub_name: 'Hub A', hub_url: 'adc://a', flags: [] };
const statusTexts = (posts) => posts.filter((p) => p[0].endsWith('/status_message')).map((p) => p[1].text);

test('joins and leaves are recorded; /seen answers as a status line scoped to the asking session', async () => {
  const t = setup();
  await t.ext.onStart();
  await t.emit('hub_user_connected', bob, 1);
  t.clock.value += 600;
  await t.emit('hub_user_disconnected', bob, 1);
  t.clock.value += 3 * 3600;
  await t.emit('hub_text_command', { command: 'seen', args: [ 'bob' ], owner: 'session-7' }, 7);
  t.ext.onStop();
  const status = t.posts.filter((p) => p[0].endsWith('/status_message'));
  assert.deepEqual(status, [ [ 'hubs/7/status_message', { text: 'bob was last seen 3 hours ago on Hub A (leaving)', severity: 'info', owner: 'session-7' } ] ]);
  const search = t.posts.find((p) => p[0] === 'users/search_nicks');
  assert.equal(search[1].ignore_prefixes, false);
});

test('/seen without a nick asks nothing of the server; /help adds the usage line', async () => {
  const t = setup();
  await t.ext.onStart();
  await t.emit('hub_text_command', { command: 'seen', args: [] }, 1);
  await t.emit('private_chat_text_command', { command: 'help', args: [] }, 'CIDX');
  await t.emit('hub_text_command', { command: 'away', args: [] }, 2);
  t.ext.onStop();
  assert.equal(t.posts.filter((p) => p[0] === 'users/search_nicks').length, 0);
  assert.deepEqual(statusTexts(t.posts), [ 'Usage: /seen <nick>', '/seen <nick>: when a user was last online (airdcpp-seen-tracker)' ]);
  assert.equal(t.posts[1][0], 'private_chat/CIDX/status_message');
});

test('changes reach the log within seconds and survive a kill (no onStop), batched', async (ctx) => {
  ctx.mock.timers.enable({ apis: [ 'setInterval' ] });
  const t = setup();
  await t.ext.onStart();
  for (let i = 0; i < 500; i++) {
    await t.emit('hub_user_connected', { nick: `u${i}`, cid: `C${i}`, hub_name: 'Big Hub', hub_url: 'adc://big', flags: [] }, 1);
  }

  const log = path.join(t.dir, 'seen.log');
  assert.equal(fs.readFileSync(log, 'utf8'), ''); // nothing per event
  ctx.mock.timers.tick(5 * 1000);
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 500); // one append

  // Killed here (TerminateProcess): a new process replays snapshot + log
  const t2 = t.restart();
  await t2.ext.onStart();
  assert.equal(t2.main.getStore().size(), 500);
  // ...and compacts: the snapshot now holds everything, the log is empty
  assert.equal(fs.readFileSync(log, 'utf8'), '');
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(t.dir, 'seen.json'), 'utf8')).users).length, 500);
  t2.ext.onStop();
});

test('users still online when the previous run died are "present" until it was last alive', async (ctx) => {
  ctx.mock.timers.enable({ apis: [ 'setInterval' ] });
  const t = setup();
  await t.ext.onStart();
  await t.emit('hub_user_connected', bob, 1);
  ctx.mock.timers.tick(5 * 1000);   // logged
  t.clock.value += 3600;
  ctx.mock.timers.tick(55 * 1000);  // alive.json heartbeat at +1 h
  const aliveAt = t.clock.value;

  // Killed. Two days later:
  t.clock.value += 2 * 86400;
  const t2 = t.restart();
  await t2.ext.onStart();
  await t2.main.onTextCommand('hubs')({ command: 'seen', args: [ 'bob' ] }, 1);
  t2.ext.onStop();
  assert.equal(statusTexts(t2.posts)[0], 'bob was last seen 2 days ago on Hub A (still online when we last saw the hub)');
  assert.equal(t2.main.getStore().find('bob')[0].at, aliveAt);
});

test('our own disconnect from a hub stamps everyone still there', async () => {
  const t = setup();
  await t.ext.onStart();
  await t.emit('hub_user_connected', bob, 1);
  t.clock.value += 7200;
  await t.emit('hub_updated', { connect_state: { id: 'connecting' } }, 1); // not gone yet
  assert.equal(t.main.getStore().find('bob')[0].event, 'joined');
  await t.emit('hub_updated', { connect_state: { id: 'disconnected', str: 'Disconnected' } }, 1);
  const e = t.main.getStore().find('bob')[0];
  assert.deepEqual([ e.event, e.at ], [ 'present', 1_000_000 + 7200 ]);
  t.ext.onStop();
});

test('public !seen: off by default', async () => {
  const t = setup();
  await t.ext.onStart();
  await t.emit('hub_message', { text: '!seen bob', from: { nick: 'eve', hub_url: 'adc://a', flags: [] } }, 1);
  t.ext.onStop();
  assert.deepEqual(t.posts, []);
});

test('public !seen when allowed: this hub only, prefixed, one per hub per cooldown, never itself or bots', async () => {
  const t = setup({ answer_public: true, public_cooldown_seconds: 30 });
  await t.ext.onStart();
  await t.emit('hub_user_disconnected', bob, 1);
  t.online.value = [ { nick: 'carol', hub_name: 'Secret Hub', hub_url: 'adc://secret' } ];
  await t.emit('hub_message', { text: '!seen bob', from: { nick: 'me', hub_url: 'adc://a', flags: [ 'self' ] } }, 1);
  await t.emit('hub_message', { text: '!seen bob', from: { nick: 'bot', hub_url: 'adc://a', flags: [ 'bot' ] } }, 1);
  await t.emit('hub_message', { text: '!seen bob', from: { nick: 'eve', hub_url: 'adc://a', flags: [] } }, 1);
  await t.emit('hub_message', { text: '!seen bob', from: { nick: 'eve', hub_url: 'adc://a', flags: [] } }, 1); // cooldown, hub 1
  await t.emit('hub_message', { text: '!seen carol', from: { nick: 'zed', hub_url: 'adc://b', flags: [] } }, 2); // other hub: own cooldown
  await t.emit('hub_message', { text: '!seen everyone go to http://evil.example', from: { nick: 'eve', hub_url: 'adc://b', flags: [] } }, 2);
  t.ext.onStop();
  const chat = t.posts.filter((p) => p[0].endsWith('/chat_message'));
  assert.deepEqual(chat, [
    [ 'hubs/1/chat_message', { text: '[seen] bob was last seen less than a minute ago' } ],
    // carol is online on ANOTHER hub only: not revealed
    [ 'hubs/2/chat_message', { text: '[seen] No record of that nick on this hub.' } ],
  ]);
  const searches = t.posts.filter((p) => p[0] === 'users/search_nicks').map((p) => p[1].hub_urls);
  assert.deepEqual(searches, [ [ 'adc://a' ], [ 'adc://b' ] ]);
});

test('a failing reply is contained and logged, the extension carries on', async () => {
  const t = setup();
  await t.ext.onStart();
  t.socket.failPosts = true;
  await t.emit('hub_text_command', { command: 'seen', args: [ 'bob' ] }, 1);
  assert.match(t.errors.join('\n'), /hub_text_command failed: socket closed/);
  t.socket.failPosts = false;
  await t.emit('hub_text_command', { command: 'help', args: [] }, 1);
  t.ext.onStop();
  assert.equal(statusTexts(t.posts).length, 1);
});
