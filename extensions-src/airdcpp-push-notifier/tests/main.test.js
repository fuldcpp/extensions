'use strict';

// Drives main.js with a fake socket and a fake settings manager: the event wiring, the away
// gate, bundle de-duplication and the hub-disconnect grace timer.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { SettingDefinitions } = require('../src/settings');

// Replace airdcpp-extension-settings before main.js loads it
const settingsPath = require.resolve('airdcpp-extension-settings');
let settingValues;
let onValuesUpdated;
require.cache[settingsPath] = {
  id: settingsPath, filename: settingsPath, loaded: true,
  exports: () => ({
    load: async () => {},
    getValue: (key) => settingValues[key],
    setValue: async (key, value) => { settingValues[key] = value; },
    set onValuesUpdated(cb) { onValuesUpdated = cb; },
  }),
};

const createMain = require(path.join(__dirname, '..', 'src', 'main.js'));

const setup = async (overrides = {}) => {
  settingValues = SettingDefinitions.reduce((r, d) => ({ ...r, [d.key]: d.default_value }), {});
  Object.assign(settingValues, { webhook_url: 'http://127.0.0.1:9/hook', cooldown_seconds: 0 }, overrides);

  const listeners = {};
  const sent = [];
  const hubs = {};
  let awayState = { id: 'off' };
  global.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200 }; };

  const socket = {
    logger: { verbose() {}, info() {}, error() {} },
    addListener: async (module, event, cb) => { listeners[event] = cb; },
    get: async (url) => {
      if (url === 'system/away') return awayState;
      const hub = hubs[url.split('/')[1]];
      if (!hub) throw new Error('not found');
      return hub;
    },
    post: async () => {},
  };
  const extension = { name: 'airdcpp-push-notifier', configPath: '/tmp/' };
  createMain(socket, extension);
  await extension.onStart({});

  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return {
    emit: async (event, data, id) => { listeners[event](data, id); await flush(); await flush(); },
    sent, hubs, extension,
    setAway: (id) => { awayState = { id }; },
  };
};

const pm = (text, flags = []) => ({ text, has_mention: false, from: { nick: 'bob', cid: 'C1', hub_name: 'H', flags } });

test('private messages respect the away gate', async () => {
  const t = await setup();
  await t.emit('private_chat_message', pm('while present'));
  assert.equal(t.sent.length, 0);
  await t.emit('away_state', { id: 'manual' });
  await t.emit('private_chat_message', pm('while away'));
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].message, 'while away');
  await t.emit('away_state', { id: 'off' });
  await t.emit('private_chat_message', pm('present again'));
  assert.equal(t.sent.length, 1);
  t.extension.onStop();
});

test('own messages and bots are never sent', async () => {
  const t = await setup({ chat_only_when_away: false });
  await t.emit('private_chat_message', pm('echo of mine', [ 'self' ]));
  await t.emit('private_chat_message', pm('bot spam', [ 'bot' ]));
  assert.equal(t.sent.length, 0);
  await t.emit('hub_message', { ...pm('hi bob'), has_mention: true });
  await t.emit('hub_message', pm('no mention'));
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].event, 'mention');
  t.extension.onStop();
});

test('completed then shared gives one notification; a requeue re-arms it', async () => {
  const t = await setup();
  const bundle = (id) => ({ id: 5, name: 'Rel-GRP', status: { id } });
  await t.emit('queue_bundle_status', bundle('completed'));
  await t.emit('queue_bundle_status', bundle('shared'));
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].event, 'bundle_finished');
  await t.emit('queue_bundle_status', bundle('queued'));
  await t.emit('queue_bundle_status', bundle('completed'));
  assert.equal(t.sent.length, 2);
  await t.emit('queue_bundle_status', { id: 5, name: 'Rel-GRP', status: { id: 'download_error', failed: true, str: 'Disk full' } });
  assert.equal(t.sent.length, 3);
  assert.equal(t.sent[2].message, 'Rel-GRP: Disk full');
  t.extension.onStop();
});

test('disabled bundle notifications send nothing', async () => {
  const t = await setup({ notify_bundle_finished: false });
  await t.emit('queue_bundle_status', { id: 1, name: 'x', status: { id: 'completed' } });
  assert.equal(t.sent.length, 0);
  t.extension.onStop();
});

test('a hub that reconnects inside the grace period is not reported', async (ctx) => {
  ctx.mock.timers.enable({ apis: [ 'setTimeout' ] });
  const t = await setup({ notify_hub_disconnected: true, hub_disconnect_grace: 10 });
  t.hubs['7'] = { identity: { name: 'HubSeven' }, connect_state: { id: 'connected' } };
  await t.emit('hub_updated', { connect_state: { id: 'disconnected' } }, 7);
  await t.emit('hub_updated', { connect_state: { id: 'connected' } }, 7);
  ctx.mock.timers.tick(11 * 1000);
  await new Promise((r) => setImmediate(r));
  assert.equal(t.sent.length, 0);

  // Stays down: reported once, after the grace period
  t.hubs['7'].connect_state = { id: 'disconnected', str: 'Disconnected' };
  await t.emit('hub_updated', { connect_state: { id: 'disconnected' } }, 7);
  await t.emit('hub_updated', { connect_state: { id: 'disconnected' } }, 7);
  ctx.mock.timers.tick(9 * 1000);
  await new Promise((r) => setImmediate(r));
  assert.equal(t.sent.length, 0);
  ctx.mock.timers.tick(2 * 1000);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].title, 'Disconnected from HubSeven');
  t.extension.onStop();
});

