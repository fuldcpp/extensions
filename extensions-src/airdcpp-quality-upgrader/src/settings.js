'use strict';

const STORAGE_NOTE = 'Stored in plain text in the extension settings file.';

const SettingDefinitions = [
  // What counts as better
  {
    key: 'max_resolution',
    title: 'Highest resolution to take',
    default_value: '1080p',
    type: 'string',
    options: [ { id: '720p', name: '720p' }, { id: '1080p', name: '1080p' }, { id: '2160p', name: '2160p (4K)' } ],
  }, {
    key: 'upgrade_resolution',
    title: 'A higher resolution of the same film or episode is an upgrade',
    default_value: true,
    type: 'boolean',
  }, {
    key: 'take_proper',
    title: 'A PROPER or REPACK of the same release (same group) is an upgrade',
    default_value: true,
    type: 'boolean',
  }, {
    key: 'allowed_sources',
    title: 'Allowed sources (comma separated)',
    default_value: 'WEB-DL, WEBRip, BluRay, HDTV',
    type: 'string',
    help: 'Known: WEB-DL (also WEB), WEBRip, BluRay, HDTV, DVD. Leave empty to allow any.',
    optional: true,
  }, {
    key: 'preferred_codec',
    title: 'Preferred video codec',
    default_value: 'none',
    type: 'string',
    // The client refuses an empty option id (SettingUtils.cpp, getField allowEmpty=false), which
    // made the whole settings registration fail on a real client: "none" means no preference
    options: [ { id: 'none', name: 'No preference' }, { id: 'h264', name: 'H.264 / x264' }, { id: 'hevc', name: 'HEVC / x265' }, { id: 'av1', name: 'AV1' } ],
    help: 'Picks between equally good finds.',
  }, {
    key: 'codec_upgrade',
    title: 'The preferred codec alone (same resolution) is an upgrade',
    default_value: false,
    type: 'boolean',
  }, {
    key: 'blocked_groups',
    title: 'Never take releases from these groups (comma separated)',
    default_value: '',
    type: 'string',
    optional: true,
  },

  // Searching
  {
    key: 'searches_per_hour',
    title: 'Hub searches per hour (all hubs together)',
    default_value: 10,
    type: 'number',
    min: 1,
    max: 60,
  }, {
    key: 'search_spacing_seconds',
    title: 'Seconds between two searches',
    default_value: 20,
    type: 'number',
    min: 15,
    max: 3600,
    help: 'Hubs ban users who search too often; do not go below 15.',
  }, {
    key: 'recheck_days',
    title: 'Search again for the same film or episode after (days)',
    default_value: 7,
    type: 'number',
    min: 1,
    max: 365,
  }, {
    key: 'watch_other_searches',
    title: 'Also look at the results of your own other searches',
    default_value: true,
    type: 'boolean',
    help: 'Results of searches made in the client (by you or other extensions) are checked too; nothing is sent to a hub for this.',
  },

  // Acting
  {
    key: 'auto_queue',
    title: 'Replace automatically (off = only report)',
    default_value: false,
    type: 'boolean',
    help: 'When on, an upgrade is downloaded to the staging folder; once complete it is put where the old copy was and the old copy is moved to the holding folder (never deleted).',
  }, {
    key: 'staging_directory',
    title: 'Staging folder for upgrade downloads',
    default_value: '',
    type: 'directory_path',
    optional: true,
  }, {
    key: 'holding_directory',
    title: 'Holding folder for replaced copies',
    default_value: '',
    type: 'directory_path',
    optional: true,
    help: 'The old copy goes to <holding folder>\\<release name>. Best outside your share.',
  }, {
    key: 'holding_purge_days',
    title: 'Delete replaced copies from the holding folder after (days, 0 = never)',
    default_value: 0,
    type: 'number',
    min: 0,
    max: 3650,
    help: 'Off by default. Only copies this extension put there are ever deleted.',
  }, {
    key: 'max_active_upgrades',
    title: 'Upgrades downloading at the same time (at most)',
    default_value: 3,
    type: 'number',
    min: 1,
    max: 50,
  },

  // Media server
  {
    key: 'media_username',
    title: 'Media server: user name (optional)',
    default_value: '',
    type: 'string',
    optional: true,
    help: 'With a login, the films and episodes of the media library are checked (with their real picture size), and the watched state of this user follows an upgrade. Without one, release folders in the share are checked.',
  }, {
    key: 'media_password',
    title: 'Media server: password',
    default_value: '',
    type: 'password',
    optional: true,
    help: STORAGE_NOTE,
  }, {
    key: 'media_token',
    title: 'Media server: access token (instead of a password)',
    default_value: '',
    type: 'password',
    optional: true,
    help: STORAGE_NOTE,
  },
];

module.exports = { SettingDefinitions };
