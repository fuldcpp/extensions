'use strict';

const SettingDefinitions = [
  {
    key: 'min_free_gib',
    title: 'Pause downloads when a drive has less free space than (GiB)',
    default_value: 10,
    type: 'number',
    min: 1,
    max: 100000,
  }, {
    key: 'resume_margin_gib',
    title: 'Resume once free space is this much above the limit again (GiB)',
    default_value: 2,
    type: 'number',
    min: 0,
    max: 100000,
    help: 'Keeps downloads from flapping between paused and running around the limit.',
  }, {
    key: 'check_interval_seconds',
    title: 'Check every (seconds)',
    default_value: 60,
    type: 'number',
    min: 15,
    max: 3600,
  }, {
    key: 'log_actions',
    title: 'Write pauses and resumes to the event log',
    default_value: true,
    type: 'boolean',
  },
];

module.exports = { SettingDefinitions };
