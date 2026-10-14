'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SENDERS, createDispatcher, describeError } = require('../src/senders');

const sender = (id) => SENDERS.find((s) => s.id === id);
const n = { kind: 'private_message', key: 'pm:x', title: 'Private message from ålice', body: '@everyone **look** <b>' };

test('ntfy publishes JSON to the server root (no title header)', () => {
  const { url, init } = sender('ntfy').buildRequest({ ntfy_server: 'https://ntfy.example/', ntfy_topic: ' t1 ', ntfy_token: '' }, n);
  assert.equal(url, 'https://ntfy.example');
  const body = JSON.parse(init.body);
  assert.equal(body.topic, 't1');
  assert.equal(body.title, n.title);
  assert.equal(body.priority, 4);
  assert.equal(init.headers.Authorization, undefined);
  assert.equal(init.headers.Title, undefined);
});

test('ntfy token becomes a bearer header', () => {
  const { init } = sender('ntfy').buildRequest({ ntfy_server: 'https://ntfy.example', ntfy_topic: 't', ntfy_token: 'tk_1' }, n);
  assert.equal(init.headers.Authorization, 'Bearer tk_1');
});

test('discord disables every mention and escapes the title markup', () => {
  const { init } = sender('discord').buildRequest({ discord_webhook: 'https://discord.com/api/webhooks/1/abc' }, { ...n, title: '*bold*' });
  const body = JSON.parse(init.body);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.ok(body.content.startsWith('**\\*bold\\***'));
  assert.ok(body.content.length <= 2000);
});

test('discord accepts only discord webhook URLs', () => {
  assert.equal(sender('discord').isConfigured({ discord_webhook: 'https://discord.com/api/webhooks/1/abc' }), true);
  assert.equal(sender('discord').isConfigured({ discord_webhook: 'https://evil.example/api/webhooks/1' }), false);
  assert.equal(sender('discord').isConfigured({ discord_webhook: 'http://discord.com/api/webhooks/1/abc' }), false);
});

test('telegram sends plain text (no parse_mode)', () => {
  const { url, init } = sender('telegram').buildRequest({ telegram_bot_token: '123:abc-DEF', telegram_chat_id: '42' }, n);
  assert.equal(url, 'https://api.telegram.org/bot123:abc-DEF/sendMessage');
  const body = JSON.parse(init.body);
  assert.equal(body.parse_mode, undefined);
  assert.equal(body.text, `${n.title}\n${n.body}`);
});

test('unconfigured services are skipped', () => {
  for (const s of SENDERS) {
    assert.equal(s.isConfigured({}), false, s.id);
  }
});

const okResponse = () => ({ ok: true, status: 200, body: null });

test('dispatcher sends only to configured services', async () => {
  const calls = [];
  const d = createDispatcher({ fetchImpl: async (url) => { calls.push(url); return okResponse(); }, onFailure: () => assert.fail('no failure expected'), sleep: async () => {} });
  const result = await d.dispatch({ webhook_url: 'http://127.0.0.1:9/hook' }, n);
  assert.deepEqual(result, { attempted: 1, delivered: 1 });
  assert.deepEqual(calls, [ 'http://127.0.0.1:9/hook' ]);
});

test('dispatcher retries a 5xx once, not a 4xx', async () => {
  let calls = 0;
  const failures = [];
  const d = createDispatcher({
    fetchImpl: async () => { calls++; return { ok: false, status: 503 }; },
    onFailure: (s, reason) => failures.push(reason),
    sleep: async () => {},
  });
  await d.dispatch({ webhook_url: 'http://h/x' }, n);
  assert.equal(calls, 2);
  assert.deepEqual(failures, [ 'HTTP 503' ]);

  calls = 0;
  const d2 = createDispatcher({ fetchImpl: async () => { calls++; return { ok: false, status: 401 }; }, onFailure: () => {}, sleep: async () => {} });
  await d2.dispatch({ webhook_url: 'http://h/x' }, n);
  assert.equal(calls, 1);
});

