'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { budgetAllows, pruneSearches, pickNext, HOUR_MS } = require('../src/scheduler');

const limits = { perHour: 10, spacingMs: 20000 };

test('the hourly budget and the spacing', () => {
  const now = 10 * HOUR_MS;
  assert.equal(budgetAllows([], now, limits).allowed, true);
  assert.deepEqual(budgetAllows([ now - 5000 ], now, limits), { allowed: false, waitMs: 15000 });
  assert.equal(budgetAllows([ now - 20000 ], now, limits).allowed, true);
  const ten = Array.from({ length: 10 }, (_, i) => now - HOUR_MS + 60000 + i * 60000);
  const verdict = budgetAllows(ten, now, limits);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.waitMs, 60000);
  // Searches older than an hour do not count
  assert.equal(budgetAllows(ten.map((t) => t - HOUR_MS), now, limits).allowed, true);
});

test('a clock that went back does not unlock a flood', () => {
  const now = 10 * HOUR_MS;
  assert.equal(budgetAllows([ now + 30 * 60000 ], now, limits).allowed, false);
});

test('pruning keeps the last hour only', () => {
  const now = 10 * HOUR_MS;
  assert.deepEqual(pruneSearches([ now - 2 * HOUR_MS, now - 1000, now ], now), [ now - 1000, now ]);
});

test('rotation: never checked first, then the oldest; recently checked ones wait', () => {
  const now = 1_000_000 * HOUR_MS;
  const day = 24 * HOUR_MS;
  const items = { a: { lastChecked: now - 10 * day }, b: { lastChecked: now - 20 * day }, c: { lastChecked: now - HOUR_MS } };
  assert.equal(pickNext([ 'a', 'b', 'c', 'd' ], items, now, { recheckMs: 7 * day }), 'd');
  assert.equal(pickNext([ 'a', 'b', 'c' ], items, now, { recheckMs: 7 * day }), 'b');
  assert.equal(pickNext([ 'c' ], items, now, { recheckMs: 7 * day }), null);
  assert.equal(pickNext([ 'a', 'b', 'd' ], items, now, { recheckMs: 7 * day, skip: (k) => k !== 'a' }), 'a');
});

test('a passive sighting jumps the queue, even when checked recently', () => {
  const now = 1_000_000 * HOUR_MS;
  const items = { a: { lastChecked: now - HOUR_MS, priority: now - 1000 }, b: { lastChecked: 0 } };
  assert.equal(pickNext([ 'a', 'b' ], items, now, { recheckMs: 24 * HOUR_MS }), 'a');
  // Once checked after the sighting, it is an ordinary item again
  items.a.lastChecked = now;
  assert.equal(pickNext([ 'a', 'b' ], items, now, { recheckMs: 24 * HOUR_MS }), 'b');
});