test('a reconnect restarts the grace period for the next drop', async (ctx) => {
  // Without the cancel, the first timer would fire at 10 s and report a drop only 5 s old
  ctx.mock.timers.enable({ apis: [ 'setTimeout' ] });
  const t = await setup({ notify_hub_disconnected: true, hub_disconnect_grace: 10 });
  t.hubs['8'] = { identity: { name: 'HubEight' }, connect_state: { id: 'disconnected', str: 'Disconnected' } };
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  await t.emit('hub_updated', { connect_state: { id: 'disconnected' } }, 8);
  ctx.mock.timers.tick(3 * 1000);
  await t.emit('hub_updated', { connect_state: { id: 'connected' } }, 8);
  ctx.mock.timers.tick(2 * 1000);
  await t.emit('hub_updated', { connect_state: { id: 'disconnected' } }, 8);
  ctx.mock.timers.tick(6 * 1000); // 11 s after the first drop, 6 s after the second
  await settle();
  assert.equal(t.sent.length, 0);
  ctx.mock.timers.tick(5 * 1000);
  await settle();
  assert.equal(t.sent.length, 1);
  t.extension.onStop();
});

test('client retries (connecting -> disconnected) do not restart the grace period', async (ctx) => {
  ctx.mock.timers.enable({ apis: [ 'setTimeout' ] });
  const t = await setup({ notify_hub_disconnected: true, hub_disconnect_grace: 10 });
  t.hubs['9'] = { identity: { name: 'HubNine' }, connect_state: { id: 'connecting' } };
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  await t.emit('hub_updated', { connect_state: { id: 'disconnected' } }, 9);
  for (let i = 0; i < 3; i++) {
    ctx.mock.timers.tick(3 * 1000);
    await t.emit('hub_updated', { connect_state: { id: 'connecting' } }, 9);
    await t.emit('hub_updated', { connect_state: { id: 'disconnected' } }, 9);
  }

  ctx.mock.timers.tick(2 * 1000); // 11 s after the first drop; the hub was "connecting" at fire time
  await settle();
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].title, 'Disconnected from HubNine');
  t.extension.onStop();
});

test('turning the setting off cancels a pending disconnect report', async (ctx) => {
  ctx.mock.timers.enable({ apis: [ 'setTimeout' ] });
  const t = await setup({ notify_hub_disconnected: true, hub_disconnect_grace: 10 });
  t.hubs['4'] = { identity: { name: 'HubFour' }, connect_state: { id: 'disconnected' } };
  await t.emit('hub_updated', { connect_state: { id: 'disconnected' } }, 4);
  settingValues.notify_hub_disconnected = false;
  ctx.mock.timers.tick(11 * 1000);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(t.sent.length, 0);
  t.extension.onStop();
});

test('a persistent failure is reported once although the client requeues it every minute', async () => {
  const t = await setup();
  const failed = { id: 3, name: 'Rel', status: { id: 'download_error', failed: true, str: 'Access denied' } };
  for (let i = 0; i < 4; i++) {
    await t.emit('queue_bundle_status', failed);
    await t.emit('queue_bundle_status', { id: 3, name: 'Rel', status: { id: 'queued' } });
  }

  assert.equal(t.sent.length, 1);
  // It finally downloads: that is news
  await t.emit('queue_bundle_status', { id: 3, name: 'Rel', status: { id: 'completed' } });
  assert.equal(t.sent.length, 2);
  assert.equal(t.sent[1].event, 'bundle_finished');
  // Removed and queued again later: a new failure is reported
  await t.emit('queue_bundle_status', failed);
  assert.equal(t.sent.length, 3);
  await t.emit('queue_bundle_removed', { id: 3 });
  await t.emit('queue_bundle_status', failed);
  assert.equal(t.sent.length, 4);
  t.extension.onStop();
});

test('the rate-limit suffix never pushes a body past the cap', async () => {
  const t = await setup({ chat_only_when_away: false, max_per_minute: 1 });
  const long = 'x'.repeat(5000);
  await t.emit('private_chat_message', { ...pm(long), from: { nick: 'a', cid: 'A', flags: [] } });
  await t.emit('private_chat_message', { ...pm(long), from: { nick: 'b', cid: 'B', flags: [] } }); // dropped
  // Next window
  const realNow = Date.now;
  Date.now = () => realNow() + 61 * 1000;
  try {
    await t.emit('private_chat_message', { ...pm(long), from: { nick: 'c', cid: 'C', flags: [] } });
  } finally {
    Date.now = realNow;
  }

  assert.equal(t.sent.length, 2);
  assert.ok(Array.from(t.sent[1].message).length <= 1000, `length ${t.sent[1].message.length}`);
  assert.ok(t.sent[1].message.endsWith('…'));
  t.extension.onStop();
});

test('send_test sends to the services and switches itself off', async () => {
  const t = await setup();
  settingValues.send_test = true;
  onValuesUpdated({ send_test: true });
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].event, 'test');
  assert.equal(settingValues.send_test, false);
  t.extension.onStop();
});

test('a throwing handler does not escape the listener', async () => {
  const t = await setup({ chat_only_when_away: false });
  // A payload without "from" fields used to be fine; a null message must not crash either
  await t.emit('private_chat_message', null);
  await t.emit('queue_bundle_status', null);
  await t.emit('private_chat_message', pm('still alive'));
  assert.equal(t.sent.length, 1);
  t.extension.onStop();
});

test('the initial away state is read at start', async () => {
  const t = await setup();
  // setup() reads system/away = off; flip and restart to prove the read is used
  t.setAway('idle');
  await t.extension.onStart({});
  await t.emit('private_chat_message', pm('idle pm'));
  assert.equal(t.sent.length, 1);
  t.extension.onStop();
});
