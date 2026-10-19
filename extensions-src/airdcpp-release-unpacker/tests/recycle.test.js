'use strict';

// The Recycle Bin helper for "remove the archives". The shell's "send to the Recycle Bin"
// DELETES PERMANENTLY, without asking, where the bin cannot take the file. Review 2026-10-18
// (reproduced in airdcpp-watched-cleanup): a SUBST drive letter reports Fixed but has no volume
// of its own, and the file was deleted outright. These run the real helper on Windows.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { recycleFiles, SCRIPT } = require('../src/recycle');

const win = { skip: process.platform !== 'win32' };

test('a file on a SUBST drive letter is refused and stays', win, async () => {
  const letter = 'ZYXWVUTSRQPONMLKJIHG'.split('').find((l) => !fs.existsSync(`${l}:\\`));
  if (!letter) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unpk-subst-'));
  fs.writeFileSync(path.join(dir, 'rel.r00'), 'must survive');
  execFileSync('subst', [ `${letter}:`, dir ], { windowsHide: true });
  try {
    const [ r ] = await recycleFiles([ `${letter}:\\rel.r00` ], fs.mkdtempSync(path.join(os.tmpdir(), 'unpk-rcw-')));
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(r.why, /not a volume of its own/);
    assert.ok(fs.existsSync(path.join(dir, 'rel.r00')), 'the file was deleted');
  } finally {
    execFileSync('subst', [ `${letter}:`, '/D' ], { windowsHide: true });
  }
});

test('a file reached through a junction is refused and stays', win, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'unpk-junction-'));
  const target = path.join(base, 'target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'rel.r00'), 'must stay');
  fs.symlinkSync(target, path.join(base, 'link'), 'junction');
  try {
    const [ r ] = await recycleFiles([ path.join(base, 'link', 'rel.r00') ], fs.mkdtempSync(path.join(os.tmpdir(), 'unpk-rcw-')));
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(r.why, /link or a mounted folder/);
    assert.ok(fs.existsSync(path.join(target, 'rel.r00')));
  } finally {
    fs.rmSync(path.join(base, 'link'), { force: true, recursive: false });
  }
});

test('a plain file on a fixed local drive still goes to the Recycle Bin', win, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unpk-plain-'));
  const file = path.join(dir, 'unpacker-review-test.r00');
  fs.writeFileSync(file, 'x');
  const [ r ] = await recycleFiles([ file ], fs.mkdtempSync(path.join(os.tmpdir(), 'unpk-rcw-')));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(fs.existsSync(file), false);
});

test('the script refuses the policy that switches the bin off, a bin switched off per drive, and a file larger than the bin', () => {
  assert.match(SCRIPT, /NoRecycleFiles/);
  assert.match(SCRIPT, /NukeOnDelete/);
  assert.match(SCRIPT, /larger than the Recycle Bin/);
  assert.match(SCRIPT, /ReparsePoint/);
  assert.match(SCRIPT, /Win32_Volume/);
});
