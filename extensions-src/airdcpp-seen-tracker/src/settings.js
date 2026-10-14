'use strict';

const SettingDefinitions = [
  {
    key: 'retention_days',
    title: 'Forget users not seen for (days)',
    default_value: 365,
    type: 'number',
    min: 1,
    max: 3650,
  }, {
    key: 'answer_public',
    title: 'Answer "!seen <nick>" from other users in main chat',
    default_value: false,
    type: 'boolean',
    help: 'Off by default: it tells anyone in the hub when a user was last online. Many hubs also forbid bots answering in main chat.',
  }, {
    key: 'public_cooldown_seconds',
    title: 'Main chat answers: at most one per hub every (seconds)',
    default_value: 30,
    type: 'number',
    min: 5,
    max: 3600,
  },
];

module.exports = { SettingDefinitions };
