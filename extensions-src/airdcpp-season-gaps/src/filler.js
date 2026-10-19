'use strict';

// Searching the hubs for missing episodes, one at a time, inside a global budget.
//
// Web API routes (airdcpp-webapi at origin/master f163a4989):
// - POST search                                   create an instance (SearchApi.cpp:63, :197)
// - POST search/{id}/hub_search                   search the online hubs (SearchEntity.cpp:47)
// - GET  search/{id}/results/0/200                results (SearchEntity.cpp:50)
// - POST search/{id}/results/{result}/download    queue one; no target = the client's download
//                                                 directory (SearchEntity.cpp:52, Deserializer.cpp:153)
// - DELETE search/{id}                            drop the instance (SearchApi.cpp:222)
// - GET  queue/bundles/0/100000                   is the episode already queued (QueueApi.cpp:85)

const { canSearch, prune } = require('./budget');
const { pickBest, matchesWanted, buildQuery, episodeCode } = require('./release');

const RESULT_WAIT_MS = 15 * 1000;
const MAX_QUEUE_WAIT_MS = 2 * 60 * 1000;
const MAX_PENDING = 500;
const MAX_TRIES = 3;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_ATTEMPTS_KEPT = 5000;

const errorText = (error) => (error && (error.message || error.code)) || String(error);

const sleepReal = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  if (timer && typeof timer.unref === 'function') timer.unref();
});

