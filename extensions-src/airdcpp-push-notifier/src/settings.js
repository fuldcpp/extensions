'use strict';

const STORAGE_NOTE = 'Stored in plain text in the extension settings file.';

const SettingDefinitions = [
  // What to send
  {
    key: 'notify_private_messages',
    title: 'Notify about private messages',
    default_value: true,
    type: 'boolean',
  }, {
    key: 'notify_mentions',
    title: 'Notify when someone mentions you in a hub',
    default_value: true,
    type: 'boolean',
  }, {
    key: 'chat_only_when_away',
    title: 'Private messages and mentions: only while away',
    default_value: true,
    type: 'boolean',
    help: 'Uses the away state of the client (set by hand or by the idle timer).',
  }, {
    key: 'ignore_bots',
    title: 'Ignore messages from bots',
    default_value: true,
    type: 'boolean',
  }, {
    key: 'include_message_text',
    title: 'Include the message text',
    default_value: true,
    type: 'boolean',
    help: 'When off, a notification only says who wrote; the text itself never leaves this computer.',
  }, {
    key: 'notify_bundle_finished',
    title: 'Notify when a download finishes',
    default_value: true,
    type: 'boolean',
  }, {
    key: 'notify_bundle_failed',
    title: 'Notify when a download fails',
    default_value: true,
    type: 'boolean',
  }, {
    key: 'notify_hub_disconnected',
    title: 'Notify when a hub stays disconnected',
    default_value: false,
    type: 'boolean',
  }, {
    key: 'hub_disconnect_grace',
    title: 'Hub disconnect: seconds to wait for a reconnect',
    default_value: 120,
    type: 'number',
    min: 10,
    max: 3600,
  },

  // Limits
  {
    key: 'cooldown_seconds',
    title: 'Seconds between notifications from the same source',
    default_value: 60,
    type: 'number',
    min: 0,
    max: 3600,
    help: 'A burst of private messages from one user gives one notification.',
  }, {
    key: 'max_per_minute',
    title: 'Maximum notifications per minute',
    default_value: 10,
    type: 'number',
    min: 1,
    max: 120,
  }, {
    key: 'quiet_start',
    title: 'Quiet hours start (HH:MM)',
    default_value: '',
    type: 'string',
    optional: true,
    help: 'Nothing is sent between the start and the end. Leave either empty to disable.',
  }, {
    key: 'quiet_end',
    title: 'Quiet hours end (HH:MM)',
    default_value: '',
    type: 'string',
    optional: true,
  },

  // Services
  {
    key: 'ntfy_server',
    title: 'ntfy: server',
    default_value: '',
    type: 'string',
    optional: true,
    help: 'The server only, without the topic: for example https://ntfy.sh or your own server.',
  }, {
    key: 'ntfy_topic',
    title: 'ntfy: topic',
    default_value: '',
    type: 'string',
    optional: true,
    help: 'Anyone who knows a topic on a public server can read it: pick a long random name.',
  }, {
    key: 'ntfy_token',
    title: 'ntfy: access token (optional)',
    default_value: '',
    type: 'password',
    optional: true,
    help: STORAGE_NOTE,
  }, {
    key: 'gotify_url',
    title: 'Gotify: server',
    default_value: '',
    type: 'string',
    optional: true,
  }, {
    key: 'gotify_token',
    title: 'Gotify: application token',
    default_value: '',
    type: 'password',
    optional: true,
    help: STORAGE_NOTE,
  }, {
    key: 'telegram_bot_token',
    title: 'Telegram: bot token',
    default_value: '',
    type: 'password',
    optional: true,
    help: STORAGE_NOTE,
  }, {
    key: 'telegram_chat_id',
    title: 'Telegram: chat id',
    default_value: '',
    type: 'string',
    optional: true,
  }, {
    key: 'discord_webhook',
    title: 'Discord: webhook URL',
    default_value: '',
    type: 'password',
    optional: true,
    help: `The URL is the credential. ${STORAGE_NOTE}`,
  }, {
    key: 'pushover_app_token',
    title: 'Pushover: application token',
    default_value: '',
    type: 'password',
    optional: true,
    help: STORAGE_NOTE,
  }, {
    key: 'pushover_user_key',
    title: 'Pushover: user key',
    default_value: '',
    type: 'password',
    optional: true,
    help: STORAGE_NOTE,
  }, {
    key: 'webhook_url',
    title: 'Generic webhook URL',
    default_value: '',
    type: 'password',
    optional: true,
    help: `Receives a JSON POST: { event, title, message, time }. Webhook URLs often carry a secret. ${STORAGE_NOTE}`,
  }, {
    key: 'send_test',
    title: 'Send a test notification now',
    default_value: false,
    type: 'boolean',
    help: 'Tick and save: a test goes to every configured service, then this switches itself off.',
  },
];

module.exports = { SettingDefinitions };