test('a failing service is reported once per streak, again after it recovered', async () => {
  let fail = true;
  const failures = [];
  const recovered = [];
  const d = createDispatcher({
    fetchImpl: async () => (fail ? { ok: false, status: 500 } : okResponse()),
    onFailure: (s) => failures.push(s.id),
    onRecovered: (s) => recovered.push(s.id),
    sleep: async () => {},
  });
  const s = { webhook_url: 'http://h/x' };
  for (let i = 0; i < 5; i++) {
    await d.dispatch(s, n);
  }

  assert.deepEqual(failures, [ 'webhook' ]);
  fail = false;
  await d.dispatch(s, n);
  assert.deepEqual(recovered, [ 'webhook' ]);
  fail = true;
  await d.dispatch(s, n);
  assert.deepEqual(failures, [ 'webhook', 'webhook' ]);
});

test('discord escapes markdown and masked links in the body', () => {
  const { init } = sender('discord').buildRequest({ discord_webhook: 'https://discord.com/api/webhooks/1/abc' },
    { ...n, body: '[https://bank.example](https://evil.example)\n# big' });
  const content = JSON.parse(init.body).content;
  assert.ok(content.includes('\\[https://bank.example\\]\\(https://evil.example\\)'), content);
  assert.ok(content.includes('\\# big'), content);
});

test('tokens outside printable ASCII leave the service unconfigured', () => {
  assert.equal(sender('gotify').isConfigured({ gotify_url: 'https://g', gotify_token: 'abc’' }), false);
  assert.equal(sender('gotify').isConfigured({ gotify_url: 'https://g', gotify_token: 'abc' }), true);
  assert.equal(sender('ntfy').isConfigured({ ntfy_server: 'https://n', ntfy_topic: 't', ntfy_token: 'a b' }), false);
  assert.equal(sender('ntfy').isConfigured({ ntfy_server: 'https://n', ntfy_topic: 't', ntfy_token: '' }), true);
  assert.equal(sender('pushover').isConfigured({ pushover_app_token: 'a\nb', pushover_user_key: 'u' }), false);
});

test('failure reasons come from an allow-list and never echo a token or URL', () => {
  const leaky = new TypeError('Headers.append: "Bearer tk_SECRET\nX" is an invalid header value.');
  assert.equal(describeError(leaky), 'request failed');
  const withCause = new TypeError('fetch failed');
  withCause.cause = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:9 https://api.telegram.org/bot123:SECRET' };
  assert.equal(describeError(withCause), 'ECONNREFUSED');
  const oddCode = new TypeError('fetch failed');
  oddCode.cause = { code: 'tk_SECRET value' };
  assert.equal(describeError(oddCode), 'request failed');
});

test('a redirect is refused, not followed (real fetch)', async () => {
  const http = require('node:http');
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    res.writeHead(302, { Location: 'http://127.0.0.1:1/elsewhere', 'Content-Length': '0' });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const failures = [];
  try {
    const d = createDispatcher({ fetchImpl: fetch, onFailure: (s, reason) => failures.push(reason), sleep: async () => {} });
    const result = await d.dispatch({ webhook_url: `http://127.0.0.1:${server.address().port}/hook` }, n);
    assert.deepEqual(result, { attempted: 1, delivered: 0 });
    assert.deepEqual(failures, [ 'redirected (enter the final https address)' ]);
  } finally {
    server.close();
  }

  assert.ok(hits >= 1);
});

test('a non-ok response body is cancelled', async () => {
  let cancelled = 0;
  const d = createDispatcher({
    fetchImpl: async () => ({ ok: false, status: 400, body: { cancel: async () => { cancelled++; } } }),
    onFailure: () => {}, sleep: async () => {},
  });
  await d.dispatch({ webhook_url: 'http://h/x' }, n);
  assert.equal(cancelled, 1);
});

test('a thrown network error never escapes dispatch', async () => {
  const d = createDispatcher({ fetchImpl: async () => { throw new TypeError('fetch failed'); }, onFailure: () => {}, sleep: async () => {} });
  const result = await d.dispatch({ webhook_url: 'http://h/x', gotify_url: 'http://g', gotify_token: 't' }, n);
  assert.deepEqual(result, { attempted: 2, delivered: 0 });
});
