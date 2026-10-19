'use strict';

// The episode list beyond what is held, from TMDB (themoviedb.org), with a disk cache.
//
// The client's own catalogue key (MediaServerMetadataKey) is not readable over the extension Web
// API: CoreSettings.h lists no media-server setting but the log ones, and MediaServerApi.cpp only
// answers status + requests. So the user gives the extension its own key. The key is never
// logged: errors carry an allow-listed reason only, never the URL (which holds a v3 key).

const API_ROOT = 'https://api.themoviedb.org/3';
const SHOW_TTL_MS = 12 * 60 * 60 * 1000;
const SEASON_TTL_MS = 12 * 60 * 60 * 1000;
const SEARCH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 24 * 60 * 60 * 1000;
const PRUNE_AFTER_MS = 45 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 20 * 1000;

const { normalizeTitle, splitTitleYear } = require('./release');

const createError = (reason, status) => {
  const error = new Error(reason);
  if (status !== undefined) error.status = status;
  return error;
};

const emptyCache = () => ({ version: 1, shows: {}, seasons: {}, search: {} });

// createTmdb({ getKey, fetchImpl, loadCache, saveCache, now })
const createTmdb = ({ getKey, fetchImpl, loadCache, saveCache, now = () => Date.now() }) => {
  let cache = null;

  const store = () => {
    if (!cache) {
      const loaded = loadCache();
      cache = loaded && typeof loaded === 'object' ? { ...emptyCache(), ...loaded } : emptyCache();
    }

    return cache;
  };

  const persist = () => {
    const c = store();
    const limit = now() - PRUNE_AFTER_MS;
    for (const section of [ 'shows', 'seasons', 'search' ]) {
      for (const [ key, entry ] of Object.entries(c[section])) {
        if (!entry || !(entry.at > limit)) delete c[section][key];
      }
    }

    saveCache(c);
  };

  const fresh = (entry, ttl) => entry && entry.at > now() - ttl;

  const call = async (path, query = {}) => {
    const key = String(getKey() || '').trim();
    if (!key) {
      throw createError('no TMDB key is set');
    }

    const params = new URLSearchParams(query);
    const headers = { Accept: 'application/json' };
    // A v4 read access token is a JWT and goes in a header; a v3 key goes in the query
    if (key.startsWith('eyJ')) {
      headers.Authorization = `Bearer ${key}`;
    } else {
      params.set('api_key', key);
    }

    let response;
    try {
      response = await fetchImpl(`${API_ROOT}${path}?${params.toString()}`, {
        headers,
        redirect: 'error',
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined,
      });
    } catch (error) {
      throw createError('could not reach TMDB');
    }

    if (response.status === 401) throw createError('TMDB refused the key', 401);
    if (response.status === 404) throw createError('TMDB does not know it', 404);
    if (!response.ok) throw createError(`TMDB answered HTTP ${response.status}`, response.status);

    try {
      return JSON.parse(await response.text());
    } catch (error) {
      throw createError('TMDB sent something that is not JSON');
    }
  };

  // { id, name, originalName, year, seasons: [{ number, episodes }] }
  const show = async (id) => {
    const c = store();
    const key = String(id);
    if (fresh(c.shows[key], SHOW_TTL_MS)) {
      return c.shows[key].data;
    }

    const body = await call(`/tv/${encodeURIComponent(key)}`);
    const data = {
      id: Number(body.id) || Number(id),
      name: String(body.name || ''),
      originalName: String(body.original_name || ''),
      year: /^\d{4}/.test(String(body.first_air_date || '')) ? Number(String(body.first_air_date).slice(0, 4)) : null,
      seasons: (Array.isArray(body.seasons) ? body.seasons : [])
        .map((s) => ({ number: Number(s.season_number), episodes: Number(s.episode_count) || 0 }))
        .filter((s) => Number.isInteger(s.number) && s.number > 0),
    };
    c.shows[key] = { at: now(), data };
    persist();
    return data;
  };

  // [{ season, episode, airDate }]
  const season = async (id, number) => {
    const c = store();
    const key = `${id}:${number}`;
    if (fresh(c.seasons[key], SEASON_TTL_MS)) {
      return c.seasons[key].data;
    }

    const body = await call(`/tv/${encodeURIComponent(String(id))}/season/${Number(number)}`);
    const data = (Array.isArray(body.episodes) ? body.episodes : [])
      .map((e) => ({ season: Number(number), episode: Number(e.episode_number), airDate: typeof e.air_date === 'string' ? e.air_date : '' }))
      .filter((e) => Number.isInteger(e.episode) && e.episode > 0);
    c.seasons[key] = { at: now(), data };
    persist();
    return data;
  };

  // The show's TMDB id from its name (and year), only on an exact normalised name match
  const findShow = async (name, year) => {
    const c = store();
    const split = splitTitleYear(name);
    const wantedYear = year || split.year || null;
    const key = `${normalizeTitle(split.title)}|${wantedYear || ''}`;
    const cached = c.search[key];
    if (cached && (cached.id ? fresh(cached, SEARCH_TTL_MS) : fresh(cached, MISS_TTL_MS))) {
      return cached.id || null;
    }

    const query = { query: split.title };
    if (wantedYear) query.first_air_date_year = String(wantedYear);
    const body = await call('/search/tv', query);
    const wantedName = normalizeTitle(split.title);
    const match = (Array.isArray(body.results) ? body.results : []).find((r) => {
      const names = [ normalizeTitle(r.name), normalizeTitle(r.original_name) ];
      const resultYear = /^\d{4}/.test(String(r.first_air_date || '')) ? Number(String(r.first_air_date).slice(0, 4)) : null;
      return names.includes(wantedName) && (!wantedYear || !resultYear || resultYear === wantedYear);
    });

    c.search[key] = { at: now(), id: match ? Number(match.id) : 0 };
    persist();
    return match ? Number(match.id) : null;
  };

  // The episodes after (season, episode), in airing order, from the seasons that can hold them:
  // at most `count` of them, specials (season 0) never
  const episodesAfter = async (id, afterSeason, afterEpisode, count) => {
    const info = await show(id);
    const out = [];

    // The last one watched must exist in TMDB's numbering; when it does not (absolute numbering,
    // another episode order) TMDB's "next" would be episodes the library holds under other numbers
    if (afterSeason >= 1) {
      const current = (await season(id, afterSeason).catch((error) => {
        if (error.status === 404) return [];
        throw error;
      }));
      if (!current.some((e) => e.episode === afterEpisode)) {
        return { info, episodes: [], numberingDiffers: true };
      }
    }

    const seasons = info.seasons.map((s) => s.number).filter((n) => n >= Math.max(1, afterSeason)).sort((a, b) => a - b);
    for (const number of seasons) {
      if (out.length >= count) break;
      const list = (await season(id, number)).slice().sort((a, b) => a.episode - b.episode);
      for (const e of list) {
        if (number === afterSeason && e.episode <= afterEpisode) continue;
        out.push(e);
        if (out.length >= count) break;
      }
    }

    return { info, episodes: out };
  };

  return { show, season, findShow, episodesAfter };
};

module.exports = { createTmdb };
