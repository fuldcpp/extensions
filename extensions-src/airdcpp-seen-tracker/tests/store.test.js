'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createStore, formatAgo, answer, MAX_ENTRIES } = require('../src/store');

const user = (nick, cid, hub = 'Hub A', flags = []) => ({ nick, cid, hub_name: hub, flags });

test('formatAgo keeps the two largest units', () => {
  assert.equal(formatAgo(30), 'less than a minute');
  assert.equal(formatAgo(60), '1 minute');
  assert.equal(formatAgo(3 * 3600 + 120), '3 hours 2 minutes');
  assert.equal(formatAgo(86400 + 3600 + 60), '1 day 1 hour');
  assert.equal(formatAgo(2 * 86400 + 300), '2 days');
  assert.equal(formatAgo(16 * 86400), '2 weeks 2 days');
  assert.equal(formatAgo(400 * 86400), '1 year 5 weeks');
  assert.equal(formatAgo(-5), 'less than a minute');
});

test('the latest event per user wins, across hubs and nick changes', () => {
  const s = createStore();
  s.record(user('bob', 'C1', 'Hub A'), 'joined', 100);
  s.record(user('bob', 'C1', 'Hub B'), 'left', 200);
  s.record(user('bobby', 'C1', 'Hub B'), 'joined', 300);
  assert.equal(s.size(), 1);
  assert.deepEqual(s.find('bobby'), [ { nick: 'bobby', hub: 'Hub B', hubUrl: '', at: 300, event: 'joined' } ]);
});

test('own user and incomplete users are not recorded', () => {
  const s = createStore();
  s.record(user('me', 'C0', 'Hub', [ 'self' ]), 'joined', 1);
  s.record({ nick: 'x' }, 'joined', 1);
  s.record(null, 'joined', 1);
  assert.equal(s.size(), 0);
  assert.deepEqual(s.takeChanges(), []);
});

test('find: exact (case-insensitive) first, otherwise partial, newest first', () => {
  const s = createStore();
  s.record(user('Alice', 'C1'), 'left', 100);
  s.record(user('alice_2', 'C2'), 'left', 300);
  s.record(user('malice', 'C3'), 'left', 200);
  assert.deepEqual(s.find('ALICE').map((e) => e.nick), [ 'Alice' ]);
  assert.deepEqual(s.find('lic').map((e) => e.nick), [ 'alice_2', 'malice', 'Alice' ]);
  assert.deepEqual(s.find('  '), []);
});

test('prune drops old records and caps the size', () => {
  const s = createStore();
  s.record(user('old', 'C1'), 'left', 0);
  s.record(user('new', 'C2'), 'left', 400 * 86400);
  s.prune(400 * 86400, 365);
  assert.deepEqual(s.find('old'), []);
  assert.equal(s.find('new').length, 1);

  const big = {};
  for (let i = 0; i < MAX_ENTRIES + 10; i++) big[`C${i}`] = { nick: `n${i}`, hub: 'h', at: i, event: 'left' };
  const s2 = createStore(big);
  s2.prune(MAX_ENTRIES + 10, 3650);
  assert.equal(s2.size(), MAX_ENTRIES);
});

test('the oldest records go first when capping', () => {
  const big = {};
  for (let i = 0; i < MAX_ENTRIES + 3; i++) big[`C${i}`] = { nick: `user${i}`, hub: 'h', at: i, event: 'left' };
  const s = createStore(big);
  s.prune(MAX_ENTRIES + 3, 3650);
  assert.equal(s.find('user0').some((e) => e.nick === 'user0'), false);
  assert.equal(s.find(`user${MAX_ENTRIES + 2}`)[0].nick, `user${MAX_ENTRIES + 2}`);
});

