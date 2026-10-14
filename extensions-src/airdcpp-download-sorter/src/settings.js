'use strict';

const SettingDefinitions = [
  {
    key: 'dry_run',
    title: 'Dry run: only log where downloads would go, move nothing',
    default_value: true,
    type: 'boolean',
    help: 'On by default. Check the event log for a while, then turn this off.',
  }, {
    key: 'tv_directory',
    title: 'TV episodes and seasons go to',
    default_value: '',
    type: 'directory_path',
    optional: true,
    help: 'Leave empty to not sort TV.',
  }, {
    key: 'tv_group_by_show',
    title: 'TV: put each show in its own folder, with a folder per season',
    default_value: true,
    type: 'boolean',
  }, {
    key: 'movies_directory',
    title: 'Movies go to',
    default_value: '',
    type: 'directory_path',
    optional: true,
    help: 'Leave empty to not sort movies.',
  }, {
    key: 'music_directory',
    title: 'Music goes to',
    default_value: '',
    type: 'directory_path',
    optional: true,
    help: 'Leave empty to not sort music.',
  }, {
    key: 'custom_rules',
    title: 'Own rules, checked first (one per line: pattern => folder)',
    default_value: '',
    type: 'text',
    optional: true,
    help: 'The pattern is a case-insensitive regular expression on the release name. Example: ^Formula\\.1\\. => D:\\Sport\\F1',
  }, {
    key: 'source_directory',
    title: 'Only sort downloads that finished inside',
    default_value: '',
    type: 'directory_path',
    optional: true,
    help: 'Leave empty for the default download folder of the client. Downloads you sent anywhere else are never moved.',
  }, {
    key: 'settle_seconds',
    title: 'Wait after a download finishes (seconds)',
    default_value: 60,
    type: 'number',
    min: 5,
    max: 3600,
    help: 'Gives sharing and other extensions (release checkers) time to finish with it first.',
  },
];

module.exports = { SettingDefinitions };
