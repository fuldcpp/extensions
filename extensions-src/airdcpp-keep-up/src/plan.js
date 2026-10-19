'use strict';

// What is being watched and what comes next. Pure functions over the media server's answers.

const DAY_MS = 24 * 60 * 60 * 1000;

const parseDate = (text) => {
  const ms = Date.parse(String(text || ''));
  return Number.isFinite(ms) ? ms : 0;
};

// The shows with an episode played within `days`, most recent first.
//   items: episodes from /Users/{id}/Items?Filters=IsPlayed (UserData.LastPlayedDate,
//   JellyfinApi.cpp:4933; SeriesId/SeriesName :6324)
const recentShows = (items, nowMs, days) => {
  const since = nowMs - days * DAY_MS;
  const shows = new Map();
  for (const item of items || []) {
    if (!item || item.Type !== 'Episode' || !item.SeriesId) continue;
    const played = item.UserData && item.UserData.Played;
    const at = parseDate(item.UserData && item.UserData.LastPlayedDate);
    if (!played || at < since || at > nowMs + DAY_MS) continue;
    const known = shows.get(item.SeriesId);
    if (!known || at > known.lastPlayedMs) {
      shows.set(item.SeriesId, { seriesId: item.SeriesId, seriesName: String(item.SeriesName || ''), lastPlayedMs: at });
    }
  }

  return Array.from(shows.values()).sort((a, b) => b.lastPlayedMs - a.lastPlayedMs);
};

const isHeld = (item) => item && item.Type === 'Episode' && item.LocationType !== 'Virtual';

// Every (season, episode) the library holds: "1:2". A double episode holds both numbers.
const heldEpisodes = (episodes) => {
  const held = new Set();
  for (const item of episodes || []) {
    if (!isHeld(item)) continue;
    const season = Number(item.ParentIndexNumber);
    const first = Number(item.IndexNumber);
    if (!Number.isInteger(season) || !Number.isInteger(first) || first < 0) continue;
    const last = Number.isInteger(item.IndexNumberEnd) && item.IndexNumberEnd >= first ? Math.min(item.IndexNumberEnd, first + 20) : first;
    for (let n = first; n <= last; n++) held.add(`${season}:${n}`);
  }

  return held;
};

// The furthest episode played, in airing order, specials left out (as the server's own NextUp
// does, JellyfinApi.cpp:16703-16716)
const furthestPlayed = (episodes) => {
  let best = null;
  for (const item of episodes || []) {
    if (!isHeld(item) || !(item.UserData && item.UserData.Played)) continue;
    const season = Number(item.ParentIndexNumber);
    const episode = Number.isInteger(item.IndexNumberEnd) ? Math.max(item.IndexNumberEnd, Number(item.IndexNumber)) : Number(item.IndexNumber);
    if (!Number.isInteger(season) || season < 1 || !Number.isInteger(episode)) continue;
    if (!best || season > best.season || (season === best.season && episode > best.episode)) {
      best = { season, episode };
    }
  }

  return best;
};

const todayOf = (nowMs) => new Date(nowMs).toISOString().slice(0, 10);

// From the next episodes (in airing order, already only those after the furthest played), the
// ones that have aired and are not held
const wantedEpisodes = (nextEpisodes, held, nowMs) => {
  const today = todayOf(nowMs);
  return (nextEpisodes || []).filter((e) => /^\d{4}-\d{2}-\d{2}/.test(e.airDate || '')
    && e.airDate.slice(0, 10) <= today
    && !held.has(`${e.season}:${e.episode}`));
};

// The next `count` episodes after (season, episode) from a season listing that also carries the
// server's own "missing" rows (LocationType Virtual, JellyfinApi.cpp:1259-1290): for when there is
// no TMDB key. Held and missing rows both count towards `count`, as the TMDB path does.
const nextFromMissingRows = (rows, after, count) => (rows || [])
  .filter((r) => r && r.Type === 'Episode' && Number.isInteger(r.ParentIndexNumber) && Number.isInteger(r.IndexNumber))
  .map((r) => ({ season: r.ParentIndexNumber, episode: r.IndexNumber, airDate: String(r.PremiereDate || '').slice(0, 10) }))
  .filter((e) => e.season > 0 && (e.season > after.season || (e.season === after.season && e.episode > after.episode)))
  .sort((a, b) => (a.season - b.season) || (a.episode - b.episode))
  .slice(0, count);

// Backoff after a search that found nothing usable: 1 h, 2 h, 4 h ... at most 24 h
const backoffMs = (attempts) => Math.min(24, 2 ** Math.max(0, attempts - 1)) * 60 * 60 * 1000;

module.exports = { recentShows, heldEpisodes, furthestPlayed, wantedEpisodes, nextFromMissingRows, backoffMs, todayOf, DAY_MS };
