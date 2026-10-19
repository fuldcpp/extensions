'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { GIB } = require('../src/rules');
const { effectiveLimits, evaluate, shouldWarn, rulesReport } = require('../src/evaluate');
const { parseRulesCommand } = require('../src/commands');

const L = (rule, value, source = 'chat') => ({ [rule]: { value, source, at: 1 } });
const hubs = (normal, registered = 0, op = 0) => ({ normal, registered, op });

test('the strongest source wins: you > kick > hub message > hub list', () => {
  const record = { limits: {
    hublist: { min_share: { value: 10 * GIB }, max_hubs: { value: 5 } },
    chat: { min_share: { value: 20 * GIB } },
    kick: { min_share: { value: 30 * GIB } },
    user: { min_slots: { value: 2 } },
  } };
  const limits = effectiveLimits(record);
  assert.deepEqual([ limits.min_share.value, limits.min_share.source ], [ 30 * GIB, 'kick' ]);
  assert.deepEqual([ limits.max_hubs.value, limits.max_hubs.source ], [ 5, 'hublist' ]);
  assert.equal(limits.min_slots.source, 'user');
  record.limits.user.min_share = { value: 1 * GIB };
  assert.equal(effectiveLimits(record).min_share.source, 'user');
  assert.deepEqual(effectiveLimits(null), {});
});

test('share below, close to, and well above the minimum', () => {
  const limits = L('min_share', 100 * GIB);
  assert.equal(evaluate(limits, { share: 99 * GIB })[0].level, 'below');
  assert.equal(evaluate(limits, { share: 103 * GIB }, { shareMarginPercent: 5 })[0].level, 'near');
  assert.deepEqual(evaluate(limits, { share: 103 * GIB }, { shareMarginPercent: 0 }), []);
  assert.deepEqual(evaluate(limits, { share: 106 * GIB }, { shareMarginPercent: 5 }), []);
  assert.deepEqual(evaluate(limits, { share: 100 * GIB }, { shareMarginPercent: 0 }), []); // exactly the minimum is fine
  assert.deepEqual(evaluate(limits, {}), []); // unknown value: no claim
});

test('slots, hubs, classes and ratio', () => {
  assert.equal(evaluate(L('min_slots', 3), { slots: 2 })[0].rule, 'min_slots');
  assert.deepEqual(evaluate(L('min_slots', 3), { slots: 3 }), []);
  assert.equal(evaluate(L('max_slots', 10), { slots: 11 })[0].level, 'above');
  assert.equal(evaluate(L('max_hubs', 10), { hubs: hubs(8, 2, 1) })[0].mine, 11);
  assert.deepEqual(evaluate(L('max_hubs', 10), { hubs: hubs(8, 2, 0) }), []); // at the limit is allowed
  // per class only with exact counts
  assert.equal(evaluate(L('max_hubs_registered', 1), { hubs: hubs(1, 2, 0), hubsExact: true })[0].rule, 'max_hubs_registered');
  assert.deepEqual(evaluate(L('max_hubs_normal', 3), { hubs: hubs(5, 0, 0), hubsExact: false }), []);
  const ratio = evaluate(L('min_slot_ratio', 1), { slots: 3, hubs: hubs(4, 0, 0) });
  assert.match(ratio[0].text, /3 slot\(s\) for 4 hubs \(0.75 per hub\)/);
  assert.deepEqual(evaluate(L('min_slot_ratio', 0.5), { slots: 3, hubs: hubs(4, 0, 0) }), []);
});

test('one warning per rule and interval; getting worse warns again', () => {
  const f = { rule: 'min_share', level: 'below' };
  assert.ok(shouldWarn({}, f, 1000, 3600));
  assert.ok(!shouldWarn({ min_share: { at: 1000, level: 'below' } }, f, 1000 + 3599, 3600));
  assert.ok(shouldWarn({ min_share: { at: 1000, level: 'below' } }, f, 1000 + 3600, 3600));
  assert.ok(shouldWarn({ min_share: { at: 1000, level: 'near' } }, f, 1001, 3600));
  assert.ok(!shouldWarn({ min_share: { at: 1000, level: 'below' } }, { rule: 'min_share', level: 'near' }, 1001, 3600));
});

test('/rules report lists limits, our values and the last kick', () => {
  const record = { limits: { chat: { min_share: { value: 100 * GIB } }, user: { max_hubs: { value: 10 } } }, kick: { at: 0, rules: [ 'min_share' ], limits: { min_share: 100 * GIB } } };
  const savedTz = process.env.TZ;
  process.env.TZ = 'UTC'; // dates are local time; pin the zone
  let lines;
  try {
    lines = rulesReport('Hub A', record, { share: 50 * GIB, slots: 3, hubs: hubs(4, 1, 0), hubsExact: true });
  } finally {
    if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz;
  }
  assert.deepEqual(lines, [
    'Rules known for Hub A:',
    '  min share 100.0 GiB (hub message): yours 50.0 GiB  <- NOT MET',
    '  max hubs 10 (set by you): yours 5',
    '  Last disconnect for a rule (1970-01-01 00:00): min share 100.0 GiB',
  ]);
  assert.match(rulesReport('Hub B', null, {}).join('\n'), /none yet/);
});

test('/rules command parsing', () => {
  assert.deepEqual(parseRulesCommand([]), { action: 'show' });
  assert.deepEqual(parseRulesCommand([ 'set', 'minshare', '50GB' ]), { action: 'set', limits: { min_share: 50 * GIB } });
  assert.deepEqual(parseRulesCommand([ 'set', 'minshare', '50', 'GB' ]), { action: 'set', limits: { min_share: 50 * GIB } });
  assert.deepEqual(parseRulesCommand([ 'SET', 'MaxHubs', '10' ]), { action: 'set', limits: { max_hubs: 10 } });
  assert.deepEqual(parseRulesCommand([ 'set', 'hubs', '10/5/3' ]), { action: 'set', limits: { max_hubs_normal: 10, max_hubs_registered: 5, max_hubs_op: 3 } });
  assert.deepEqual(parseRulesCommand([ 'set', 'slotratio', '0,5' ]), { action: 'set', limits: { min_slot_ratio: 0.5 } });
  assert.equal(parseRulesCommand([ 'set', 'minshare', '50' ]).action, 'error');
  assert.equal(parseRulesCommand([ 'set', 'minslots', '0' ]).action, 'error');
  assert.equal(parseRulesCommand([ 'set', 'bogus', '1' ]).action, 'error');
  assert.equal(parseRulesCommand([ 'set' ]).action, 'error');
  assert.deepEqual(parseRulesCommand([ 'clear', 'all' ]), { action: 'clear', rules: null });
  assert.deepEqual(parseRulesCommand([ 'clear', 'minshare' ]), { action: 'clear', rules: [ 'min_share' ] });
  assert.equal(parseRulesCommand([ 'forget' ]).action, 'forget');
  assert.equal(parseRulesCommand([ 'help' ]).action, 'help');
  assert.equal(parseRulesCommand([ 'what' ]).action, 'error');
});

test('live test: dates in status lines are local time, not UTC', () => {
  // The kick notice read "On 2026-10-18 21:54" on a machine at 23:54 (UTC+2): toISOString is UTC
  const { formatDate } = require('../src/evaluate');
  const saved = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Tokyo'; // UTC+9, no daylight saving
    assert.equal(formatDate(Date.UTC(2026, 9, 18, 21, 54) / 1000), '2026-10-19 06:54');
    process.env.TZ = 'UTC';
    assert.equal(formatDate(Date.UTC(2026, 0, 5, 3, 7) / 1000), '2026-01-05 03:07');
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
});
