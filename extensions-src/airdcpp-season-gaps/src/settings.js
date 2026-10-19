'use strict';

const STORAGE_NOTE = 'Stored in plain text in the extension settings file.';

const SettingDefinitions = [
  // The media server
  {
    key: 'media_server_user',
    title: 'Media server: user name the extension signs in with',
    default_value: '',
    type: 'string',
    optional: true,
    help: 'Best: a separate media server account just for this extension (it only reads the library). Its "Display missing episodes" preference decides whether the media server\'s own missing-episode lists are used.',
  }, {
    key: 'media_server_password',
    title: 'Media server: password',
    default_value: '',
    type: 'password',
    optional: true,
    help: STORAGE_NOTE,
  }, {
    key: 'media_server_token',
    title: 'Media server: access token (instead of a user name and password)',
    default_value: '',
    type: 'password',
    optional: true,
    help: STORAGE_NOTE,
  }, {
    key: 'media_server_url',
    title: 'Media server address (leave empty to find it automatically)',
    default_value: '',
    type: 'string',
    optional: true,
    help: 'For example http://127.0.0.1:8096. Empty: the address and port of the media server built into this client.',
  }, {
    key: 'set_display_missing',
    title: 'Turn on "Display missing episodes" for the extension\'s own media server account',
    default_value: false,
    type: 'boolean',
    help: 'Only for an account used by this extension alone: with it on, that account\'s TV and phone apps also show missing episodes on season pages.',
  },

  // TMDB
  {
    key: 'tmdb_key',
    title: 'TMDB API key (v3 key or v4 read access token)',
    default_value: '',
    type: 'password',
    optional: true,
    help: `Needed for whole missing seasons, and for everything when "Display missing episodes" is off. The media server's own key cannot be read by extensions. ${STORAGE_NOTE}`,
  }, {
    key: 'tmdb_language',
    title: 'TMDB language for episode titles',
    default_value: 'en-US',
    type: 'string',
    optional: true,
  }, {
    key: 'identify_by_name',
    title: 'Look up series the media server has not identified, by their exact name',
    default_value: true,
    type: 'boolean',
    help: 'Used only when exactly one TMDB show has that very name (and a matching year when the library knows one).',
  },

  // What counts as a gap
  {
    key: 'check_interval_hours',
    title: 'Check the library every (hours)',
    default_value: 24,
    type: 'number',
    min: 1,
    max: 720,
  }, {
    key: 'grace_days',
    title: 'Count an episode as aired this many days after its air date',
    default_value: 1,
    type: 'number',
    min: 0,
    max: 60,
  }, {
    key: 'report_seasons_between',
    title: 'Report whole seasons missing between seasons you have',
    default_value: true,
    type: 'boolean',
  }, {
    key: 'report_seasons_after',
    title: 'Report whole seasons newer than the last season you have',
    default_value: true,
    type: 'boolean',
    help: 'A new season of a show you keep. Put a show you stopped following on the ignore list.',
  }, {
    key: 'report_seasons_before',
    title: 'Report whole seasons older than the first season you have',
    default_value: false,
    type: 'boolean',
  }, {
    key: 'include_specials',
    title: 'Include specials (season 0)',
    default_value: false,
    type: 'boolean',
  }, {
    key: 'ignored_shows',
    title: 'Shows to ignore (one per line)',
    default_value: '',
    type: 'text',
    optional: true,
  },

  // Filling gaps from the hubs
  {
    key: 'quality',
    title: 'Fill: required quality word in the release name',
    default_value: '1080p',
    type: 'string',
    optional: true,
    help: 'For example 1080p, 720p or 2160p. Leave empty to accept any quality.',
  }, {
    key: 'preferred_groups',
    title: 'Fill: preferred release groups (comma separated, best first)',
    default_value: '',
    type: 'string',
    optional: true,
  }, {
    key: 'require_preferred_group',
    title: 'Fill: only download from the preferred groups',
    default_value: false,
    type: 'boolean',
  }, {
    key: 'accepted_tags',
    title: 'Fill: accepted language tags (comma separated, e.g. multi, nordic)',
    default_value: '',
    type: 'string',
    optional: true,
    help: 'A release named with another language, a dub, burnt-in subtitles (HC) or extras (FRENCH, GERMAN.DL, NORDiC, SWESUB, DUBBED, MULTi, HC, EXTRAS, Bonus, SUBPACK...) is never downloaded unless its tag is listed here. Empty: none of them.',
  }, {
    key: 'auto_fill',
    title: 'Fill automatically after every check',
    default_value: false,
    type: 'boolean',
    help: 'Off by default. When on, every missing aired episode is searched for (within the search budget below).',
  }, {
    key: 'auto_fill_max',
    title: 'Automatic fill: at most this many episodes per check',
    default_value: 20,
    type: 'number',
    min: 1,
    max: 500,
    help: 'Keeps one check from queueing a whole back catalogue at once. The rest follow after the next checks.',
  }, {
    key: 'searches_per_hour',
    title: 'Fill: at most this many hub searches per hour',
    default_value: 20,
    type: 'number',
    min: 1,
    max: 60,
  }, {
    key: 'search_spacing_seconds',
    title: 'Fill: seconds between two searches',
    default_value: 20,
    type: 'number',
    min: 15,
    max: 3600,
  }, {
    key: 'retry_days',
    title: 'Automatic fill: search again for an episode not found after (days)',
    default_value: 3,
    type: 'number',
    min: 1,
    max: 365,
  }, {
    key: 'log_events',
    title: 'Write a summary of each check and each queued episode to the event log',
    default_value: true,
    type: 'boolean',
  },
];

module.exports = { SettingDefinitions };
