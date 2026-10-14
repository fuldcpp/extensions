'use strict';

// Drives main.js against a fake socket and a temporary config directory: the API calls it makes,
// the persisted record of its own pauses, and a restart in the middle.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SettingDefinitions } = require('../src/settings');
const { GIB } = require('../src/decide');

const settingsPath = require.resolve('airdcpp-extension-settings');
let settingValues;
require.cache[settingsPath] = {
  id: settingsPath, filename: settingsPath, loaded: true,
  exports: () => ({
    load: async () => {},
    getValue: (key) => settingValues[key],
    set onValuesUpdated(cb) {},
  }),
};

const createMain = require('../src/main.js');

// A fake client: a queue whose priorities change when the extension posts them, and a free-space
// table per target
const fakeClient = (bundles, free) => {
  const calls = [];
  const events = [];
  const socket = {
    logger: { verbose() {}, info() {}, error() {} },
    get: async (url) => {
      assert.equal(url, 'queue/bundles/0/100000');
      return JSON.parse(JSON.stringify(bundles));
    },
    post: async (url, body) => {
      if (url === 'filesystem/disk_info') {
        return body.paths.map((p) => ({ path: p, free_space: free[p] === undefined ? -1 : free[p] * GIB, total_space: 0 }));
      }

      if (url === 'events') {
        events.push(body);
        return;
      }

      const match = /^queue\/bundles\/(\d+)\/priority$/.exec(url);
      assert.ok(match, url);
      calls.push([ Number(match[1]), body.priority ]);
      const b = bundles.find((x) => x.id === Number(match[1]));
      if (!b) throw new Error('Bundle not found');
      b.priority = body.priority === -1 ? { id: 3, auto: true } : { id: body.priority, auto: false };
    },
  };
  return { socket, calls, events };
};

const newExtension = (dir) => ({ name: 'airdcpp-disk-space-guard', configPath: dir + path.sep });

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsg-'));

const b = (id, target, prio, auto = false) => ({ id, name: `R${id}`, target, status: { id: 'queued', downloaded: false }, priority: { id: prio, auto } });

test.beforeEach(() => {
  settingValues = SettingDefinitions.reduce((r, d) => ({ ...r, [d.key]: d.default_value }), {});
});

test('pauses with PAUSED_FORCE, resumes to the saved priority, logs both', async () => {
  const bundles = [ b(1, 'D:\\dl\\A\\', 5), b(2, 'D:\\dl\\B\\', 3, true), b(3, 'E:\\dl\\C\\', 4) ];
  const free = { 'D:\\dl\\A\\': 4, 'D:\\dl\\B\\': 4, 'E:\\dl\\C\\': 100 };
  const client = fakeClient(bundles, free);
  const main = createMain(client.socket, newExtension(tmpDir()));

  await main.check();
  assert.deepEqual(client.calls, [ [ 1, 0 ], [ 2, 0 ] ]);
  assert.equal(client.events.length, 1);
  assert.match(client.events[0].text, /paused 2 download\(s\), 4\.0 GiB free is below the 10 GiB limit/);
  assert.equal(client.events[0].severity, 'warning');

  await main.check(); // still low: nothing new
  assert.equal(client.calls.length, 2);

  free['D:\\dl\\A\\'] = free['D:\\dl\\B\\'] = 20;
  await main.check();
  assert.deepEqual(client.calls.slice(2), [ [ 1, 5 ], [ 2, -1 ] ]);
  assert.match(client.events[1].text, /resumed 2 download\(s\)/);
  assert.deepEqual(main.getPaused(), {});
});

test('the record survives a restart: the new process resumes what the old one paused', async () => {
  const dir = tmpDir();
  const bundles = [ b(7, 'D:\\x\\', 6) ];
  const free = { 'D:\\x\\': 1 };
  const first = fakeClient(bundles, free);
  await createMain(first.socket, newExtension(dir)).check();
  assert.deepEqual(first.calls, [ [ 7, 0 ] ]);
  assert.ok(fs.existsSync(path.join(dir, 'paused-bundles.json')));

  // New process, same config dir: its first check (run by onStart) resumes
  free['D:\\x\\'] = 50;
  const second = fakeClient(bundles, free);
  const ext = newExtension(dir);
  createMain(second.socket, ext);
  await ext.onStart();
  ext.onStop();
  assert.deepEqual(second.calls, [ [ 7, 6 ] ]);
});

