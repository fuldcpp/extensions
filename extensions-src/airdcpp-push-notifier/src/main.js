'use strict';

// Every client event is consumed through a plain listener, never a hook: a hook would make the
// core wait for this extension (and a failure would reject the item), a listener cannot.

const SettingsManager = require('airdcpp-extension-settings');

const { SettingDefinitions } = require('./settings');
const format = require('./format');
const { createPolicy } = require('./policy');
const { createDispatcher } = require('./senders');

const CONFIG_VERSION = 1;

module.exports = function (socket, extension) {
  const settings = SettingsManager(socket, {
    extensionName: extension.name,
    configFile: extension.configPath + 'config.json',
    configVersion: CONFIG_VERSION,
    definitions: SettingDefinitions,
  });

  const policy = createPolicy();
  const values = () => SettingDefinitions.reduce((reduced, def) => {
    reduced[def.key] = settings.getValue(def.key);
    return reduced;
  }, {});

  const postEvent = (text, severity) => {
    socket.post('events', { text: `${extension.name}: ${text}`, severity })
      .catch((error) => socket.logger.error(`Failed to post an event message: ${error.message || error}`));
  };

  const dispatcher = createDispatcher({
    fetchImpl: (...args) => fetch(...args),
    onFailure: (sender, reason) => {
      // The reason never carries the URL: a Telegram token is part of it
      socket.logger.error(`${sender.name}: sending failed (${reason}); further failures are not reported until it works again`);
      postEvent(`sending to ${sender.name} failed (${reason})`, 'error');
    },
    onRecovered: (sender) => socket.logger.info(`${sender.name}: sending works again`),
  });

  let away = false;
  const notifiedBundles = new Map(); // bundle id -> 'finished' | 'failed'
  const hubTimers = new Map(); // hub session id -> timeout

  const notify = (notification) => {
    const current = values();
    const verdict = policy.check(notification, {
      cooldownSeconds: current.cooldown_seconds,
      maxPerMinute: current.max_per_minute,
      quietStart: current.quiet_start,
      quietEnd: current.quiet_end,
    });

    if (!verdict.send) {
      socket.logger.verbose(`Not sending ${notification.kind} (${verdict.reason})`);
      return;
    }

    const suppressed = policy.takeSuppressed();
    // Capped again after the suffix: Pushover refuses a message over 1024 characters
    const outgoing = suppressed > 0 ?
      { ...notification, body: format.sanitize(`${notification.body}\n(${suppressed} earlier notification(s) dropped by the rate limit)`, format.BODY_MAX) } :
      notification;

    dispatcher.dispatch(current, outgoing)
      .then(({ attempted }) => {
        if (attempted === 0) {
          socket.logger.verbose('No notification service is configured');
        }
      })
      .catch((error) => socket.logger.error(`Dispatch failed: ${error.message || error}`));
  };

  // A throw inside a socket listener would take the whole extension process down
  const guarded = (name, handler) => (...args) => {
    try {
      handler(...args);
    } catch (error) {
      socket.logger.error(`${name} handler failed: ${error.message || error}`);
    }
  };

  const chatAllowed = () => !settings.getValue('chat_only_when_away') || away;

  const onPrivateMessage = (message) => {
    if (!settings.getValue('notify_private_messages') || format.isOwnMessage(message) || !chatAllowed()) {
      return;
    }

    if (settings.getValue('ignore_bots') && format.isBotMessage(message)) {
      return;
    }

    notify(format.formatPrivateMessage(message, { includeText: settings.getValue('include_message_text') }));
  };

  const onHubMessage = (message) => {
    if (!settings.getValue('notify_mentions') || !message.has_mention || format.isOwnMessage(message) || !chatAllowed()) {
      return;
    }

    if (settings.getValue('ignore_bots') && format.isBotMessage(message)) {
      return;
    }

    const hubName = message.from && message.from.hub_name;
    notify(format.formatMention(message, hubName, { includeText: settings.getValue('include_message_text') }));
  };

  const onBundleStatus = (bundle) => {
    const outcome = format.classifyBundleStatus(bundle);
    if (!outcome) {
      // Back in the queue after finishing (a recheck): finishing again is news. A failed bundle
      // keeps its mark: the client requeues it every minute, and a persistent error would
      // otherwise notify on every cycle.
      if (notifiedBundles.get(bundle.id) === 'finished') {
        notifiedBundles.delete(bundle.id);
      }

      return;
    }

    // "completed" is followed by "shared": one notification per outcome and bundle
    if (notifiedBundles.get(bundle.id) === outcome) {
      return;
    }

    notifiedBundles.set(bundle.id, outcome);
    if (notifiedBundles.size > 5000) {
      notifiedBundles.delete(notifiedBundles.keys().next().value);
    }

    if (outcome === 'finished' && settings.getValue('notify_bundle_finished')) {
      notify(format.formatBundleFinished(bundle));
    } else if (outcome === 'failed' && settings.getValue('notify_bundle_failed')) {
      notify(format.formatBundleFailed(bundle));
    }
  };

  const clearHubTimer = (sessionId) => {
    clearTimeout(hubTimers.get(sessionId));
    hubTimers.delete(sessionId);
  };

  // A disconnect is reported only if the hub is still down after the grace period: the client
  // reconnects on its own and a short drop is not worth a phone buzz
  const onHubUpdated = (data, sessionId) => {
    if (!data || !data.connect_state) {
      return;
    }

    // Only a real reconnect cancels: every retry passes through "connecting" and back to
    // "disconnected", and cancelling on that would restart the grace period forever
    if (data.connect_state.id === 'connected') {
      clearHubTimer(sessionId);
      return;
    }

    if (!format.isDisconnectedState(data.connect_state) || !settings.getValue('notify_hub_disconnected') || hubTimers.has(sessionId)) {
      return;
    }

    hubTimers.set(sessionId, setTimeout(async () => {
      hubTimers.delete(sessionId);
      if (!settings.getValue('notify_hub_disconnected')) {
        return;
      }

      try {
        const hub = await socket.get(`hubs/${sessionId}`);
        if (hub.connect_state && hub.connect_state.id !== 'connected') {
          const name = (hub.identity && hub.identity.name) || hub.hub_url || 'a hub';
          notify(format.formatHubDisconnected(name, hub.connect_state.str));
        }
      } catch (error) {
        // The hub was closed meanwhile
        socket.logger.verbose(`Hub ${sessionId} is gone: ${error.message || error}`);
      }
    }, settings.getValue('hub_disconnect_grace') * 1000));
  };

  const sendTest = async () => {
    const result = await dispatcher.dispatch(values(), {
      kind: 'test',
      key: null,
      title: 'Test notification',
      body: 'airdcpp-push-notifier is set up and can reach this service.',
    });

    if (result.attempted === 0) {
      postEvent('no notification service is configured yet', 'warning');
    } else {
      postEvent(`test sent: ${result.delivered} of ${result.attempted} service(s) accepted it`,
        result.delivered === result.attempted ? 'info' : 'warning');
    }
  };

  extension.onStart = async () => {
    settings.onValuesUpdated = (updated) => {
      if (updated.send_test === true) {
        sendTest()
          .catch((error) => socket.logger.error(`Test failed: ${error.message || error}`))
          .then(() => settings.setValue('send_test', false))
          .catch((error) => socket.logger.error(`Failed to reset send_test: ${error.message || error}`));
      }
    };

    await settings.load();

    try {
      const state = await socket.get('system/away');
      away = state.id !== 'off';
    } catch (error) {
      socket.logger.error(`Could not read the away state: ${error.message || error}`);
    }

    await socket.addListener('system', 'away_state', guarded('away_state', (state) => {
      away = state.id !== 'off';
    }));
    await socket.addListener('private_chat', 'private_chat_message', guarded('private_chat_message', onPrivateMessage));
    await socket.addListener('hubs', 'hub_message', guarded('hub_message', onHubMessage));
    await socket.addListener('hubs', 'hub_updated', guarded('hub_updated', onHubUpdated));
    await socket.addListener('hubs', 'hub_removed', guarded('hub_removed', (_data, sessionId) => clearHubTimer(sessionId)));
    await socket.addListener('queue', 'queue_bundle_status', guarded('queue_bundle_status', onBundleStatus));
    await socket.addListener('queue', 'queue_bundle_removed', guarded('queue_bundle_removed', (bundle) => notifiedBundles.delete(bundle.id)));
  };

  extension.onStop = () => {
    for (const timer of hubTimers.values()) {
      clearTimeout(timer);
    }

    hubTimers.clear();
  };
};
