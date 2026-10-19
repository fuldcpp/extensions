'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseRelease } = require('../src/release');
const { profileOf, judge, bestUpgrade } = require('../src/quality');

const defaults = profileOf({ max_resolution: '1080p', allowed_sources: 'WEB-DL, WEBRip, BluRay, HDTV', preferred_codec: '', take_proper: true, upgrade_resolution: true, blocked_groups: '' });
const p = parseRelease;
const j = (cur, cand, profile = defaults) => judge(p(cur), p(cand), profile);

test('a higher resolution of the same episode is an upgrade', () => {
  assert.deepEqual(j('The.Show.S01E02.720p.HDTV.x264-GRP', 'The.Show.S01E02.1080p.WEB.h264-OTHER'), { upgrade: true, reason: '720p -> 1080p' });
  assert.equal(j('The.Show.S01E02.HDTV.XviD-LOL', 'The.Show.S01E02.720p.HDTV.x264-GRP').upgrade, true);
});

test('another episode, another year, another title: never', () => {
  assert.equal(j('The.Show.S01E02.720p.HDTV.x264-GRP', 'The.Show.S01E03.1080p.WEB.h264-GRP').reason, 'different title');
  assert.equal(j('The.Show.S01E02.720p.HDTV.x264-GRP', 'The.Show.S01E02E03.1080p.WEB.h264-GRP').reason, 'different title');
  assert.equal(j('Some.Movie.2019.720p.BluRay.x264-GRP', 'Some.Movie.2020.1080p.BluRay.x264-GRP').reason, 'different title');
  assert.equal(j('Some.Movie.2019.720p.BluRay.x264-GRP', 'Some.Movie.1080p.BluRay.x264-GRP').reason, 'different title');
  assert.equal(j('Some.Movie.2019.720p.BluRay.x264-GRP', 'Some.Movie.II.2019.1080p.BluRay.x264-GRP').reason, 'different title');
  assert.equal(j('The.Show.S01E02.720p.HDTV.x264-GRP', 'The.Show.S01.1080p.WEB.h264-GRP').reason, 'different title');
});

test('the profile: maximum resolution, sources, blocked groups, no group, unknown resolution', () => {
  assert.equal(j('Some.Movie.2019.1080p.BluRay.x264-GRP', 'Some.Movie.2019.2160p.BluRay.x265-GRP').reason, 'above the maximum resolution');
  assert.equal(j('Some.Movie.2019.720p.BluRay.x264-GRP', 'Some.Movie.2019.1080p.DVDRip.x264-GRP').upgrade, false);
  assert.equal(j('Some.Movie.2019.720p.BluRay.x264-GRP', 'Some.Movie.2019.1080p.BluRay.x264-BAD', { ...defaults, blockedGroups: [ 'bad' ] }).reason, 'blocked group');
  assert.equal(j('Some.Movie.2019.720p.BluRay.x264-GRP', 'Some Movie 2019 1080p BluRay').reason, 'no group');
  assert.equal(j('Some.Movie.2019.720p.BluRay.x264-GRP', 'Some.Movie.2019.WEB.h264-GRP').reason, 'unknown resolution');
  const uhd = { ...defaults, maxResolution: 2160 };
  assert.equal(j('Some.Movie.2019.1080p.BluRay.x264-GRP', 'Some.Movie.2019.2160p.BluRay.x265-GRP', uhd).upgrade, true);
});

test('PROPER/REPACK only of the same release and group', () => {
  assert.deepEqual(j('The.Show.S01E02.720p.HDTV.x264-GRP', 'The.Show.S01E02.PROPER.720p.HDTV.x264-GRP'), { upgrade: true, reason: 'PROPER of the same release' });
  assert.equal(j('The.Show.S01E02.720p.HDTV.x264-GRP', 'The.Show.S01E02.REPACK.720p.HDTV.x264-GRP').reason, 'REPACK of the same release');
  assert.equal(j('The.Show.S01E02.PROPER.720p.HDTV.x264-GRP', 'The.Show.S01E02.REAL.PROPER.720p.HDTV.x264-GRP').upgrade, true);
  assert.equal(j('The.Show.S01E02.REPACK.720p.HDTV.x264-GRP', 'The.Show.S01E02.PROPER.720p.HDTV.x264-GRP').upgrade, false);
  assert.equal(j('The.Show.S01E02.720p.HDTV.x264-GRP', 'The.Show.S01E02.PROPER.720p.HDTV.x264-OTHER').upgrade, false);
  assert.equal(j('The.Show.S01E02.720p.HDTV.x264-GRP', 'The.Show.S01E02.PROPER.720p.WEB.h264-GRP').upgrade, false);
  assert.equal(j('The.Show.S01E02.720p.HDTV.x264-GRP', 'The.Show.S01E02.PROPER.720p.HDTV.x264-GRP', { ...defaults, takeProper: false }).reason, 'PROPER/REPACK upgrades are off');
});

