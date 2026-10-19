'use strict';

const STORAGE_NOTE = 'Stored in plain text in the extension settings file.';

const SettingDefinitions = [
  // Signing in to the client's own media server
  {
    key: 'server_user',
    title: 'Media server account: user name',
    default_value: '',
    type: 'string',
    optional: true,
    help: 'A media server account (Settings > Media server). Watched state is per account: this extension sees what THIS account has watched.',
  }, {
    key: 'server_password',
    title: 'Media server account: password',
    default_value: '',
    type: 'password',
    optional: true,
    help: STORAGE_NOTE,
  }, {
    key: 'server_token',
    title: 'Or: an access token for that account (instead of the password)',
    default_value: '',
    type: 'password',
    optional: true,
    help: `${STORAGE_NOTE} Used when no password is given.`,
  }, {
    key: 'extra_accounts',
    title: 'Other accounts whose watched state counts',
    default_value: [],
    type: 'list',
    item_type: 'struct',
    optional: true,
    definitions: [
      // Both optional: the core refuses an empty default for a required field
      { key: 'username', title: 'User name', default_value: '', type: 'string', optional: true },
      { key: 'password', title: 'Password', default_value: '', type: 'password', optional: true },
    ],
    help: `Something is only offered for cleaning once EVERY listed account has watched it. ${STORAGE_NOTE}`,
  }, {
    key: 'ignore_other_accounts',
    title: 'Clean even though the media server has accounts not listed here',
    default_value: false,
    type: 'boolean',
    help: 'Off: when the media server has an account whose watched state this extension cannot read, "/cleanup run" refuses (the list still works).',
  },

  // What counts as done with
  {
    key: 'watched_days',
    title: 'Watched more than this many days ago',
    default_value: 30,
    type: 'number',
    min: 1,
    max: 3650,
  }, {
    key: 'added_days',
    title: 'And added to the library more than this many days ago',
    default_value: 14,
    type: 'number',
    min: 0,
    max: 3650,
  }, {
    key: 'keep_last_episodes',
    title: 'Keep the last watched episodes of each series (count)',
    default_value: 1,
    type: 'number',
    min: 0,
    max: 100,
  }, {
    key: 'keep_folders',
    title: 'Keep forever: never touch anything in these folders',
    default_value: [],
    type: 'list',
    item_type: 'directory_path',
    optional: true,
  }, {
    key: 'keep_collections',
    title: 'Keep forever: never touch anything in these collections (names)',
    default_value: [],
    type: 'list',
    item_type: 'string',
    optional: true,
  }, {
    key: 'dvr_folder',
    title: 'Recordings folder (never touched; the client manages recordings itself)',
    default_value: '',
    type: 'directory_path',
    optional: true,
    help: 'The folder set under Settings > Media server for recordings. Files named like recordings ("... 1a2b3c.ts") are skipped anywhere.',
  },

  // When and how much
  {
    key: 'check_interval_hours',
    title: 'Write the report every (hours)',
    default_value: 24,
    type: 'number',
    min: 1,
    max: 720,
  }, {
    key: 'clean_automatically',
    title: 'Clean automatically after each report (moves files to the Recycle Bin)',
    default_value: false,
    type: 'boolean',
    help: 'Off by default: nothing is moved unless you type "/cleanup run".',
  }, {
    key: 'max_items_per_run',
    title: 'At most this many items per clean',
    default_value: 50,
    type: 'number',
    min: 1,
    max: 1000,
  }, {
    key: 'max_gib_per_run',
    title: 'At most this much per clean (GiB)',
    default_value: 200,
    type: 'number',
    min: 1,
    max: 100000,
  }, {
    key: 'log_summary',
    title: 'Write a summary to the event log after each report',
    default_value: true,
    type: 'boolean',
  },
];

module.exports = { SettingDefinitions };
