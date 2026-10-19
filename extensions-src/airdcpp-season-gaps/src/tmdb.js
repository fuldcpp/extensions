'use strict';

// The TMDB questions this extension asks: a show (its season list), a season (its episodes'
// air dates) and, for a series the media server has not identified, a title search.
//
// - Answers are cached on disk: 7 days for a show that has ended, 1 day for one still running.
// - At most one request every 250 ms (about 4 a second), one at a time.
// - The key never reaches a log line or an error message: errors are built from an allow-list,
//   never from the URL (a v3 key travels in the query) or a header.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const API_ROOT = 'https://api.themoviedb.org/3/';
const DAY_MS = 24 * 60 * 60 * 1000;
const ENDED_TTL_MS = 7 * DAY_MS;
const RUNNING_TTL_MS = DAY_MS;
const SEARCH_TTL_MS = 7 * DAY_MS;
const NOT_FOUND_TTL_MS = 7 * DAY_MS;
const PRUNE_AGE_MS = 30 * DAY_MS;
const MAX_RETRY_AFTER_MS = 10 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;

const tmdbError = (status, reason) => {
  const error = new Error(reason);
  error.status = status;
  error.fromTmdb = true;
  return error;
};

const isEnded = (show) => !!show && /^(ended|canceled|cancelled)$/i.test(String(show.status || ''));

// A v4 "API Read Access Token" is a JWT; anything else is treated as a v3 API key
const isBearer = (key) => /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/.test(key);

const sleepReal = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  if (timer && typeof timer.unref === 'function') timer.unref();
});

const createTmdb = ({
  getKey, getLanguage = () => '', cacheDir, fetchImpl, now = () => Date.now(), sleep = sleepReal, minIntervalMs = 250,
}) => {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  let chain = Promise.resolve();
  let nextAt = 0;
  let requestCount = 0;

  const cacheFile = (key) => path.join(cacheDir, `${key}.json`);

  const readCache = (key) => {
    try {
      const data = JSON.parse(fs.readFileSync(cacheFile(key), 'utf8'));
      return data && typeof data.at === 'number' ? data : null;
    } catch (error) {
      return null;
    }
  };

  const writeCache = (key, entry) => {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      const tmp = `${cacheFile(key)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entry));
      fs.renameSync(tmp, cacheFile(key));
    } catch (error) {
      // A cache that cannot be written only costs requests
    }
  };

  // Spacing applies across every caller: requests are queued, never run side by side
  const throttled = (fn) => {
    const run = chain.then(async () => {
      const wait = nextAt - now();
      if (wait > 0) {
        await sleep(wait);
      }

      nextAt = now() + minIntervalMs;
      return fn();
    });
    chain = run.catch(() => {});
    return run;
  };

  const fetchOnce = async (urlPath, params) => {
    const key = String((await getKey()) || '').trim();
    if (!key) {
      throw tmdbError(401, 'no TMDB key is set');
    }

    const url = new URL(API_ROOT + urlPath);
    for (const [ name, value ] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(name, String(value));
      }
    }

    const language = String((await getLanguage()) || '').trim();
    if (language) {
      url.searchParams.set('language', language);
    }

    const headers = { Accept: 'application/json' };
    if (isBearer(key)) {
      headers.Authorization = `Bearer ${key}`;
    } else {
      url.searchParams.set('api_key', key);
    }

    const options = { headers, redirect: 'error' };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      options.signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    }

    requestCount++;
    try {
      return await doFetch(url.toString(), options);
    } catch (error) {
      const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw tmdbError(0, timedOut ? 'TMDB did not answer in time' : 'could not reach TMDB');
    }
  };

  const request = async (urlPath, params) => {
    let response = await throttled(() => fetchOnce(urlPath, params));
    if (response.status === 429) {
      const seconds = Number(response.headers && response.headers.get ? response.headers.get('retry-after') : NaN);
      const wait = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : 2000;
      await sleep(wait);
      response = await throttled(() => fetchOnce(urlPath, params));
    }

    if (response.status === 401) {
      throw tmdbError(401, 'TMDB refused the key');
    }

    if (response.status === 404) {
      throw tmdbError(404, 'TMDB does not know this title');
    }

    if (!response.ok) {
      throw tmdbError(response.status, `TMDB answered HTTP ${response.status}`);
    }

    try {
      return JSON.parse(await response.text());
    } catch (error) {
      throw tmdbError(response.status, 'TMDB sent an answer that is not JSON');
    }
  };

  // Fresh cache first; then the network; a stale answer when the network fails for a passing
  // reason (never for a refused key, which the user has to fix)
  const cached = async (key, ttlOf, loader) => {
    const entry = readCache(key);
    if (entry && now() - entry.at < (entry.notFound ? NOT_FOUND_TTL_MS : ttlOf(entry.data))) {
      if (entry.notFound) {
        throw tmdbError(404, 'TMDB does not know this title');
      }

      return entry.data;
    }

    try {
      const data = await loader();
      writeCache(key, { at: now(), data });
      return data;
    } catch (error) {
      if (error.status === 404) {
        writeCache(key, { at: now(), notFound: true });
        throw error;
      }

      if (entry && !entry.notFound && error.status !== 401) {
        return entry.data;
      }

      throw error;
    }
  };

  const validId = (id) => {
    const text = String(id || '');
    if (!/^\d{1,10}$/.test(text)) {
      throw tmdbError(400, 'not a TMDB id');
    }

    return text;
  };

  const getShow = (id) => {
    const tvId = validId(id);
    return cached(`tv-${tvId}`, (data) => (isEnded(data) ? ENDED_TTL_MS : RUNNING_TTL_MS), () => request(`tv/${tvId}`));
  };

  const getSeason = (id, seasonNumber, ended) => {
    const tvId = validId(id);
    const season = Number(seasonNumber);
    if (!Number.isInteger(season) || season < 0 || season > 1000) {
      throw tmdbError(400, 'not a season number');
    }

    return cached(`tv-${tvId}-s${season}`, () => (ended ? ENDED_TTL_MS : RUNNING_TTL_MS), () => request(`tv/${tvId}/season/${season}`));
  };

  const searchShow = (name, year) => {
    const query = String(name || '').trim().slice(0, 200);
    if (!query) {
      throw tmdbError(400, 'no title to search for');
    }

    const hash = crypto.createHash('sha1').update(`${query.toLowerCase()}|${year || ''}`).digest('hex').slice(0, 20);
    return cached(`search-${hash}`, () => SEARCH_TTL_MS, () => request('search/tv', {
      query, first_air_date_year: year > 0 ? year : undefined, include_adult: 'false',
    }));
  };

  // Old answers are removed so the folder cannot grow for ever
  const prune = () => {
    let names = [];
    try {
      names = fs.readdirSync(cacheDir);
    } catch (error) {
      return 0;
    }

    let removed = 0;
    for (const name of names) {
      if (!/^(tv|search)-[\w-]+\.json(\.tmp)?$/.test(name)) {
        continue;
      }

      try {
        const file = path.join(cacheDir, name);
        if (now() - fs.statSync(file).mtimeMs > PRUNE_AGE_MS) {
          fs.unlinkSync(file);
          removed++;
        }
      } catch (error) {
        // Gone already
      }
    }

    return removed;
  };

  return { getShow, getSeason, searchShow, prune, isEnded, getRequestCount: () => requestCount };
};

module.exports = { createTmdb, isEnded, isBearer };