test('answers: online now, last seen, unknown, usage', () => {
  const s = createStore();
  s.record(user('bob', 'C1', 'Hub A'), 'left', 1000);
  assert.equal(answer('bob', s, [ { nick: 'Bob', hub_name: 'Hub B' }, { nick: 'bob', hub_name: 'Hub C' } ], 5000), 'Bob is online now (Hub B, Hub C)');
  assert.equal(answer('bob', s, [], 1000 + 2 * 3600 + 60), 'bob was last seen 2 hours 1 minute ago on Hub A (leaving)');
  assert.match(answer('nobody', s, [], 0), /^No record of nobody\./);
  assert.equal(answer('  ', s, [], 0), 'Usage: /seen <nick>');
});

const { createStore: cs, publicQueryOf, publicAnswer, sanitizeEntries, PUBLIC_PREFIX } = require('../src/store');

test('public queries accept one nick-shaped word only', () => {
  assert.equal(publicQueryOf('!seen bob'), 'bob');
  assert.equal(publicQueryOf('  !SEEN   [VIP]bob  '), '[VIP]bob');
  assert.equal(publicQueryOf('!seen everyone go to http://evil.example, ops are idiots'), null);
  assert.equal(publicQueryOf('!seen ' + 'x'.repeat(65)), null);
  assert.equal(publicQueryOf('!seen'), null);
  assert.equal(publicQueryOf('!seen bob\n/kick op'), null);
});

test('public answers: fixed prefix, no echo, this hub only', () => {
  const s = cs();
  s.record({ nick: '/kick', cid: 'C1', hub_name: 'Hub A', hub_url: 'adc://a', flags: [] }, 'left', 100);
  s.record({ nick: 'bob', cid: 'C2', hub_name: 'Secret Hub', hub_url: 'adc://secret', flags: [] }, 'left', 100);

  // A nick that is a command can never lead the line
  const slash = publicAnswer('/kick', s, [], 'adc://a', 160);
  assert.ok(slash.startsWith(PUBLIC_PREFIX));
  assert.equal(slash, '[seen] /kick was last seen 1 minute ago');

  // bob was only seen on another hub: nothing about that hub, no echo of the query
  assert.equal(publicAnswer('bob', s, [], 'adc://a', 160), '[seen] No record of that nick on this hub.');
  assert.ok(!publicAnswer('bob', s, [], 'adc://a', 160).includes('Secret'));

  // Online here: said without naming hubs
  assert.equal(publicAnswer('Bob', s, [ { nick: 'bob', hub_name: 'Hub A' } ], 'adc://a', 160), '[seen] bob is online now');
});

test('users still there when we stopped seeing the hub become "present" at that time', () => {
  const s = cs();
  s.record({ nick: 'stay', cid: 'C1', hub_name: 'H', flags: [] }, 'joined', 100, 'runA');
  s.record({ nick: 'gone', cid: 'C2', hub_name: 'H', flags: [] }, 'left', 150, 'runA');
  s.record({ nick: 'other', cid: 'C3', hub_name: 'H', flags: [] }, 'joined', 120, 'runB');
  assert.equal(s.markPresentAtShutdown('runA', 900), 1);
  assert.equal(s.find('stay')[0].event, 'present');
  assert.equal(s.find('stay')[0].at, 900);
  assert.equal(s.find('gone')[0].event, 'left');
  assert.equal(s.find('other')[0].event, 'joined');
  assert.match(answer('stay', s, [], 960), /was last seen 1 minute ago on H \(still online when we last saw the hub\)/);
});

test('malformed records are dropped on load instead of breaking /seen', () => {
  const clean = sanitizeEntries({ A: { nick: 'ok', hub: 'h', at: 1, event: 'left' }, B: { nick: 7, at: 1, event: 'left' }, C: null, D: { nick: 'x', at: 'soon', event: 'left' } });
  assert.deepEqual(Object.keys(clean), [ 'A' ]);
  const s = cs({ B: { nick: 7, at: 1, event: 'left' } });
  assert.deepEqual(s.find('7'), []);
});

test('changes taken for a write that failed are put back', () => {
  const s = cs();
  s.record({ nick: 'a', cid: 'C1', hub_name: 'H', flags: [] }, 'left', 1);
  const taken = s.takeChanges();
  assert.equal(s.pendingChanges(), 0);
  s.restoreChanges(taken);
  assert.equal(s.pendingChanges(), 1);
});
