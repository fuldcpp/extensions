'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createJellyfin } = require('../src/jellyfin');

const response = (status, body) => ({
  ok: status >= 200 && status < 300, status,
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});

const setup = ({ password = 'pw', token = '', valid = new Set([ 'T1' ]), issue = [ 'T1' ] } = {}) => {
  const calls = [];
  let stored = '';
  const issued = [ ...issue ];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/Users/AuthenticateByName')) {
      const body = JSON.parse(init.body);
      if (body.Username !== 'me' || body.Pw !== 'pw') return response(401);
      return response(200, { AccessToken: issued.shift() || 'T-extra', User: { Id: 'u1' } });
    }

    const t = init.headers['X-Emby-Token'];
    if (!valid.has(t)) return response(401);
    return response(200, { ok: true, url });
  };

  const jf = createJellyfin({
    getBaseUrl: () => 'http://127.0.0.1:8096/',
    getCredentials: () => ({ username: 'me', password, token, deviceId: 'dev"1' }),
    loadToken: () => stored,
    saveToken: (t) => { stored = t; },
    fetchImpl, client: 'ext', version: '1',
  });
  return { jf, calls, stored: () => stored, setStored: (t) => { stored = t; }, valid };
};

test('signs in once, keeps the token, sends it in both headers, redirects refused', async () => {
  const t = setup();
  const a = await t.jf.get('/Users/Me', { Fields: 'x', Empty: '' });
  await t.jf.get('/Users/Me');
  assert.equal(a.url, 'http://127.0.0.1:8096/Users/Me?Fields=x');
  assert.equal(t.calls.filter((c) => c.url.endsWith('AuthenticateByName')).length, 1);
  assert.equal(t.stored(), 'T1');
  const last = t.calls[t.calls.length - 1].init;
  assert.equal(last.headers['X-Emby-Token'], 'T1');
  assert.match(last.headers.Authorization, /^MediaBrowser Client="ext", Device="FulDC\+\+ extension", DeviceId="dev1", Version="1", Token="T1"$/);
  assert.equal(last.redirect, 'error');
});

test('a refused token is renewed once', async () => {
  const t = setup({ valid: new Set([ 'T2' ]), issue: [ 'T2' ] });
  t.setStored('OLD');
  const answer = await t.jf.get('/Items');
  assert.equal(answer.ok, true);
  assert.equal(t.stored(), 'T2');
});

test('a token refused right after a fresh sign-in is not retried in a loop', async () => {
  const t = setup({ valid: new Set(), issue: [ 'T1', 'T2', 'T3' ] });
  await assert.rejects(t.jf.get('/Items'), (e) => e.status === 401);
  assert.ok(t.calls.length <= 4, `calls: ${t.calls.length}`);
});

test('a refused password is not tried again (the server throttles failed sign-ins)', async () => {
  const t = setup({ password: 'wrong' });
  await assert.rejects(t.jf.get('/Items'), (e) => e.status === 401);
  await assert.rejects(t.jf.get('/Items'), /refused/);
  assert.equal(t.calls.filter((c) => c.url.endsWith('AuthenticateByName')).length, 1);
});

test('a pasted token is used without signing in, and is not "renewed"', async () => {
  const t = setup({ password: '', token: 'T1' });
  assert.equal((await t.jf.get('/Items')).ok, true);
  assert.equal(t.calls.length, 1);
  t.valid.clear();
  await assert.rejects(t.jf.get('/Items'), (e) => e.status === 401);
  assert.equal(t.calls.filter((c) => c.url.endsWith('AuthenticateByName')).length, 0);
});

test('errors never carry the token or the password', async () => {
  const jf = createJellyfin({
    getBaseUrl: () => 'http://127.0.0.1:1',
    getCredentials: () => ({ username: 'me', password: 'SECRETPW', deviceId: 'd' }),
    loadToken: () => 'SECRETTOKEN', saveToken: () => {},
    fetchImpl: async (url, init) => { throw new Error(`boom ${init.headers.Authorization}`); },
  });
  await assert.rejects(jf.get('/x'), (e) => {
    assert.equal(e.status, 0);
    assert.ok(!/SECRET/.test(e.message), e.message);
    return true;
  });
});

test('no address, no credentials: clear errors', async () => {
  const jf = createJellyfin({ getBaseUrl: () => '', getCredentials: () => ({}), loadToken: () => 'x', saveToken: () => {}, fetchImpl: async () => response(200, {}) });
  await assert.rejects(jf.get('/x'), /address is not known/);
  const jf2 = createJellyfin({ getBaseUrl: () => 'http://h', getCredentials: () => ({}), loadToken: () => '', saveToken: () => {}, fetchImpl: async () => response(200, {}) });
  await assert.rejects(jf2.get('/x'), /No media server user name/);
});
