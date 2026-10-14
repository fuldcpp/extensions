'use strict';

// Records joins and leaves (events, never hooks) and answers "/seen <nick>" typed in a hub or a
// private chat. Answering "!seen" from other users is a separate opt-in, limited to the hub
// that asked and locked to one nick-shaped word.

const crypto = require('crypto');

const SettingsManager = require('airdcpp-extension-settings');

const { SettingDefinitions } = require('./settings');
const { answer, publicQueryOf, publicAnswer } = require('./store');
const { createPersistence } = require('./persist');

const CONFIG_VERSION = 1;
const APPEND_MS = 5 * 1000;          // changes reach the log within seconds
const ALIVE_MS = 60 * 1000;          // "this run was alive at" heartbeat
const COMPACT_MS = 60 * 60 * 1000;   // snapshot rewrite at most hourly...
const COMPACT_LOG_BYTES = 1024 * 1024; // ...and only once the log has grown
const HELP = '/seen <nick>: when a user was last online (airdcpp-seen-tracker)';

module.exports = function (socket, extension, { now = () => Math.floor(Date.now() / 1000) } = {}) {
  const settings = SettingsManager(socket, {
    extensionName: extension.name,
    configFile: extension.configPath + 'config.json',
    configVersion: CONFIG_VERSION,
    definitions: SettingDefinitions,
  });

  const run = crypto.randomBytes(8).toString('hex');
  const persistence = createPersistence(extension.configPath, socket.logger);
  let store = null;
  const online = new Map(); // hub session id -> Set(cid) seen joining in this run
  const timers = [];
  const lastPublicAnswer = new Map(); // hub session id -> seconds

  const errorText = (error) => (error && (error.message || error.code)) || String(error);

  const guarded = (name, handler) => async (...args) => {
    try {
      await handler(...args);
    } catch (error) {
      socket.logger.error(`${name} failed: ${errorText(error)}`);
    }
  };

  const onlineSet = (sessionId) => {
    if (!online.has(sessionId)) online.set(sessionId, new Set());
    return online.get(sessionId);
  };

  const onJoin = (user, sessionId) => {
    store.record(user, 'joined', now(), run);
    if (user && user.cid) onlineSet(sessionId).add(user.cid);
  };

  const onLeave = (user, sessionId) => {
    store.record(user, 'left', now(), run);
    if (user && user.cid) onlineSet(sessionId).delete(user.cid);
  };

  // We stopped seeing a hub (our disconnect or the hub closed): no per-user leaves arrive for
  // that, so everyone still there was present until now
  const onHubGone = (sessionId) => {
    const set = online.get(sessionId);
    if (set && set.size > 0) {
      store.markPresent(set, now());
    }

    online.delete(sessionId);
  };

  const onHubUpdated = (data, sessionId) => {
    if (data && data.connect_state && data.connect_state.id !== 'connected' && data.connect_state.id !== 'connecting') {
      onHubGone(sessionId);
    }
  };

  const searchOnline = async (nick, hubUrls) => {
    if (!nick) return [];
    try {
      return await socket.post('users/search_nicks', { pattern: nick, max_results: 20, ignore_prefixes: false, ...(hubUrls ? { hub_urls: hubUrls } : {}) });
    } catch (error) {
      return [];
    }
  };

  const reply = async (base, sessionId, text, owner) => {
    for (const line of text.split('\n')) {
      await socket.post(`${base}/${sessionId}/status_message`, { text: line, severity: 'info', ...(owner ? { owner } : {}) });
    }
  };

  const onTextCommand = (base) => async (data, sessionId) => {
    if (!data || !data.command) {
      return;
    }

    const command = String(data.command).toLowerCase();
    if (command === 'help') {
      await reply(base, sessionId, HELP, data.owner);
      return;
    }

    if (command !== 'seen') {
      return;
    }

    const nick = (data.args || []).join(' ').trim();
    await reply(base, sessionId, answer(nick, store, await searchOnline(nick), now()), data.owner);
  };

  // "!seen <nick>" from someone else in main chat, when allowed, at most once per hub per cooldown
  const onHubMessage = async (message, sessionId) => {
    if (!settings.getValue('answer_public') || !message || !message.from) {
      return;
    }

    const flags = message.from.flags || [];
    const nick = publicQueryOf(message.text);
    if (!nick || flags.includes('self') || flags.includes('bot')) {
      return;
    }

    const last = lastPublicAnswer.get(sessionId) || 0;
    if (now() - last < settings.getValue('public_cooldown_seconds')) {
      return;
    }

    lastPublicAnswer.set(sessionId, now());
    const hubUrl = message.from.hub_url || null;
    const onlineHere = hubUrl ? await searchOnline(nick, [ hubUrl ]) : [];
    await socket.post(`hubs/${sessionId}/chat_message`, { text: publicAnswer(nick, store, onlineHere, hubUrl, now()) });
  };

  const append = () => persistence.appendChanges(store);
  const maybeCompact = () => {
    if (persistence.logSize() > COMPACT_LOG_BYTES) {
      store.prune(now(), settings.getValue('retention_days'));
      persistence.compact(store);
    }
  };

  extension.onStart = async () => {
    await settings.load();
    const loaded = persistence.load();
    store = loaded.store;

    // Users the previous run saw join and never saw leave were there until it was last alive
    const alive = persistence.readAlive();
    if (alive) {
      store.markPresentAtShutdown(alive.run, alive.at);
    }

    store.prune(now(), settings.getValue('retention_days'));
    persistence.compact(store);
    persistence.writeAlive(run, now());

    await socket.addListener('hubs', 'hub_user_connected', guarded('hub_user_connected', onJoin));
    await socket.addListener('hubs', 'hub_user_disconnected', guarded('hub_user_disconnected', onLeave));
    await socket.addListener('hubs', 'hub_updated', guarded('hub_updated', onHubUpdated));
    await socket.addListener('hubs', 'hub_removed', guarded('hub_removed', (_data, sessionId) => onHubGone(sessionId)));
    await socket.addListener('hubs', 'hub_text_command', guarded('hub_text_command', onTextCommand('hubs')));
    await socket.addListener('private_chat', 'private_chat_text_command', guarded('private_chat_text_command', onTextCommand('private_chat')));
    await socket.addListener('hubs', 'hub_message', guarded('hub_message', onHubMessage));

    // unref: the API socket keeps the process alive; these timers alone must not
    const every = (fn, ms) => {
      const timer = setInterval(fn, ms);
      if (timer && typeof timer.unref === 'function') timer.unref();
      timers.push(timer);
    };

    every(append, APPEND_MS);
    every(() => persistence.writeAlive(run, now()), ALIVE_MS);
    every(maybeCompact, COMPACT_MS);
  };

  // Runs on Linux (SIGTERM) and on a clean exit; not on Windows, where the log and alive.json
  // already hold everything but the last few seconds
  extension.onStop = () => {
    timers.forEach(clearInterval);
    if (store) {
      for (const sessionId of Array.from(online.keys())) {
        onHubGone(sessionId);
      }

      append();
      persistence.writeAlive(run, now());
    }
  };

  // For the tests
  return { getStore: () => store, onTextCommand, onHubMessage, append, maybeCompact, run };
};
