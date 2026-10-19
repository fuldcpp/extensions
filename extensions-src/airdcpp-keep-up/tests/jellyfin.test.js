'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createJellyfin } = require('../src/jellyfin');

const respond = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });

const setup = ({ creds = { username: 'ann', password: 'pw', deviceId: 'dev1', client: 'airdcpp-keep-up', version: '1.0.0' }, handler, token = null } = {}) => {
  const calls = [];
  let stored = token;
  let clock = 1000;
  const jf = createJellyfin({
    getBaseUrl: async () => 'http://127.0.0.1:8096/',
    getCredentials: () => creds,
    loadToken: () => stored,
    saveToken: (t) => { stored = t; },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return handler(url, options, calls.length);
    },
    now: () => clock,
  });
  return { jf, calls, stored: () => stored, tick: (ms) => { clock += ms; } };
};

test('signs in by name, keeps the token, sends it as X-Emby-Token and in Authorization; no redirects', async () => {
  const t = setup({ handler: (url) => (url.endsWith('/Users/AuthenticateByName') ? respond(200, { AccessToken: 'tok1', User: { Id: 'u1' } }) : respond(200, { Items: [] })) });
  const answer = await t.jf.get('/Users/u1/Items', { Recursive: 'true', ParentId: undefined });
  assert.deepEqual(answer, { Items: [] });
  assert.deepEqual(t.stored(), { accessToken: 'tok1', userId: 'u1' });
  const login = t.calls[0];
  assert.equal(login.options.method, 'POST');
  assert.deepEqual(JSON.parse(login.options.body), { Username: 'ann', Pw: 'pw' });
  assert.match(login.options.headers.Authorization, /^MediaBrowser Client="airdcpp-keep-up", Device="FulDC\+\+ extension", DeviceId="dev1", Version="1.0.0"$/);
  const get = t.calls[1];
  assert.equal(get.url, 'http://127.0.0.1:8096/Users/u1/Items?Recursive=true');
  assert.equal(get.options.headers['X-Emby-Token'], 'tok1');
  assert.match(get.options.headers.Authorization, /Token="tok1"/);
  assert.equal(get.options.redirect, 'error');
  assert.equal(await t.jf.userId(), 'u1');
  assert.equal(t.calls.length, 2, 'no second sign-in');
});

test('a 401 on a stored token signs in again once and retries', async () => {
  const t = setup({
    token: { accessToken: 'old', userId: 'u1' },
    handler: (url, options) => {
      if (url.endsWith('/AuthenticateByName')) return respond(200, { AccessToken: 'new', User: { Id: 'u1' } });
      return options.headers['X-Emby-Token'] === 'new' ? respond(200, { ok: 1 }) : respond(401);
    },
  });
  assert.deepEqual(await t.jf.get('/x'), { ok: 1 });
  assert.equal(t.stored().accessToken, 'new');
  assert.equal(t.calls.length, 3);
});

test('a refused sign-in pauses further sign-ins for 10 minutes; errors carry no URL or secret', async () => {
  const t = setup({ handler: () => respond(401) });
  await assert.rejects(t.jf.get('/x'), (e) => e.status === 401 && !/127\.0\.0\.1|pw/.test(e.message));
  await assert.rejects(t.jf.get('/x'), /paused/);
  assert.equal(t.calls.length, 1);
  t.tick(11 * 60 * 1000);
  await assert.rejects(t.jf.get('/x'));
  assert.equal(t.calls.length, 2);
});

test('a pasted token is used as-is, never replaced by a sign-in; its user comes from /Users/Me', async () => {
  const t = setup({
    creds: { token: 'pasted', deviceId: 'd' },
    handler: (url, options) => {
      if (url.endsWith('/Users/Me')) return respond(200, { Id: 'me1' });
      return respond(401);
    },
  });
  assert.equal(await t.jf.userId(), 'me1');
  assert.equal(t.calls[0].options.headers['X-Emby-Token'], 'pasted');
  assert.equal(t.stored().pasted.length, 16, 'a fingerprint, not the token');
  assert.notEqual(t.stored().pasted, 'pasted');
  await assert.rejects(t.jf.get('/x'), (e) => e.status === 401);
  assert.equal(t.calls.filter((c) => c.url.includes('Authenticate')).length, 0);
});

test('network failure is reported without the address', async () => {
  const t = setup({ handler: () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8096'); } });
  await assert.rejects(t.jf.get('/x'), (e) => e.message === 'could not connect to the media server');
});
