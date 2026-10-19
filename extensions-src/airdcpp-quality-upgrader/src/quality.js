'use strict';

// Whether a release found on a hub is an upgrade of what is already kept, by the user's profile.
// Pure functions. Nothing here ever falls back to "the first result": a candidate either passes
// every rule or it is not an upgrade.

const { identityKey } = require('./release');

const SOURCE_NAMES = { 'web-dl': 'web-dl', webdl: 'web-dl', web: 'web-dl', webrip: 'webrip', bluray: 'bluray', 'blu-ray': 'bluray', bd: 'bluray', hdtv: 'hdtv', dvd: 'dvd', dvdrip: 'dvd' };

const parseList = (text) => String(text || '').split(/[,;\n]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);

// Settings values -> a profile
const profileOf = (values) => ({
  maxResolution: Number(String(values.max_resolution || '1080').replace(/p$/i, '')) || 1080,
  allowedSources: parseList(values.allowed_sources).map((s) => SOURCE_NAMES[s] || s),
  preferredCodec: ((c) => (c === 'none' ? '' : c))(String(values.preferred_codec || '').toLowerCase()),
  codecUpgrade: Boolean(values.codec_upgrade),
  takeProper: values.take_proper !== false,
  upgradeResolution: values.upgrade_resolution !== false,
  blockedGroups: parseList(values.blocked_groups),
});

// Why a candidate cannot be taken at all, or null when the profile allows it
const profileRejects = (candidate, profile) => {
  if (!candidate || !candidate.kind) return 'not a release';
  if (!candidate.group) return 'no group';
  if (!candidate.resolution) return 'unknown resolution';
  if (candidate.resolution > profile.maxResolution) return 'above the maximum resolution';
  if (profile.allowedSources.length > 0 && !profile.allowedSources.includes(candidate.source)) return `source ${candidate.source || 'unknown'} not allowed`;
  if (profile.blockedGroups.includes(candidate.group.toLowerCase())) return 'blocked group';
  return null;
};

// Same release apart from the PROPER/REPACK markers
const sameRelease = (a, b) => (a.group || '').toLowerCase() === (b.group || '').toLowerCase()
  && a.resolution === b.resolution && a.source === b.source && a.codec === b.codec;

// { upgrade: boolean, reason } for one candidate against the copy kept now.
// `current.resolution` may come from the real picture (media server) rather than the name.
const judge = (current, candidate, profile) => {
  if (!current || !candidate) return { upgrade: false, reason: 'missing' };
  const key = identityKey(current);
  if (!key || key !== identityKey(candidate)) return { upgrade: false, reason: 'different title' };
  if (String(candidate.name).toLowerCase() === String(current.name).toLowerCase()) return { upgrade: false, reason: 'the same release' };

  const rejected = profileRejects(candidate, profile);
  if (rejected) return { upgrade: false, reason: rejected };

  // Another language, a dub, burnt-in subtitles, a bonus disc...: not the same thing at all
  const kept = new Set(current.tags || []);
  const extra = (candidate.tags || []).filter((t) => !kept.has(t));
  if (extra.length > 0) return { upgrade: false, reason: `marked ${extra.join(' ')}, the kept copy is not` };

  if (current.resolution && candidate.resolution > current.resolution) {
    return profile.upgradeResolution ?
      { upgrade: true, reason: `${current.resolution}p -> ${candidate.resolution}p` } :
      { upgrade: false, reason: 'resolution upgrades are off' };
  }

  if (!current.resolution || candidate.resolution < current.resolution) {
    return { upgrade: false, reason: current.resolution ? 'lower resolution' : 'the current resolution is unknown' };
  }

  // Same resolution
  if (current.group && sameRelease(current, candidate) && candidate.properLevel > current.properLevel) {
    return profile.takeProper ?
      { upgrade: true, reason: candidate.real ? 'REAL PROPER of the same release' : (candidate.repack ? 'REPACK of the same release' : 'PROPER of the same release') } :
      { upgrade: false, reason: 'PROPER/REPACK upgrades are off' };
  }

  if (profile.codecUpgrade && profile.preferredCodec && candidate.codec === profile.preferredCodec && current.codec !== profile.preferredCodec) {
    return { upgrade: true, reason: `${current.codec || 'unknown codec'} -> ${candidate.codec}` };
  }

  return { upgrade: false, reason: 'not better' };
};

// Higher resolution first, then the higher proper level, then the preferred codec, then the most
// sources. Only among candidates that each passed judge().
const rank = (a, b, profile) => (b.parsed.resolution - a.parsed.resolution)
  || (b.parsed.properLevel - a.parsed.properLevel)
  || ((b.parsed.codec === profile.preferredCodec ? 1 : 0) - (a.parsed.codec === profile.preferredCodec ? 1 : 0))
  || ((b.hits || 0) - (a.hits || 0))
  || String(a.parsed.name).localeCompare(String(b.parsed.name));

// candidates: [{ parsed, hits, ...anything }] -> the best upgrade with its reason, or null
const bestUpgrade = (current, candidates, profile) => {
  const passing = [];
  for (const c of candidates) {
    const verdict = judge(current, c.parsed, profile);
    if (verdict.upgrade) passing.push({ ...c, reason: verdict.reason });
  }

  passing.sort((a, b) => rank(a, b, profile));
  return passing[0] || null;
};

module.exports = { profileOf, profileRejects, judge, bestUpgrade, parseList };