const createFiller = ({ socket, getValues, store, now = () => Date.now(), sleep = sleepReal, onEvent = () => {} }) => {
  let busy = false;

  const state = () => store.get();
  const keyOf = (seriesId, season, episode) => `${seriesId}|${episodeCode(season, episode)}`;

  const forgetOldAttempts = () => {
    const attempts = state().attempts;
    const keys = Object.keys(attempts);
    if (keys.length <= MAX_ATTEMPTS_KEPT) return;
    keys.sort((a, b) => attempts[a].at - attempts[b].at);
    for (const key of keys.slice(0, keys.length - MAX_ATTEMPTS_KEPT)) delete attempts[key];
  };

  // items: [{ seriesId, show, keys, season, episode }]. A manual fill searches again even for an
  // episode tried recently; the automatic one waits retry_days.
  const enqueue = (items, { manual = false, max = MAX_PENDING } = {}) => {
    const s = state();
    const retryMs = getValues().retry_days * DAY_MS;
    let added = 0;
    for (const item of items) {
      const key = keyOf(item.seriesId, item.season, item.episode);
      if (s.pending.some((p) => p.key === key)) continue;
      const attempt = s.attempts[key];
      if (!manual && attempt && now() - attempt.at < retryMs) continue;
      if (s.pending.length >= MAX_PENDING || added >= max) break;
      s.pending.push({
        key, seriesId: item.seriesId, show: item.show, keys: item.keys, years: Array.isArray(item.years) ? item.years : [], season: item.season, episode: item.episode, tries: 0,
      });
      added++;
    }

    if (added > 0) store.save();
    return added;
  };

  const clear = () => {
    const count = state().pending.length;
    state().pending = [];
    store.save();
    return count;
  };

  const record = (key, outcome, extra = {}) => {
    state().attempts[key] = { at: now(), outcome, ...extra };
    forgetOldAttempts();
  };

  const hasId = (id) => id !== undefined && id !== null && id !== '';
  const backoffMs = (failures) => Math.min(24, 2 ** Math.max(0, failures - 1)) * HOUR_MS;

  // A folder result becomes a directory download, and a queue bundle only once the source's file
  // list has arrived (SearchEntity.cpp:154-157). Until then the bundle check cannot see it.
  const folderDownloadPending = async (attempt) => {
    if (!attempt || !hasId(attempt.directoryDownloadId)) return false;
    let downloads;
    try {
      // GET filelists/directory_downloads (FilelistApi.cpp:64): [{ id, state: pending|queued|failed }]
      downloads = await socket.get('filelists/directory_downloads');
    } catch (error) {
      return false;
    }

    return (Array.isArray(downloads) ? downloads : [])
      .some((d) => d && String(d.id) === String(attempt.directoryDownloadId) && d.state === 'pending');
  };

  // filelist_directory_download_failed (FilelistApi.cpp:275-285): the source's file list never
  // came, so nothing was queued. The episode is looked for again after 1 h, 2 h, 4 h ... 24 h
  // instead of retry_days. Returns how many episodes it concerned.
  const onDirectoryDownloadFailed = (data) => {
    const id = data && data.directory_download && data.directory_download.id;
    if (!hasId(id)) return 0;
    const attempts = state().attempts;
    const retryMs = getValues().retry_days * DAY_MS;
    let count = 0;
    for (const [ key, attempt ] of Object.entries(attempts)) {
      if (!attempt || String(attempt.directoryDownloadId) !== String(id)) continue;
      const failures = (Number(attempt.failures) || 0) + 1;
      // enqueue() waits retry_days after "at": this places the next try one backoff from now
      attempts[key] = { at: now() - retryMs + backoffMs(failures), outcome: 'could not be queued (the source\'s file list did not arrive)', failures };
      count++;
    }

    if (count > 0) store.save();
    return count;
  };

  const processOne = async (item) => {
    const values = getValues();
    // An item saved by an older version has no years: a release with a year then has to match a name exactly
    const wanted = { keys: new Set(item.keys), years: new Set(Array.isArray(item.years) ? item.years : []), season: item.season, episode: item.episode };
    const label = `${item.show} ${episodeCode(item.season, item.episode)}`;

    const bundles = await socket.get('queue/bundles/0/100000');
    if ((Array.isArray(bundles) ? bundles : []).some((b) => b && matchesWanted(b.name, wanted))) {
      record(item.key, 'already in the download queue');
      store.save();
      return;
    }

    if (await folderDownloadPending(state().attempts[item.key])) {
      socket.logger.info(`${label}: a folder download for it is still waiting for the source's file list`);
      return;
    }

    // Counted BEFORE it is sent: a kill right after the search must not hand out a fresh one
    state().searches.push(now());
    store.save();

    const instance = await socket.post('search', { expiration: 10, owner_suffix: 'season-gaps' });
    try {
      const pattern = buildQuery(item.show, item.season, item.episode, values.quality);
      let queued;
      try {
        queued = await socket.post(`search/${instance.id}/hub_search`, { query: { pattern, file_type: 'any' } });
      } catch (error) {
        // No hub online, or the client's own search queue is full: try again later, a few times
        item.tries = (item.tries || 0) + 1;
        if (item.tries < MAX_TRIES) {
          state().pending.push(item);
        } else {
          record(item.key, `search failed: ${errorText(error)}`);
        }

        store.save();
        socket.logger.info(`${label}: the search could not be sent (${errorText(error)})`);
        return;
      }

      const queueTime = queued && Number.isFinite(queued.queue_time) ? Math.min(Math.max(queued.queue_time, 0), MAX_QUEUE_WAIT_MS) : 0;
      await sleep(queueTime + RESULT_WAIT_MS);

      const results = await socket.get(`search/${instance.id}/results/0/200`);
      const best = pickBest(results, wanted, {
        quality: values.quality, groups: values.preferred_groups, requireGroup: values.require_preferred_group, acceptedTags: values.accepted_tags,
      });

      if (!best) {
        record(item.key, `no exact match among ${Array.isArray(results) ? results.length : 0} result(s)`);
        store.save();
        socket.logger.info(`${label}: no result matched the show and episode exactly`);
        return;
      }

      // A file answers its bundle; a folder a directory download (SearchEntity.cpp:154-163)
      const answer = await socket.post(`search/${instance.id}/results/${best.result.id}/download`, {});
      const bundleId = answer && answer.bundle_info && hasId(answer.bundle_info.id) ? answer.bundle_info.id : undefined;
      const download = answer && Array.isArray(answer.directory_download_ids) ? answer.directory_download_ids[0] : undefined;
      const directoryDownloadId = download && typeof download === 'object' ? download.id : download;
      const ids = {
        ...(hasId(bundleId) ? { bundleId } : {}),
        ...(hasId(directoryDownloadId) ? { directoryDownloadId } : {}),
      };

      // A double episode fills its partner too
      const outcome = `queued ${best.result.name}`;
      for (let n = best.parsed.episode; n <= best.parsed.episodeEnd; n++) {
        const key = keyOf(item.seriesId, item.season, n);
        record(key, outcome, ids);
        state().pending = state().pending.filter((p) => p.key !== key);
      }

      store.save();
      onEvent(`queued ${label}: ${best.result.name}`);
    } finally {
      socket.delete(`search/${instance.id}`).catch(() => {});
    }
  };

  // Runs at most one search; called every few seconds by a timer
  const tick = async () => {
    const s = state();
    if (busy || s.pending.length === 0) return false;

    const values = getValues();
    s.searches = prune(s.searches, now());
    const verdict = canSearch(s.searches, now(), values.searches_per_hour, values.search_spacing_seconds * 1000);
    if (!verdict.ok) return false;

    busy = true;
    const item = s.pending.shift();
    store.save();
    try {
      await processOne(item);
    } catch (error) {
      record(item.key, `failed: ${errorText(error)}`);
      store.save();
      socket.logger.error(`Filling ${item.show} ${episodeCode(item.season, item.episode)} failed: ${errorText(error)}`);
    } finally {
      busy = false;
    }

    return true;
  };

  return { enqueue, clear, tick, keyOf, onDirectoryDownloadFailed, isBusy: () => busy };
};

module.exports = { createFiller, RESULT_WAIT_MS };