test('lower or equal quality and the very same release are not upgrades', () => {
  assert.equal(j('The.Show.S01E02.1080p.WEB.h264-GRP', 'The.Show.S01E02.720p.HDTV.x264-GRP').reason, 'lower resolution');
  assert.equal(j('The.Show.S01E02.1080p.WEB.h264-GRP', 'The.Show.S01E02.1080p.WEB.h264-OTHER').reason, 'not better');
  assert.equal(j('The.Show.S01E02.1080p.WEB.h264-GRP', 'the.show.s01e02.1080p.web.h264-grp').reason, 'the same release');
  assert.equal(j('The.Show.S01E02.720p.HDTV.x264-GRP', 'The.Show.S01E02.1080p.WEB.h264-GRP', { ...defaults, upgradeResolution: false }).reason, 'resolution upgrades are off');
});

test('an unknown current resolution allows nothing but a PROPER', () => {
  const current = { ...p('Some.Movie.2019.WEB.h264-GRP') };
  assert.equal(judge(current, p('Some.Movie.2019.1080p.WEB.h264-GRP'), defaults).upgrade, false);
  // Known from the picture (media server) instead
  assert.equal(judge({ ...current, resolution: 720 }, p('Some.Movie.2019.1080p.WEB.h264-GRP'), defaults).upgrade, true);
});

test('the codec counts only when asked to', () => {
  const hevc = { ...defaults, preferredCodec: 'hevc' };
  assert.equal(j('Some.Movie.2019.1080p.BluRay.x264-GRP', 'Some.Movie.2019.1080p.BluRay.x265-OTHER', hevc).upgrade, false);
  assert.equal(j('Some.Movie.2019.1080p.BluRay.x264-GRP', 'Some.Movie.2019.1080p.BluRay.x265-OTHER', { ...hevc, codecUpgrade: true }).upgrade, true);
});

test('the best of several passing candidates; nothing when none passes (no top-result fallback)', () => {
  const current = p('The.Show.S01E02.480p.HDTV.x264-GRP');
  const c = (name, hits = 1) => ({ parsed: p(name), hits, name });
  const best = bestUpgrade(current, [
    c('The.Show.S01E02.720p.HDTV.x264-A', 9),
    c('The.Show.S01E03.1080p.WEB.h264-B', 50),
    c('The.Show.S01E02.1080p.WEB.h264-C', 1),
    c('The.Show.S01E02.2160p.WEB.h265-D', 99),
    c('The.Show.S01E02.1080p.WEB.h265-E', 2),
  ], { ...defaults, preferredCodec: 'hevc' });
  assert.equal(best.name, 'The.Show.S01E02.1080p.WEB.h265-E');
  assert.equal(best.reason, '480p -> 1080p');

  assert.equal(bestUpgrade(current, [ c('The.Show.S01E03.1080p.WEB.h264-B', 50), c('Other.Show.S01E02.1080p.WEB.h264-B') ], defaults), null);
  assert.equal(bestUpgrade(current, [], defaults), null);
});

test('profile from settings', () => {
  const pr = profileOf({ max_resolution: '2160p', allowed_sources: 'web, Blu-Ray', blocked_groups: 'Bad; WORSE', take_proper: false });
  assert.equal(pr.maxResolution, 2160);
  assert.deepEqual(pr.allowedSources, [ 'web-dl', 'bluray' ]);
  assert.deepEqual(pr.blockedGroups, [ 'bad', 'worse' ]);
  assert.equal(pr.takeProper, false);
  assert.equal(pr.upgradeResolution, true);
});

