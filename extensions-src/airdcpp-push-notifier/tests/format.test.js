'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const format = require('../src/format');

const pm = (overrides = {}) => ({
  text: 'hello there',
  from: { nick: 'alice', cid: 'CID1', hub_name: 'Test Hub', flags: [] },
  has_mention: false,
  ...overrides,
});

test('sanitize strips control and bidi characters and truncates on characters', () => {
  assert.equal(format.sanitize('a\u0000b\u202Ec\u0007', 100), 'abc');
  assert.equal(format.sanitize('line1\nline2', 100), 'line1\nline2');
  assert.equal(format.sanitize('😀'.repeat(10), 5), '😀😀😀😀…');
  assert.equal(format.sanitize(null, 10), '');
});

test('private message carries nick, text and a per-sender key', () => {
  const n = format.formatPrivateMessage(pm(), { includeText: true });
  assert.equal(n.kind, 'private_message');
  assert.equal(n.title, 'Private message from alice');
  assert.equal(n.body, 'hello there');
  assert.equal(n.key, 'pm:CID1');
});

test('private message without text never contains the text', () => {
  const n = format.formatPrivateMessage(pm({ text: 'secret' }), { includeText: false });
  assert.ok(!n.body.includes('secret'));
  assert.ok(!n.title.includes('secret'));
});

test('own and bot messages are recognised by flag', () => {
  assert.equal(format.isOwnMessage(pm({ from: { nick: 'me', flags: [ 'self' ] } })), true);
  assert.equal(format.isOwnMessage(pm()), false);
  assert.equal(format.isBotMessage(pm({ from: { nick: 'bot', flags: [ 'bot' ] } })), true);
  assert.equal(format.isBotMessage(pm({ from: undefined })), false);
});

test('bundle notifications use the name, never the target path', () => {
  const bundle = { id: 7, name: 'Some.Release-GRP', target: 'D:\\Private\\Downloads\\Some.Release-GRP\\', status: { id: 'completed' } };
  const n = format.formatBundleFinished(bundle);
  assert.equal(n.body, 'Some.Release-GRP');
  assert.ok(!JSON.stringify(n).includes('Private'));
});

test('bundle status classification', () => {
  assert.equal(format.classifyBundleStatus({ status: { id: 'completed' } }), 'finished');
  assert.equal(format.classifyBundleStatus({ status: { id: 'shared' } }), 'finished');
  assert.equal(format.classifyBundleStatus({ status: { id: 'download_error', failed: true } }), 'failed');
  assert.equal(format.classifyBundleStatus({ status: { id: 'completion_validation_error' } }), 'failed');
  assert.equal(format.classifyBundleStatus({ status: { id: 'queued' } }), null);
  assert.equal(format.classifyBundleStatus({ status: { id: 'downloaded' } }), null);
  assert.equal(format.classifyBundleStatus({}), null);
});

test('disconnected states', () => {
  assert.equal(format.isDisconnectedState({ id: 'disconnected' }), true);
  assert.equal(format.isDisconnectedState({ id: 'keyprint_mismatch' }), true);
  assert.equal(format.isDisconnectedState({ id: 'connecting' }), false);
  assert.equal(format.isDisconnectedState(undefined), false);
});
