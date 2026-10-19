'use strict';

// One check over the whole media library: which aired episodes of each series are missing.
//
// Where the answers come from (JellyfinApi.cpp / MediaServerManager.cpp at origin/master f163a4989):
// - Series: GET /Items?Recursive=true&IncludeItemTypes=Series (route JellyfinApi.cpp:18056, the
//   browse() filters at :7414 and :7518; Limit capped at MAX_LIMIT = 1000, :58). A share series the
//   catalogue matched carries ProviderIds.Tmdb (:5331); an IPTV provider's series never does
//   (fromProvider, :5329), so provider titles drop out on their own.
// - Held episodes: GET /Shows/{id}/Episodes (all of a series, paged; :16560, :16600) with
//   ParentIndexNumber, IndexNumber and IndexNumberEnd for a double episode (:6300-:6313).
// - Seasons: GET /Shows/{id}/Seasons (:16536).
// - Missing episodes inside a held season, natively: GET /Shows/{id}/Episodes?SeasonId=..&IsMissing=true
//   (:16588 -> withMissingEpisodes() :1304; IsMissing=true empties the held list, :7644). Only for
//   an account whose DisplayMissingEpisodes preference is on (:1317), only for seasons the share
//   holds, from the catalogue list the media server fetches in the background
//   (MediaServerManager::lookupSeasonList, MediaServerManager.cpp:7518) -- so the first look at a
//   season may come back empty and the next one is complete.
// - The account and its preference: GET /Users/Me (:14182; Configuration.DisplayMissingEpisodes,
//   :3872); turning it on: POST /Users/{id}/Configuration (:15147, only the fields sent change, :15199).
// - Whole missing seasons are not covered by the media server (commit 86590ef20 "Not covered:
//   whole missing seasons"), so they come from TMDB tv/{id} and tv/{id}/season/{n}, which needs
//   the user's own TMDB key: the media server's key (MediaServerMetadataKey) is not a Web API
//   setting (CoreSettings.h has no media server keys).

const { ownedEpisodes, wholeSeasonsToReport, missingInSeason, tmdbEpisodes, nativeEpisodes } = require('./gaps');
const { titleKeys, showKeys, showYears, compact } = require('./release');

const PAGE = 500;
const MAX_SERIES = 5000;
const MAX_EPISODES_PER_SERIES = 20000;

const errorText = (error) => (error && error.message) || String(error);

const paged = async (jellyfin, path, query, max) => {
  const items = [];
  for (let start = 0; start < max;) {
    const page = await jellyfin.get(path, { ...query, StartIndex: start, Limit: PAGE });
    const list = page && Array.isArray(page.Items) ? page.Items : [];
    items.push(...list);
    const total = page && Number.isInteger(page.TotalRecordCount) ? page.TotalRecordCount : items.length;
    if (list.length === 0 || items.length >= total) break;
    start += list.length;
  }

  return items.slice(0, max);
};

const ignoredKeys = (text) => new Set(String(text || '').split(/[\n,]/).map((s) => compact(s)).filter(Boolean));

// tmdb: null when no key is set. options: { graceDays, includeSpecials, between, after, before,
// identifyByName, setDisplayMissing, ignoredShows }
const sleepReal = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  if (timer && typeof timer.unref === 'function') timer.unref();
});

