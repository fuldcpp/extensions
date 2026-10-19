'use strict';

// The client validates the definitions when the extension registers them
// (airdcpp-webapi/api/common/SettingUtils.cpp on origin/master): an option's "id" is read with
// JsonUtil::getField(..., allowEmpty = false), and a default must be one of the options. One bad
// definition makes the whole registration fail, and the extension then runs with no settings at all
// (found live on 1.1123, 2026-10-19: "Failed to register settings: Field can't be empty").

const test = require('node:test');
const assert = require('node:assert/strict');

const { SettingDefinitions } = require('../src/settings');
const { profileOf } = require('../src/quality');

test('every option id is a non-empty string and every default is one of its options (the client refuses otherwise)', () => {
  for (const def of SettingDefinitions) {
    if (!def.options) continue;
    for (const opt of def.options) {
      assert.equal(typeof opt.id, 'string', `${def.key}: option id must be a string`);
      assert.ok(opt.id.length > 0, `${def.key}: an option id is empty ("${opt.name}")`);
    }

    assert.ok(def.options.some((o) => o.id === def.default_value), `${def.key}: the default ${JSON.stringify(def.default_value)} is not one of the options`);
  }
});

test('"no preference" for the codec means no codec preference', () => {
  const def = SettingDefinitions.find((d) => d.key === 'preferred_codec');
  assert.equal(profileOf({ preferred_codec: def.default_value }).preferredCodec, '');
  assert.equal(profileOf({ preferred_codec: 'hevc' }).preferredCodec, 'hevc');
});