test('a find marked with a language, dub, hardsub or extras tag the kept copy lacks is never an upgrade', () => {
  const ep = 'Show.S01E02.720p.HDTV.x264-GRP';
  for (const cand of [
    'Show.S01E02.FRENCH.1080p.WEB.H264-FGRP',
    'Show.S01E02.GERMAN.DL.1080p.WEB.h264-GGRP',
    'Show.S01E02.iTALiAN.1080p.WEB.h264-IGRP',
    'Show.S01E02.1080p.WEB.h264.NORDiC-NGRP',
    'Show.S01E02.1080p.SWESUB.WEB.h264-NGRP',
    'Show.S01E02.SUBPACK.1080p.WEB.h264-EGRP',
  ]) {
    assert.equal(j(ep, cand).upgrade, false, cand);
  }

  const movie = 'Movie.2019.720p.BluRay.x264-GRP';
  for (const cand of [
    'Movie.2019.1080p.HC.WEBRip.x264-HGRP',
    'Movie.2019.DUBBED.1080p.WEB-DL.x264-DGRP',
    'Movie.2019.MULTi.1080p.BluRay.x264-MGRP',
    'Movie.2019.1080p.BluRay.x264.SUBPACK-SGRP',
    'Movie.2019.1080p.BluRay.x264.Trailer-SGRP',
  ]) {
    assert.equal(j(movie, cand).upgrade, false, cand);
  }

  assert.equal(j('Show.S01.720p.BluRay.x264-GRP', 'Show.S01.EXTRAS.1080p.BluRay.x264-XGRP').upgrade, false);
  assert.equal(j('Show.S01.720p.BluRay.x264-GRP', 'Show.S01.Bonus.1080p.BluRay.x264-XGRP').upgrade, false);

  // The same tag on both sides is fine; an episode title or a streaming tag is not a tag
  assert.equal(j('Show.S01E02.FRENCH.720p.HDTV.x264-GRP', 'Show.S01E02.FRENCH.1080p.WEB.H264-FGRP').upgrade, true);
  assert.equal(j(ep, 'Show.S01E02.Episode.Title.1080p.WEB.h264-EGRP').upgrade, true);
  assert.equal(j(movie, 'Movie.2019.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb').upgrade, true);
  assert.equal(j(movie, 'Movie.2019.MULTiSUBS.1080p.BluRay.x264-MGRP').upgrade, true);
});

test('another year or another country of the same title is never the same thing (either side missing it)', () => {
  // Year: kept without a year never matches a find with one, and the other way round
  assert.equal(j('Doctor.Who.S01E01.720p.HDTV.x264-GRP', 'Doctor.Who.2005.S01E01.1080p.WEB.h264-NEW').reason, 'different title');
  assert.equal(j('Doctor.Who.2005.S01E01.720p.HDTV.x264-GRP', 'Doctor.Who.S01E01.1080p.WEB.h264-NEW').reason, 'different title');
  assert.equal(j('Doctor.Who.1963.S01E01.480p.DVDRip.x264-GRP', 'Doctor.Who.2005.S01E01.720p.WEB.h264-NEW').reason, 'different title');
  assert.equal(j('Dune.1984.720p.BluRay.x264-GRP', 'Dune.2021.1080p.BluRay.x264-NEW').reason, 'different title');
  assert.equal(j('Dune.1984.720p.BluRay.x264-GRP', 'Dune.1080p.BluRay.x264-NEW').reason, 'different title');
  // Country: the bare title is the other country's show
  assert.equal(j('The.Office.US.S02E05.720p.HDTV.x264-GRP', 'The.Office.S02E05.1080p.WEB.h264-NEW').reason, 'different title');
  assert.equal(j('The.Office.S02E05.720p.HDTV.x264-GRP', 'The.Office.US.S02E05.1080p.WEB.h264-NEW').reason, 'different title');
  assert.equal(j('The.Office.UK.S02E05.720p.HDTV.x264-GRP', 'The.Office.US.S02E05.1080p.WEB.h264-NEW').reason, 'different title');
  assert.equal(j('The.Office.US.S02E05.720p.HDTV.x264-GRP', 'The.Office.US.S02E05.1080p.WEB.h264-NEW').upgrade, true);
});

// Live test 2026-10-19: a peer shared "Some.Film.2019.1080p.WEB-DL.x264-GRP-sample". The part after
// the last "-" was taken for the group ("sample"), the tag never reached the tag list, and the
// sample folder was judged a 720p -> 1080p upgrade (it would be downloaded when it is the only find).
test('a "-sample" / "-proof" / "-subs" suffix after the group is content, not a group: never an upgrade', () => {
  const kept = 'Some.Film.2019.720p.WEB-DL.x264-GRP';
  for (const suffix of [ 'sample', 'Sample', 'proof', 'subs', 'extras', 'trailer' ]) {
    const v = j(kept, `Some.Film.2019.1080p.WEB-DL.x264-GRP-${suffix}`);
    assert.equal(v.upgrade, false, `-${suffix}: ${v.reason}`);
  }

  assert.equal(p('Some.Film.2019.1080p.WEB-DL.x264-GRP-sample').group, 'GRP');
  assert.ok(p('Some.Film.2019.1080p.WEB-DL.x264-GRP-sample').tags.includes('sample'));
  // A group that merely looks like a word stays a group
  assert.equal(j(kept, 'Some.Film.2019.1080p.WEB-DL.x264-SAMPLER').upgrade, true);
  assert.equal(j(kept, 'Some.Film.2019.1080p.WEB-DL.x264-GRP').upgrade, true);
});
