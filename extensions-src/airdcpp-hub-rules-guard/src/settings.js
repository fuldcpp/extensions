'use strict';

const SettingDefinitions = [
  {
    key: 'check_interval_minutes',
    title: 'Check connected hubs every (minutes)',
    default_value: 15,
    type: 'number',
    min: 5,
    max: 1440,
    help: 'Hubs are also checked when you connect, after a share refresh or share change, and when your upload slots change.',
  }, {
    key: 'warn_interval_minutes',
    title: 'Repeat a warning for the same hub and rule at most every (minutes)',
    default_value: 60,
    type: 'number',
    min: 60,
    max: 10080,
  }, {
    key: 'share_margin_percent',
    title: 'Also warn when your share is less than this far above a minimum (%)',
    default_value: 5,
    type: 'number',
    min: 0,
    max: 50,
    help: '0 turns the "close to the minimum" warning off.',
  }, {
    key: 'learn_from_chat',
    title: 'Learn rules from hub messages (welcome text, hub bots, operators, kick messages)',
    default_value: true,
    type: 'boolean',
    help: 'Only messages from the hub itself, bots and operators are read; ordinary users cannot set a rule.',
  }, {
    key: 'use_hublist',
    title: 'Use the limits in the public hub list when the client has it loaded',
    default_value: true,
    type: 'boolean',
    help: 'The list is never downloaded by this extension; open Public Hubs once to load it.',
  }, {
    key: 'warn_in_hub',
    title: 'Show warnings in the hub window (only you see them)',
    default_value: true,
    type: 'boolean',
  }, {
    key: 'warn_in_events',
    title: 'Write warnings to the event log',
    default_value: true,
    type: 'boolean',
  },
];

module.exports = { SettingDefinitions };
