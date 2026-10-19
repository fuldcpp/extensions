'use strict';

// Pure decisions: what the library holds, which episodes have aired, and which seasons a user
// wants reported. No I/O here.

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE = 100; // the media server reads a double episode the same way (withMissingEpisodes)

// season number -> Set of episode numbers, from the media server's episode items.
// A multi-episode file (S01E01E02) is one item with IndexNumber 1 and IndexNumberEnd 2
// (JellyfinApi.cpp:6309 at origin/master); it counts for both numbers.
const ownedEpisodes = (items) => {
  const owned = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || item.LocationType === 'Virtual') continue;
    const season = item.ParentIndexNumber;
    const first = item.IndexNumber;
    if (!Number.isInteger(season) || !Number.isInteger(first) || season < 0 || first <= 0) continue;

    const end = Number.isInteger(item.IndexNumberEnd) && item.IndexNumberEnd > first ? Math.min(item.IndexNumberEnd, first + MAX_RANGE - 1) : first;
    if (!owned.has(season)) owned.set(season, new Set());
    for (let n = first; n <= end; n++) owned.get(season).add(n);
  }

  return owned;
};

// "2024-03-05" or "2024-03-05T00:00:00.0000000Z" -> UTC day number, or null
const dayOf = (date) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date || ''));
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(ms) ? Math.floor(ms / DAY_MS) : null;
};

// Aired when its day is before today minus the grace days. With 1 day of grace an episode that
// aired yesterday is not missing yet; one from the day before is. No date: not aired.
const isAired = (date, now, graceDays = 1) => {
  const day = dayOf(date);
  if (day === null) return false;
  return day < Math.floor(now / DAY_MS) - Math.max(0, graceDays);
};

// Season numbers the user does not hold at all and wants reported, given the catalogue's list.
//   between: after the first held season and before the last (default on)
//   after:   newer than the last held season (default on: a new season of a show you keep)
//   before:  older than the first held season (default off: you may have started late on purpose)
// Specials (season 0) only with includeSpecials.
const wholeSeasonsToReport = (catalogueSeasons, owned, policy) => {
  const held = Array.from(owned.keys()).filter((s) => s >= 1 && owned.get(s).size > 0);
  if (held.length === 0) return [];
  const first = Math.min(...held);
  const last = Math.max(...held);

  const ret = [];
  for (const season of catalogueSeasons) {
    if (!Number.isInteger(season) || owned.has(season) && owned.get(season).size > 0) continue;
    if (season === 0) {
      if (policy.includeSpecials) ret.push(season);
      continue;
    }

    if (season < first ? policy.before : season > last ? policy.after : policy.between) {
      ret.push(season);
    }
  }

  return ret.sort((a, b) => a - b);
};

// The aired episodes of one season that are not held. Returns null when the season's numbering
// cannot be the catalogue's (a season numbered from the show's start, as anime often is): the
// media server leaves those alone for the same reason. The media server's own missing rows were
// already checked that way and list only what is missing, so they skip the check.
const missingInSeason = (episodes, ownedSet, now, graceDays, { checkNumbering = true } = {}) => {
  const list = (Array.isArray(episodes) ? episodes : []).filter((e) => e && Number.isInteger(e.number) && e.number > 0);
  const have = ownedSet || new Set();
  if (list.length === 0) return [];

  const highest = Math.max(...list.map((e) => e.number));
  if (checkNumbering && have.size > 0 && (Math.max(...have) > highest || !list.some((e) => have.has(e.number)))) {
    return null;
  }

  return list
    .filter((e) => !have.has(e.number) && isAired(e.airDate, now, graceDays))
    .map((e) => ({ episode: e.number, airDate: String(e.airDate).slice(0, 10), title: e.title || '' }))
    .sort((a, b) => a.episode - b.episode);
};

// TMDB season answer -> [{ number, airDate, title }]
const tmdbEpisodes = (season) => (season && Array.isArray(season.episodes) ? season.episodes : [])
  .map((e) => ({ number: e.episode_number, airDate: e.air_date, title: typeof e.name === 'string' ? e.name : '' }));

// The media server's own missing rows (IsMissing=true) -> [{ number, airDate, title }]
const nativeEpisodes = (items) => (Array.isArray(items) ? items : [])
  .filter((i) => i && i.LocationType === 'Virtual' && Number.isInteger(i.IndexNumber))
  .map((i) => ({ number: i.IndexNumber, airDate: i.PremiereDate, title: typeof i.Name === 'string' ? i.Name : '' }));

module.exports = {
  ownedEpisodes, dayOf, isAired, wholeSeasonsToReport, missingInSeason, tmdbEpisodes, nativeEpisodes, DAY_MS,
};
