'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStore, MAX_HUBS } = require('../src/store');

const make = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rules-store-'));
  const clock = { value: 1000 };
  const errors = [];
  const store = createStore(() => dir, { error: (m) => errors.push(m) }, () => clock.value);
  store.load();
  return { dir, clock, store, errors, file: path.join(dir, 'hub-rules.json') };
};

test('a repeated announcement writes nothing; a changed value is written', () => {
  const t = make();
  assert.ok(t.store.setLimits('h:1', 'adc://h:1', 'H', 'chat', { min_share: 5 }, 'Min share 5'));
  const first = fs.readFileSync(t.file, 'utf8');
  t.clock.value += 500;
  assert.ok(!t.store.setLimits('h:1', 'adc://h:1', 'H', 'chat', { min_share: 5 }, 'Min share 5'));
  assert.equal(fs.readFileSync(t.file, 'utf8'), first);
  assert.ok(t.store.setLimits('h:1', 'adc://h:1', 'H', 'chat', { min_share: 6 }, 'Min share 6'));
  assert.equal(JSON.parse(fs.readFileSync(t.file, 'utf8')).hubs['h:1'].limits.chat.min_share.at, 1500);
});

test('the hub list source is replaced, not merged', () => {
  const t = make();
  t.store.setLimits('h:1', '', '', 'hublist', { min_share: 5, max_hubs: 3 }, null, { replace: true });
  t.store.setLimits('h:1', '', '', 'hublist', { min_share: 5 }, null, { replace: true });
  assert.deepEqual(Object.keys(t.store.get('h:1').limits.hublist), [ 'min_share' ]);
});

test('the record cannot grow without bound: oldest hubs go first', () => {
  const t = make();
  for (let i = 0; i <= MAX_HUBS; i++) {
    t.clock.value += 1;
    t.store.setLimits(`h${i}:1`, '', '', 'chat', { max_hubs: 5 }, 'x'.repeat(5000));
  }

  const hubs = JSON.parse(fs.readFileSync(t.file, 'utf8')).hubs;
  assert.equal(Object.keys(hubs).length, MAX_HUBS);
  assert.ok(!hubs['h0:1']);
  assert.ok(hubs[`h${MAX_HUBS}:1`]);
  assert.equal(hubs['h1:1'].limits.chat.max_hubs.text.length, 200);
});

test('no temporary file is left behind', () => {
  const t = make();
  t.store.setLimits('h:1', '', '', 'chat', { max_hubs: 5 }, null);
  assert.deepEqual(fs.readdirSync(t.dir), [ 'hub-rules.json' ]);
});
