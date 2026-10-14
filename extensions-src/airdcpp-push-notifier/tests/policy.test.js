'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseClock, isQuietTime, createPolicy } = require('../src/policy');

const at = (h, m) => new Date(2026, 9, 14, h, m, 0);

const limits = (overrides = {}) => ({ cooldownSeconds: 60, maxPerMinute: 3, quietStart: '', quietEnd: '', ...overrides });

test('parseClock', () => {
  assert.equal(parseClock('07:30'), 450);
  assert.equal(parseClock('7:05'), 425);
  assert.equal(parseClock('24:00'), null);
  assert.equal(parseClock('12:60'), null);
  assert.equal(parseClock(''), null);
  assert.equal(parseClock('noon'), null);
});

test('quiet hours inside one day', () => {
  assert.equal(isQuietTime(at(13, 0), '12:00', '14:00'), true);
  assert.equal(isQuietTime(at(14, 0), '12:00', '14:00'), false);
  assert.equal(isQuietTime(at(11, 59), '12:00', '14:00'), false);
});

test('quiet hours across midnight', () => {
  assert.equal(isQuietTime(at(23, 0), '22:00', '07:00'), true);
  assert.equal(isQuietTime(at(3, 0), '22:00', '07:00'), true);
  assert.equal(isQuietTime(at(7, 0), '22:00', '07:00'), false);
  assert.equal(isQuietTime(at(12, 0), '22:00', '07:00'), false);
});

test('quiet hours disabled by empty, malformed or equal ends', () => {
  assert.equal(isQuietTime(at(3, 0), '', '07:00'), false);
  assert.equal(isQuietTime(at(3, 0), 'x', '07:00'), false);
  assert.equal(isQuietTime(at(3, 0), '07:00', '07:00'), false);
});

test('cooldown holds back a repeat from the same source only', () => {
  let t = at(12, 0).getTime();
  const policy = createPolicy({ now: () => t });
  assert.equal(policy.check({ key: 'pm:a' }, limits()).send, true);
  assert.deepEqual(policy.check({ key: 'pm:a' }, limits()), { send: false, reason: 'cooldown' });
  assert.equal(policy.check({ key: 'pm:b' }, limits()).send, true);
  t += 61 * 1000;
  assert.equal(policy.check({ key: 'pm:a' }, limits()).send, true);
});

test('a cooldown-blocked notification does not use up the rate limit', () => {
  const t = at(12, 0).getTime();
  const policy = createPolicy({ now: () => t });
  policy.check({ key: 'a' }, limits());
  for (let i = 0; i < 10; i++) {
    policy.check({ key: 'a' }, limits());
  }

  assert.equal(policy.check({ key: 'b' }, limits()).send, true);
  assert.equal(policy.check({ key: 'c' }, limits()).send, true);
});

test('rate limit per minute counts what it dropped', () => {
  let t = at(12, 0).getTime();
  const policy = createPolicy({ now: () => t });
  const l = limits({ cooldownSeconds: 0 });
  assert.equal(policy.check({ key: '1' }, l).send, true);
  assert.equal(policy.check({ key: '2' }, l).send, true);
  assert.equal(policy.check({ key: '3' }, l).send, true);
  assert.deepEqual(policy.check({ key: '4' }, l), { send: false, reason: 'rate_limit' });
  assert.deepEqual(policy.check({ key: '5' }, l), { send: false, reason: 'rate_limit' });
  assert.equal(policy.takeSuppressed(), 2);
  assert.equal(policy.takeSuppressed(), 0);
  t += 60 * 1000;
  assert.equal(policy.check({ key: '6' }, l).send, true);
});

test('quiet hours block everything', () => {
  const t = at(23, 30).getTime();
  const policy = createPolicy({ now: () => t });
  assert.deepEqual(policy.check({ key: 'x' }, limits({ quietStart: '22:00', quietEnd: '07:00' })), { send: false, reason: 'quiet_hours' });
});
