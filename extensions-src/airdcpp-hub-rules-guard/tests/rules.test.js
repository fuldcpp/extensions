'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { GIB, TIB, MIB, parseLimits, ruleNamesIn, isAboutUs, isExplicitKickOf, normalizeHubUrl, parseTag, parseSizeInput, formatBytes } = require('../src/rules');

test('share minimums in the phrasings hub software uses', () => {
  const cases = [
    [ 'Min share: 50 GB', 50 * GIB ],
    [ 'Minimum share is 100 GiB', 100 * GIB ],
    [ 'Min. share 10GB', 10 * GIB ],
    [ 'Minimum share required: 1 TB', TIB ],
    [ 'Your share is too small! Minimum share is 20 GB.', 20 * GIB ],
    [ 'You need to share at least 20 GB to stay here', 20 * GIB ],
    [ 'You share 1.5 GB, but minimum allowed is 5.0 GB', 5 * GIB ],
    [ 'This hub requires a minimum share of 5.00 GiB to search (you share 1.00 GiB).', 5 * GIB ],
    [ 'This hub requires a minimum share of 5,50 GiB to search', 5.5 * GIB ],
    [ 'min share 1,000 GB', 1000 * GIB ],
    [ 'MINIMUM SHARE: 2 TiB', 2 * TIB ],
    [ 'Min share: 500 MB', 500 * MIB ],
    [ 'Min share: 50 GBytes', 50 * GIB ],
  ];
  for (const [ text, bytes ] of cases) {
    assert.equal(parseLimits(text).min_share, bytes, text);
  }
});

test('no clear number and unit: nothing learned', () => {
  for (const text of [
    'Min share: fifty gigabytes',
    'Min share: 50',            // no unit
    'Min share in 5 m',         // bare m (minutes?)
    'User is not sharing enough',
    'I share 500 GB of music',  // not a rule
    'share 1 GB minimum 5 m',
    'Min share: 99999999 TB',   // absurd
  ]) {
    assert.equal(parseLimits(text).min_share, undefined, text);
  }
});

test('one message with a value per user class keeps the most lenient', () => {
  const limits = parseLimits('Min share for regs: 50 GB\nMin share for users: 100 GB\nmax hubs for VIP: 25\nMax hubs: 10');
  assert.equal(limits.min_share, 50 * GIB);
  assert.equal(limits.max_hubs, 25);
});

test('slots, hubs and ratio', () => {
  assert.equal(parseLimits('Min slots: 3').min_slots, 3);
  assert.equal(parseLimits('Min. upload slots: 4').min_slots, 4);
  assert.equal(parseLimits('Too few open slots, min is 2').min_slots, 2);
  assert.equal(parseLimits('Please open at least 5 slots').min_slots, 5);
  assert.equal(parseLimits('Too many open slots, max is 20').max_slots, 20);
  assert.equal(parseLimits('Max slots: 15').max_slots, 15);
  assert.equal(parseLimits('Too many open hubs, max is 10').max_hubs, 10);
  assert.equal(parseLimits('Max hubs: 12').max_hubs, 12);
  assert.deepEqual(parseLimits('Max hubs: 10/5/3'), { max_hubs_normal: 10, max_hubs_registered: 5, max_hubs_op: 3 });
  assert.deepEqual(parseLimits('Maximum hubs is 8/4/2'), { max_hubs_normal: 8, max_hubs_registered: 4, max_hubs_op: 2 });
  assert.equal(parseLimits('Slot ratio: 0.5').min_slot_ratio, 0.5);
  assert.equal(parseLimits('Slots/hubs ratio min 1').min_slot_ratio, 1);
  assert.equal(parseLimits('open 2 slots per hub').min_slot_ratio, 2);
});

test('ambiguous numbers are skipped', () => {
  assert.deepEqual(parseLimits('Min slots: 1/hub'), {});           // a ratio, not a count
  assert.deepEqual(parseLimits('Slot ratio 1:2'), {});              // which way round?
  assert.deepEqual(parseLimits('Max hubs: 2.5'), {});
  assert.deepEqual(parseLimits('H:5/2/1'), {});                     // somebody's tag
  assert.deepEqual(parseLimits('Welcome! Enjoy your stay. 50 GB of new films today.'), {});
});

test('a huge message is scanned only so far and fast', () => {
  const text = 'min share '.repeat(50000) + 'min share 5 GB';
  const start = process.hrtime.bigint();
  const limits = parseLimits(text);
  assert.ok(Number(process.hrtime.bigint() - start) / 1e6 < 1000);
  assert.equal(limits.min_share, undefined); // past the scanned part
});

