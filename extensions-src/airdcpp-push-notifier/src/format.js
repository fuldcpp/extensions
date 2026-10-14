'use strict';

// Turns API event payloads into { kind, key, title, body } notifications. Pure functions only, so
// everything here is covered by the unit tests without a client.

const TITLE_MAX = 120;
const BODY_MAX = 1000;

// Control characters (other than newline and tab) and the bidi overrides that can make a
// notification read differently from what was sent
const UNSAFE_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]/g;

const sanitize = (text, max) => {
  const clean = String(text == null ? '' : text).replace(UNSAFE_CHARS, '').trim();
  const chars = Array.from(clean);
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : clean;
};

const hasFlag = (user, flag) => !!user && Array.isArray(user.flags) && user.flags.includes(flag);

const isOwnMessage = (message) => hasFlag(message.from, 'self');

const isBotMessage = (message) => hasFlag(message.from, 'bot');

const nickOf = (user) => (user && user.nick) || 'Unknown user';

const formatPrivateMessage = (message, { includeText }) => {
  const nick = nickOf(message.from);
  const hub = message.from && message.from.hub_name;
  return {
    kind: 'private_message',
    // One cooldown bucket per sender
    key: `pm:${(message.from && message.from.cid) || nick}`,
    title: sanitize(`Private message from ${nick}`, TITLE_MAX),
    body: sanitize(includeText ? message.text : (hub ? `On ${hub}` : 'New private message'), BODY_MAX),
  };
};

const formatMention = (message, hubName, { includeText }) => {
  const nick = nickOf(message.from);
  return {
    kind: 'mention',
    key: `mention:${hubName || ''}`,
    title: sanitize(`${nick} mentioned you${hubName ? ` in ${hubName}` : ''}`, TITLE_MAX),
    body: sanitize(includeText ? message.text : 'New mention', BODY_MAX),
  };
};

const formatBundleFinished = (bundle) => ({
  kind: 'bundle_finished',
  // Per outcome: a failure must not hold back the "finished" that follows a retry
  key: `bundle:${bundle.id}:finished`,
  title: 'Download finished',
  // The name only: the target path would reveal the local directory layout
  body: sanitize(bundle.name, BODY_MAX),
});

const formatBundleFailed = (bundle) => ({
  kind: 'bundle_failed',
  key: `bundle:${bundle.id}:failed`,
  title: 'Download failed',
  body: sanitize(`${bundle.name}: ${(bundle.status && bundle.status.str) || 'failed'}`, BODY_MAX),
});

const formatHubDisconnected = (hubName, stateStr) => ({
  kind: 'hub_disconnected',
  key: `hub:${hubName}`,
  title: sanitize(`Disconnected from ${hubName}`, TITLE_MAX),
  body: sanitize(stateStr || 'The hub has stayed disconnected', BODY_MAX),
});

const BUNDLE_FAILED_STATES = [ 'download_error', 'completion_validation_error' ];

// What a queue_bundle_status payload means for the notifier: 'finished', 'failed' or null
const classifyBundleStatus = (bundle) => {
  const status = bundle && bundle.status;
  if (!status) {
    return null;
  }

  if (status.id === 'completed' || status.id === 'shared') {
    return 'finished';
  }

  if (status.failed || BUNDLE_FAILED_STATES.includes(status.id)) {
    return 'failed';
  }

  return null;
};

const isDisconnectedState = (connectState) =>
  !!connectState && (connectState.id === 'disconnected' || connectState.id === 'keyprint_mismatch');

module.exports = {
  sanitize,
  isOwnMessage,
  isBotMessage,
  formatPrivateMessage,
  formatMention,
  formatBundleFinished,
  formatBundleFailed,
  formatHubDisconnected,
  classifyBundleStatus,
  isDisconnectedState,
  TITLE_MAX,
  BODY_MAX,
};