test('every pause is on disk before its call is made', async () => {
  const dir = tmpDir();
  const bundles = [ b(1, 'D:\\a\\', 4), b(2, 'D:\\b\\', 5) ];
  const client = fakeClient(bundles, { 'D:\\a\\': 1, 'D:\\b\\': 1 });
  const seenOnDisk = [];
  const realPost = client.socket.post;
  client.socket.post = async (url, body) => {
    if (url.endsWith('/priority')) {
      seenOnDisk.push(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'paused-bundles.json'), 'utf8')).paused).sort());
    }
    return realPost(url, body);
  };
  await createMain(client.socket, newExtension(dir)).check();
  // Already at the FIRST call, both pauses were recorded: a crash mid-loop loses none
  assert.deepEqual(seenOnDisk, [ [ '1', '2' ], [ '1', '2' ] ]);
});

test('a resume that fails for a passing reason is retried; a 404 forgets', async () => {
  const bundles = [ b(1, 'D:\\a\\', 4), b(2, 'D:\\b\\', 5) ];
  const free = { 'D:\\a\\': 1, 'D:\\b\\': 1 };
  const client = fakeClient(bundles, free);
  const main = createMain(client.socket, newExtension(tmpDir()));
  await main.check();
  assert.deepEqual(Object.keys(main.getPaused()).sort(), [ '1', '2' ]);

  free['D:\\a\\'] = free['D:\\b\\'] = 50;
  const realPost = client.socket.post;
  client.socket.post = async (url, body) => {
    if (url === 'queue/bundles/1/priority') throw { message: 'Request timed out', code: undefined };
    if (url === 'queue/bundles/2/priority') throw { message: 'Bundle not found', code: 404 };
    return realPost(url, body);
  };
  await main.check();
  assert.deepEqual(Object.keys(main.getPaused()), [ '1' ]);

  client.socket.post = realPost;
  await main.check();
  assert.deepEqual(main.getPaused(), {});
  assert.deepEqual(client.calls.slice(-1), [ [ 1, 4 ] ]);
});

test('the user raising a paused download while still low is not overruled', async () => {
  const bundles = [ b(1, 'D:\\a\\', 4) ];
  const free = { 'D:\\a\\': 1 };
  const client = fakeClient(bundles, free);
  const main = createMain(client.socket, newExtension(tmpDir()));
  await main.check();
  bundles[0].priority = { id: 4, auto: false }; // set back to Normal by hand
  await main.check();
  await main.check();
  assert.deepEqual(client.calls, [ [ 1, 0 ] ]);
  assert.deepEqual(main.getReleased(), { 1: true });
  // Space returns, then runs out again: the guard protects it once more
  free['D:\\a\\'] = 50;
  await main.check();
  assert.deepEqual(main.getReleased(), {});
  free['D:\\a\\'] = 1;
  await main.check();
  assert.deepEqual(client.calls, [ [ 1, 0 ], [ 1, 0 ] ]);
});

test('a bundle the user re-prioritised while paused is left alone', async () => {
  const bundles = [ b(1, 'D:\\a\\', 4) ];
  const free = { 'D:\\a\\': 1 };
  const client = fakeClient(bundles, free);
  const main = createMain(client.socket, newExtension(tmpDir()));
  await main.check();
  bundles[0].priority = { id: 6, auto: false }; // user raised it by hand
  free['D:\\a\\'] = 50;
  await main.check();
  assert.deepEqual(client.calls, [ [ 1, 0 ] ]);
  assert.deepEqual(main.getPaused(), {});
});

test('a failed pause call is not recorded as the guard\'s own', async () => {
  const bundles = [ b(1, 'D:\\a\\', 4) ];
  const client = fakeClient(bundles, { 'D:\\a\\': 1 });
  const realPost = client.socket.post;
  client.socket.post = async (url, body) => {
    if (url.endsWith('/priority')) throw new Error('Bundle not found');
    return realPost(url, body);
  };
  const main = createMain(client.socket, newExtension(tmpDir()));
  await main.check();
  assert.deepEqual(main.getPaused(), {});
  assert.equal(client.events.length, 0);
});

test('a corrupt state file starts empty instead of crashing', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'paused-bundles.json'), '{not json');
  const client = fakeClient([], {});
  const ext = newExtension(dir);
  const main = createMain(client.socket, ext);
  await ext.onStart();
  ext.onStop();
  assert.deepEqual(main.getPaused(), {});
});

test('log_actions off: no event messages', async () => {
  settingValues.log_actions = false;
  const client = fakeClient([ b(1, 'D:\\a\\', 4) ], { 'D:\\a\\': 1 });
  await createMain(client.socket, newExtension(tmpDir())).check();
  assert.equal(client.calls.length, 1);
  assert.equal(client.events.length, 0);
});