test('rule names without numbers (kick reasons)', () => {
  assert.deepEqual(ruleNamesIn('User is not sharing enough'), [ 'min_share' ]);
  assert.deepEqual(ruleNamesIn('User have too few upload slots.'), [ 'min_slots' ]);
  assert.deepEqual(ruleNamesIn('User is on too many hubs.'), [ 'max_hubs' ]);
  assert.deepEqual(ruleNamesIn('Your hubs/slots ratio is too low'), [ 'min_slot_ratio' ]);
  assert.deepEqual(ruleNamesIn('Max hubs: 10/5/3'), [ 'max_hubs' ]);
  assert.deepEqual(ruleNamesIn('Welcome to the hub'), []);
});

test('is a message about us?', () => {
  assert.ok(isAboutUs('You are being kicked because: min share 100 GB', 'me'));
  assert.ok(isAboutUs('Your share is too small', 'me'));
  assert.ok(isAboutUs('You need to share at least 20 GB', 'me'));
  assert.ok(isAboutUs('me was kicked: too many hubs', 'me'));
  assert.ok(isAboutUs('You share 1 GB but minimum allowed is 5 GB', 'me'));
  assert.ok(!isAboutUs('Min share: 50 GB', 'me'));
  assert.ok(!isAboutUs('bob was kicked: too many hubs', 'me'));
  assert.ok(isExplicitKickOf('me was kicked by OpBot: min share 100 GB', 'me'));
  assert.ok(isExplicitKickOf('<Hub-Security> OpBot is kicking me because: share too small', 'me'));
  assert.ok(!isExplicitKickOf('meme was kicked: spam', 'me'));
  assert.ok(!isExplicitKickOf('me was kicked', ''));
  assert.ok(isExplicitKickOf('a.b was kicked: x', 'a.b'));
  assert.ok(!isExplicitKickOf('axb was kicked: x', 'a.b')); // nick is not a pattern
});

test('hub addresses normalize to one key', () => {
  assert.equal(normalizeHubUrl('adcs://Hub.Example.org:1511/?kp=SHA256/ABC'), 'hub.example.org:1511');
  assert.equal(normalizeHubUrl('adc://hub.example.org:1511'), 'hub.example.org:1511');
  assert.equal(normalizeHubUrl('dchub://hub.example.org'), 'hub.example.org:411');
  assert.equal(normalizeHubUrl('hub.example.org'), 'hub.example.org:411');
  assert.equal(normalizeHubUrl('nmdcs://hub.example.org:4111'), 'hub.example.org:4111');
  assert.equal(normalizeHubUrl('adc://[2001:db8::1]:1511'), '[2001:db8::1]:1511');
  assert.equal(normalizeHubUrl(''), '');
  assert.equal(normalizeHubUrl(undefined), '');
});

test('tags, typed sizes and formatting', () => {
  assert.deepEqual(parseTag('<FulDC++ 1.11,M:A,H:5/2/1,S:3>'), { hubs: { normal: 5, registered: 2, op: 1 }, slots: 3 });
  assert.deepEqual(parseTag(''), {});
  assert.equal(parseSizeInput('50GB'), 50 * GIB);
  assert.equal(parseSizeInput('1.5 TB'), 1.5 * TIB);
  assert.equal(parseSizeInput('50'), null);
  assert.equal(parseSizeInput('lots'), null);
  assert.equal(formatBytes(50 * GIB), '50.0 GiB');
  assert.equal(formatBytes(1.5 * TIB), '1.50 TiB');
});

test('review: numbers that are not the limit are not learned', () => {
  // a different rule, a context number, a boast, the user's own info line, casual op chat
  assert.deepEqual(parseLimits('Max slots per IP: 3'), {});
  assert.deepEqual(parseLimits('Minimum slots for 10 hubs: 4'), {});
  assert.deepEqual(parseLimits('Our members share at least 2 TB of films'), {});
  assert.deepEqual(parseLimits('Your info: Share: 5 TB, Slots: 3, Hubs: 5/2/1'), {});
  assert.deepEqual(parseLimits('I use 2 slots per hub myself'), {});
  assert.deepEqual(parseLimits('Users: 1234, total share 1,5 PB, hubs: 12'), {});
  // still read
  assert.equal(parseLimits('Min slots per hub: 2').min_slot_ratio, 2);
  assert.equal(parseLimits('Min slots per hub: 2').min_slots, undefined);
  assert.equal(parseLimits('Please keep at least 1 slot per hub').min_slot_ratio, 1);
  assert.equal(parseLimits('Min share 50 GB / Min slots 3 / Max hubs 10').min_slots, 3);
  assert.equal(parseLimits('Min share: 1,5 TB').min_share, 1.5 * TIB);
  assert.equal(parseLimits('Min share: 2 TiB').min_share, 2 * TIB);
});
