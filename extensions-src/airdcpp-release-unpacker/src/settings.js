'use strict';

const SettingDefinitions = [
  {
    key: 'auto_unpack',
    title: 'Unpack finished downloads automatically',
    default_value: true,
    type: 'boolean',
    help: 'Off: only the "Unpack release" menu item and the /unpack command unpack anything.',
  }, {
    key: 'target_directory',
    title: 'Unpack into this folder instead of the release folder',
    default_value: '',
    type: 'directory_path',
    optional: true,
    help: 'Leave empty to unpack next to the archives. Set: files go to <this folder>\\<release name>\\.',
  }, {
    key: 'free_space_margin_gib',
    title: 'Keep at least this much free space after unpacking (GiB)',
    default_value: 2,
    type: 'number',
    min: 0,
    max: 100000,
  }, {
    key: 'unpack_stored',
    title: 'Also unpack sets the media server already plays as they are (stored, uncompressed RAR)',
    default_value: false,
    type: 'boolean',
    help: 'Off by default: that only doubles the disk space the film takes.',
  }, {
    key: 'media_only',
    title: 'Only unpack sets that hold video, audio or subtitles',
    default_value: true,
    type: 'boolean',
  }, {
    key: 'include_samples',
    title: 'Also unpack archives in Sample folders',
    default_value: false,
    type: 'boolean',
  }, {
    key: 'nested_archives',
    title: 'Unpack archives found inside archives (one level, e.g. old releases of zips holding RAR volumes)',
    default_value: true,
    type: 'boolean',
  }, {
    key: 'exclude_patterns',
    title: 'Never unpack folders matching (one pattern per line, * and ? allowed)',
    default_value: '',
    type: 'text',
    optional: true,
    help: 'Matched against the folder name and its full path. Example: *\\Games\\* or *.XXX.*',
  }, {
    key: 'delete_archives',
    title: 'Move the archive volumes to the Recycle Bin after a complete, verified unpack',
    default_value: false,
    type: 'boolean',
    help: 'Off by default. Only the volumes of a set whose every file was unpacked and verified; never anything else. Only on fixed local drives (where Windows has a Recycle Bin).',
  }, {
    key: 'settle_seconds',
    title: 'Wait after a download finishes (seconds)',
    default_value: 30,
    type: 'number',
    min: 5,
    max: 3600,
    help: 'Gives sharing and release checkers time to finish with it first.',
  },
];

module.exports = { SettingDefinitions };
