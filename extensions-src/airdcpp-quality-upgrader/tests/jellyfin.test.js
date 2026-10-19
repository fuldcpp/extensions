'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createJellyfin, baseUrlFromStatus } = require('../src/jellyfin');

const response = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });

const setup = ({ credentials = { username: 'me', password: 'secret' }, stored = null, handler } = {}) => {
  const calls = [];
  let saved = stored;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(new URL(url), init, calls.length);
  };

  const client = createJellyfin({
    getBaseUrl: async () => 'http://127.0.0.1:8096',
    getCredentials: async () => credentials,
    loadToken: async () => saved,
    saveToken: async (v) => { saved = v; },
    fetchImpl,
    device: { client: 'airdcpp-quality-upgrader', deviceId: 'dev1', version: '1.0.0' },
  });
  return { client, calls, saved: () => saved };
};

test('signs in by name, sends the token in the Authorization header, stores it', async () => {
  const t = setup({ handler: (url, init) => {
    if (url.pathname === '/Users/AuthenticateByName') {
      assert.deepEqual(JSON.parse(init.body), { Username: 'me', Pw: 'secret' });
      assert.doesNotMatch(init.headers.Authorization, /Token=/);
      return response(200, { AccessToken: 'tok1', User: { Id: 'u1' } });
    }

    assert.match(init.headers.Authorization, /^MediaBrowser Client="airdcpp-quality-upgrader", Device="FulDC\+\+ extension", DeviceId="dev1", Version="1\.0\.0", Token="tok1"$/);
    assert.equal(init.redirect, 'error');
    assert.equal(url.searchParams.get('Recursive'), 'true');
    return response(200, { Items: [] });
  } });

  assert.deepEqual(await t.client.get('/Users/u1/Items', { Recursive: true, Skip: undefined }), { Items: [] });
  assert.deepEqual(t.saved(), { accessToken: 'tok1', userId: 'u1' });
  assert.equal(await t.client.userId(), 'u1');
  assert.equal(t.calls.length, 2);
});

test('a stored token is used without signing in; a 401 signs in again exactly once', async () => {
  let n = 0;
  const t = setup({ stored: { accessToken: 'old', userId: 'u1' }, handler: (url, init) => {
    if (url.pathname === '/Users/AuthenticateByName') {
      n++;
      return response(200, { AccessToken: 'new', User: { Id: 'u1' } });
    }

    return /Token="old"/.test(init.headers.Authorization) ? response(401) : response(200, { ok: 1 });
  } });

  assert.deepEqual(await t.client.get('/x'), { ok: 1 });
  assert.equal(n, 1);
  assert.equal(t.saved().accessToken, 'new');
});

test('a 401 after signing in again is thrown, not looped', { timeout: 5000 }, async () => {
  let logins = 0;
  const t = setup({ handler: (url) => {
    if (url.pathname === '/Users/AuthenticateByName') {
      logins++;
      // A loop would never end on its own (all microtasks): stop it so the test fails cleanly
      if (logins > 5) throw new Error('sign-in loop');
      return response(200, { AccessToken: `t${logins}`, User: { Id: 'u1' } });
    }

    return response(401);
  } });

  await assert.rejects(t.client.get('/x'), { status: 401 });
  assert.equal(logins, 2);
});

test('a wrong password throws 401 with no secret in the message', async () => {
  const t = setup({ handler: () => response(401) });
  const error = await t.client.get('/x').catch((e) => e);
  assert.equal(error.status, 401);
  assert.equal(error.message, 'media server: HTTP 401');
});

test('a pasted token is checked with /Users/Me', async () => {
  const t = setup({ credentials: { token: 'pasted' }, handler: (url, init) => {
    assert.match(init.headers.Authorization, /Token="pasted"/);
    return url.pathname === '/Users/Me' ? response(200, { Id: 'u9' }) : response(204);
  } });

  assert.equal(await t.client.post('/UserItems/abc/UserData', { Played: true }), null);
  assert.deepEqual(t.saved(), { accessToken: 'pasted', userId: 'u9' });
});

test('connection failures carry status 0 and only a code', async () => {
  const t = setup({ stored: { accessToken: 'a', userId: 'u' }, handler: () => {
    throw Object.assign(new TypeError('fetch failed http://127.0.0.1:8096/x?api_key=SECRET'), { cause: { code: 'ECONNREFUSED' } });
  } });

  const error = await t.client.get('/x').catch((e) => e);
  assert.equal(error.status, 0);
  assert.equal(error.message, 'media server: ECONNREFUSED');
});

test('no login configured: 401 without calling the server', async () => {
  const t = setup({ credentials: {}, handler: () => assert.fail('no call expected') });
  await assert.rejects(t.client.get('/x'), { status: 401 });
});

test('quotes in a device field cannot break the header', async () => {
  let header = '';
  const client = createJellyfin({
    getBaseUrl: async () => 'http://127.0.0.1:1',
    getCredentials: async () => ({}),
    loadToken: async () => ({ accessToken: 't"x', userId: 'u' }),
    saveToken: async () => {},
    fetchImpl: async (url, init) => { header = init.headers.Authorization; return response(200, {}); },
    device: { deviceId: 'a"b\r\nX: y' },
  });
  await client.get('/x');
  assert.doesNotMatch(header, /[\r\n]/);
  assert.match(header, /DeviceId="abX: y"/);
  assert.match(header, /Token="tx"/);
});

test('base URL from the media_server status', () => {
  assert.equal(baseUrlFromStatus({ running: true, address: 'http://0.0.0.0:8096', port: 8096 }), 'http://127.0.0.1:8096');
  assert.equal(baseUrlFromStatus({ running: true, address: 'http://192.168.1.5:8097', port: 8097 }), 'http://192.168.1.5:8097');
  assert.equal(baseUrlFromStatus({ running: true, address: 'http://[::]:8096', port: 8096 }), 'http://127.0.0.1:8096');
  assert.equal(baseUrlFromStatus({ running: true, address: '', port: 8096 }), 'http://127.0.0.1:8096');
  assert.equal(baseUrlFromStatus({ running: false, address: 'http://0.0.0.0:8096' }), null);
  assert.equal(baseUrlFromStatus({ running: true, address: 'https://evil.example/x' }), null);
  assert.equal(baseUrlFromStatus(null), null);
});