const runCheck = async ({ jellyfin, tmdb, options, now = Date.now(), log = () => {}, sleep = sleepReal }) => {
  const notes = [];
  const today = now;
  // Seasons of identified shows whose native list came back empty: the media server fetches a
  // season's list in the background on the first question and answers it empty until then
  // (live test 2026-10-19), so they are asked once more after one pause for the whole check
  const askAgain = [];

  // The account: whether the media server will list missing episodes for it
  let native = false;
  try {
    const me = await jellyfin.get('/Users/Me');
    native = !!(me && me.Configuration && me.Configuration.DisplayMissingEpisodes === true);
    if (!native && options.setDisplayMissing && me && typeof me.Id === 'string' && /^[\w-]+$/.test(me.Id)) {
      try {
        await jellyfin.post(`/Users/${me.Id}/Configuration`, { DisplayMissingEpisodes: true });
        native = true;
        notes.push('Turned on "Display missing episodes" for the media server account this extension signs in with.');
      } catch (error) {
        notes.push(`Could not turn on "Display missing episodes" for the extension's account: ${errorText(error)}.`);
      }
    }
  } catch (error) {
    if (error.status === 401 || error.status === 0) throw error;
    notes.push(`Could not read the media server account: ${errorText(error)}.`);
  }

  let tmdbUsable = !!tmdb;
  if (!native && !tmdbUsable) {
    const error = new Error('nothing to compare with: turn on "Display missing episodes" for the extension\'s media server account, or set a TMDB key');
    error.status = 412;
    throw error;
  }

  // A refused key stops TMDB for the rest of the check (said once); other failures cost one title
  const tmdbFailed = (error, what) => {
    if (error.status === 401) {
      if (tmdbUsable) notes.push(`TMDB: ${errorText(error)}; the rest of this check used the media server only.`);
      tmdbUsable = false;
    } else if (error.status !== 404 && what) {
      notes.push(`TMDB, ${what}: ${errorText(error)}.`);
    }
  };

  if (!native) notes.push('"Display missing episodes" is off for the extension\'s media server account: missing episodes come from TMDB.');
  if (!tmdbUsable) notes.push('No TMDB key is set: whole missing seasons are not reported, only gaps inside the seasons you have.');

  const ignored = ignoredKeys(options.ignoredShows);
  const series = await paged(jellyfin, '/Items', { Recursive: 'true', IncludeItemTypes: 'Series', SortBy: 'SortName' }, MAX_SERIES);
  const shows = [];
  let unidentified = 0;

  for (const item of series) {
    if (!item || typeof item.Id !== 'string' || item.Type !== 'Series') continue;
    const name = typeof item.Name === 'string' ? item.Name : '';
    const keys = titleKeys(name);
    const productionYear = Number.isInteger(item.ProductionYear) ? item.ProductionYear : 0;
    const show = {
      seriesId: item.Id, name, tmdbId: null, tmdbName: '', keys: Array.from(showKeys([ name ])), years: showYears([ name ], productionYear), seasons: [], skipped: '',
    };
    shows.push(show);

    if ([ ...keys ].some((k) => ignored.has(k))) {
      show.skipped = 'on the ignore list';
      continue;
    }

    try {
      const episodes = await paged(jellyfin, `/Shows/${encodeURIComponent(item.Id)}/Episodes`, {}, MAX_EPISODES_PER_SERIES);
      const owned = ownedEpisodes(episodes);
      if (![ ...owned.keys() ].some((s) => s >= 1)) {
        show.skipped = 'no numbered episodes (a show named by dates, or specials only)';
        continue;
      }

      // The catalogue id: the media server's own match, else a careful search by name
      const tmdbText = item.ProviderIds && item.ProviderIds.Tmdb;
      if (typeof tmdbText === 'string' && /^\d{1,10}$/.test(tmdbText)) {
        show.tmdbId = tmdbText;
      } else if (tmdbUsable && options.identifyByName) {
        try {
          show.tmdbId = await identify(tmdb, name, item.ProductionYear, keys);
        } catch (error) {
          tmdbFailed(error);
        }
      }

      let catalogue = null;
      if (tmdbUsable && show.tmdbId) {
        try {
          catalogue = await tmdb.getShow(show.tmdbId);
          show.tmdbName = typeof catalogue.name === 'string' ? catalogue.name : '';
          // A country tag on any name rules the bare title out (release.js showKeys)
          const names = [ name, catalogue.name, catalogue.original_name ].filter((n) => typeof n === 'string');
          show.keys = Array.from(showKeys(names));
          show.years = showYears(names, productionYear, catalogue.first_air_date);
        } catch (error) {
          tmdbFailed(error, name);
        }
      }

      const ended = catalogue ? tmdb.isEnded(catalogue) : false;
      const catalogueCounts = new Map();
      for (const s of (catalogue && Array.isArray(catalogue.seasons) ? catalogue.seasons : [])) {
        if (s && Number.isInteger(s.season_number)) catalogueCounts.set(s.season_number, Number(s.episode_count) || 0);
      }

      // Seasons the share holds
      let seasonItems = [];
      if (native) {
        const page = await jellyfin.get(`/Shows/${encodeURIComponent(item.Id)}/Seasons`);
        seasonItems = (page && Array.isArray(page.Items) ? page.Items : []).filter((s) => s && typeof s.Id === 'string' && Number.isInteger(s.IndexNumber));
      }

      const seasonNumbers = Array.from(owned.keys()).filter((s) => s >= 1 || (s === 0 && options.includeSpecials)).sort((a, b) => a - b);
      for (const seasonNumber of seasonNumbers) {
        const have = owned.get(seasonNumber);
        let missing = null;
        let nativeEmpty = null;

        if (native) {
          const seasonItem = seasonItems.find((s) => s.IndexNumber === seasonNumber);
          if (seasonItem) {
            const rows = await jellyfin.get(`/Shows/${encodeURIComponent(item.Id)}/Episodes`, { SeasonId: seasonItem.Id, IsMissing: 'true' });
            const listed = nativeEpisodes(rows && rows.Items);
            missing = missingInSeason(listed, have, today, options.graceDays, { checkNumbering: false });
            if (listed.length === 0 && typeof tmdbText === 'string' && /^\d{1,10}$/.test(tmdbText)) nativeEmpty = seasonItem;
          }
        }

        // The catalogue as well where the media server said nothing but the season is short
        const expected = catalogueCounts.get(seasonNumber) || 0;
        if ((!missing || missing.length === 0) && tmdbUsable && catalogue && expected > have.size) {
          try {
            const season = await tmdb.getSeason(show.tmdbId, seasonNumber, ended);
            missing = missingInSeason(tmdbEpisodes(season), have, today, options.graceDays);
            if (missing === null) notes.push(`${name} season ${seasonNumber}: numbered differently from TMDB, left out.`);
          } catch (error) {
            tmdbFailed(error, `${name} season ${seasonNumber}`);
          }
        }

        if (missing && missing.length > 0) {
          show.seasons.push({ season: seasonNumber, whole: false, missing });
        } else if (nativeEmpty) {
          askAgain.push({ show, seriesId: item.Id, seasonItem: nativeEmpty, seasonNumber, have });
        }
      }

      // Seasons the share does not hold at all
      if (tmdbUsable && catalogue) {
        const wanted = wholeSeasonsToReport(Array.from(catalogueCounts.keys()).filter((n) => catalogueCounts.get(n) > 0), owned, options);
        for (const seasonNumber of wanted) {
          try {
            const season = await tmdb.getSeason(show.tmdbId, seasonNumber, ended);
            const missing = missingInSeason(tmdbEpisodes(season), new Set(), today, options.graceDays);
            if (missing && missing.length > 0) show.seasons.push({ season: seasonNumber, whole: true, missing });
          } catch (error) {
            tmdbFailed(error, `${name} season ${seasonNumber}`);
            if (!tmdbUsable) break;
          }
        }
      } else if (tmdb && !show.tmdbId) {
        show.partial = 'not identified on TMDB: whole missing seasons were not checked';
      }

      // The media server lists missing episodes only for a show its own catalogue matched (the
      // match is what fills ProviderIds.Tmdb; MediaServerManager season lookup needs it). With
      // its metadata off, or no key there, every show is unmatched and the lists are empty: say
      // so instead of reporting the show as complete.
      const serverIdentified = typeof tmdbText === 'string' && /^\d{1,10}$/.test(tmdbText);
      if (native && !serverIdentified && !catalogue) {
        show.partial = 'not identified by the media server\'s metadata (TMDB): its missing episodes could not be listed';
        unidentified++;
      }

      show.seasons.sort((a, b) => a.season - b.season);
    } catch (error) {
      // The media server going away or refusing us ends the check; anything else costs one show
      if (!error.fromTmdb && (error.status === 401 || error.status === 0)) throw error;
      show.skipped = `could not be read: ${errorText(error)}`;
      log(`${name}: ${errorText(error)}`);
    }
  }

  if (askAgain.length > 0) {
    await sleep(Number.isFinite(options.recheckDelayMs) ? Math.max(0, options.recheckDelayMs) : 0);
    for (const one of askAgain) {
      try {
        const rows = await jellyfin.get(`/Shows/${encodeURIComponent(one.seriesId)}/Episodes`, { SeasonId: one.seasonItem.Id, IsMissing: 'true' });
        const missing = missingInSeason(nativeEpisodes(rows && rows.Items), one.have, today, options.graceDays, { checkNumbering: false });
        if (missing && missing.length > 0) {
          one.show.seasons.push({ season: one.seasonNumber, whole: false, missing });
          one.show.seasons.sort((a, b) => a.season - b.season);
        }
      } catch (error) {
        if (error.status === 401 || error.status === 0) throw error;
        log(`${one.show.name}: ${errorText(error)}`);
      }
    }
  }

  if (unidentified > 0) {
    const tail = 'Switch on the media server\'s metadata (TMDB) with a key in its settings, or set a TMDB key in this extension.';
    notes.push(unidentified === shows.filter((s) => !s.skipped).length
      ? `None of your shows is identified by the media server's metadata (TMDB), so it lists no missing episodes. ${tail}`
      : `${unidentified} show(s) are not identified by the media server's metadata (TMDB): their missing episodes could not be listed. ${tail}`);
  }

  const sources = [ native ? 'the media server\'s own missing-episode lists' : null, tmdb ? 'TMDB' : null ].filter(Boolean);
  return { at: now, checkedShows: shows.length, shows, notes, native, unidentified, sourceNote: sources.join(' and ') };
};

// A name search answer is trusted only when exactly one show has this very title (and, when the
// library knows a year, a first air date within a year of it)
const identify = async (tmdb, name, year, keys) => {
  if (!name) return null;
  let answer;
  try {
    answer = await tmdb.searchShow(name.replace(/\(\s*(19|20)\d\d\s*\)/, '').trim(), Number.isInteger(year) ? year : 0);
  } catch (error) {
    if (error.status === 401) throw error;
    return null;
  }

  const results = answer && Array.isArray(answer.results) ? answer.results : [];
  let same = results.filter((r) => r && Number.isInteger(r.id)
    && [ ...titleKeys(r.name), ...titleKeys(r.original_name) ].some((k) => keys.has(k)));
  if (Number.isInteger(year) && year > 0) {
    same = same.filter((r) => {
      const first = Number(String(r.first_air_date || '').slice(0, 4));
      return !first || Math.abs(first - year) <= 1;
    });
  }

  return same.length === 1 ? String(same[0].id) : null;
};

module.exports = { runCheck, identify };
