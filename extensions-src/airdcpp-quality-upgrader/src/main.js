'use strict';

// Finds better copies of the films and episodes already kept, under a global search budget, and
// (only when switched on) replaces them: download to a staging folder, put the new copy beside
// the old one, move the old copy to a holding folder. Listeners and polling only, never a hook.
//
// Web API routes (airdcpp-windows origin/master, airdcpp-webapi/api/...):
//   GET share_roots (ShareRootApi.cpp:41), GET media_server (MediaServerApi.cpp:33/85-95),
//   POST search (SearchApi.cpp:63), POST search/{id}/hub_search (SearchEntity.cpp:47),
//   GET search/{id}/results/{start}/{count} (SearchEntity.cpp:50),
//   POST search/{id}/results/{result}/download (SearchEntity.cpp:52),
//   DELETE search/{id} (SearchApi.cpp:222), listener search/search_result_added at module level
//   = every instance (SearchEntity.cpp:35/237),
//   GET queue/bundles/{start}/{count} (QueueApi.cpp:85), GET queue/bundles/{id} (:98),
//   POST queue/bundles/{id}/remove (:99), listeners queue_bundle_status / queue_bundle_removed,
//   POST hash/rename_path (HashApi.cpp:57), POST share/refresh/paths (ShareApi.cpp:94),
//   POST events (EventApi.cpp:43), listeners hub_text_command (HubInfo.cpp:38) and
//   private_chat_text_command (PrivateChatInfo.cpp:36).

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const SettingsManager = require('airdcpp-extension-settings');

const { SettingDefinitions } = require('./settings');
const { parseRelease, identityKey, searchPatternOf } = require('./release');
const { profileOf, judge, bestUpgrade } = require('./quality');
const { walkShare, fetchLibrary, buildInventory, replaceableReason, isInside, isStrictlyInside, normalizeDir, fileNameOfItem } = require('./inventory');
const { budgetAllows, pruneSearches, pickNext } = require('./scheduler');
const { createJellyfin, baseUrlFromStatus } = require('./jellyfin');
const { moveInto, exists, listFiles, PARTIAL_SUFFIX } = require('./mover');
const { buildReport, chatList } = require('./report');

const CONFIG_VERSION = 1;
const STATE_FILE = 'state.json';
const REPORT_FILE = 'upgrades.md';
const VERSION = '1.0.0-beta.1';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TICK_MS = 15 * 1000;
const COLLECT_MS = 30 * 1000;            // how long results are collected after the search went out
const FIRST_INVENTORY_DELAY_MS = 60 * 1000;
const INVENTORY_EVERY_MS = 12 * HOUR;
const SETTLE_MS = 30 * 1000;             // after a bundle completes, before it is moved
const QUEUED_EXPIRY_MS = 14 * DAY;
const LIBRARY_WAIT_MS = 2 * HOUR;        // waiting for the library to show the new copy
const WATCHED_WAIT_MS = DAY;
const IN_USE_GIVE_UP_MS = DAY;
const BACKOFF_MINUTES = [ 1, 2, 5, 10, 30, 60 ];
const RETRY_CODES = [ 'EBUSY', 'EPERM', 'EACCES' ];
const MAX_FOUND = 2000;
const MAX_FOUND_EVENTS_PER_HOUR = 20;
const VIDEO = /\.(mkv|mp4|avi|m4v|ts|wmv|mov|mpg|mpeg|m2ts|webm)$/i;
const HELP = '/upgrade list | /upgrade status: quality upgrades found for your films and episodes (airdcpp-quality-upgrader)';
const ACTIVE = [ 'queued', 'downloaded', 'placed' ];

const backoffMs = (attempts) => BACKOFF_MINUTES[Math.min(Math.max(attempts, 1) - 1, BACKOFF_MINUTES.length - 1)] * MINUTE;

const defaultState = () => ({ version: 1, deviceId: crypto.randomBytes(12).toString('hex'), token: null, items: {}, searches: [], found: {}, jobs: {}, held: [] });

module.exports = function (socket, extension, deps = {}) {
  const now = deps.now || (() => Date.now());
  const moveImpl = deps.moveImpl || moveInto;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t.unref) t.unref();
  }));

  const settings = SettingsManager(socket, {
    extensionName: extension.name,
    configFile: extension.configPath + 'config.json',
    configVersion: CONFIG_VERSION,
    definitions: SettingDefinitions,
  });

  const configDir = extension.configPath || '.';
  const statePath = () => path.join(configDir, STATE_FILE);
  const reportPath = () => path.join(configDir, REPORT_FILE);

  let state = defaultState();
  let inventory = new Map();
  let mode = 'share';
  let shareRoots = [];
  let searching = false;
  let inventoryRunning = false;
  let lastInventoryAt = 0;
  let lastPurgeAt = 0;
  let chain = Promise.resolve();
  let jellyfin = null;
  let reportTimer = null;
  let stopped = false;
  const timers = [];
  const ownSearchIds = new Set();
  const settleTimers = new Map();
  const foundEvents = [];

  // Logging: messages built here never hold a token, a password or a header
  const errorText = (error) => {
    if (!error) return 'unknown error';
    if (error.status !== undefined && /^media server:/.test(error.message || '')) return error.message;
    if (error.code && typeof error.code === 'string') return error.code;
    if (typeof error.code === 'number') return `${error.code} ${String(error.message || '').slice(0, 120)}`;
    return String(error.message || error).slice(0, 160);
  };

  const logEvent = (text, severity = 'info') => {
    socket.logger.info(text);
    socket.post('events', { text: `${extension.name}: ${text}`, severity })
      .catch((error) => socket.logger.error(`Could not post an event message: ${errorText(error)}`));
  };

  const value = (key) => settings.getValue(key);

  // ---- state on disk -----------------------------------------------------------------------

  const loadState = () => {
    try {
      const data = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
      state = { ...defaultState(), ...(data && typeof data === 'object' ? data : {}) };
      for (const k of [ 'items', 'found', 'jobs' ]) {
        if (!state[k] || typeof state[k] !== 'object' || Array.isArray(state[k])) state[k] = {};
      }

      for (const k of [ 'searches', 'held' ]) {
        if (!Array.isArray(state[k])) state[k] = [];
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        socket.logger.error(`Could not read ${STATE_FILE}: ${errorText(error)}; starting over`);
        try {
          fs.renameSync(statePath(), `${statePath()}.bad-${Date.now()}`);
        } catch (e) {
          // nothing to keep
        }
      }

      state = defaultState();
      saveState();
    }
  };

  const saveState = () => {
    try {
      const tmp = `${statePath()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, statePath());
    } catch (error) {
      socket.logger.error(`Could not save ${STATE_FILE}: ${errorText(error)}`);
    }

    scheduleReport();
  };

  const writeReport = () => {
    try {
      const text = buildReport({ found: state.found, jobs: state.jobs, now: now(), stats: { inventory: inventory.size, mode, searchesLastHour: state.searches.filter((t) => t > now() - HOUR).length } });
      const tmp = `${reportPath()}.tmp`;
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, reportPath());
    } catch (error) {
      socket.logger.error(`Could not write ${REPORT_FILE}: ${errorText(error)}`);
    }
  };

  const scheduleReport = () => {
    if (reportTimer || stopped) return;
    reportTimer = setTimeout(() => {
      reportTimer = null;
      writeReport();
    }, 2000);
    if (reportTimer.unref) reportTimer.unref();
  };

  // ---- the media server --------------------------------------------------------------------

  const hasLogin = () => Boolean(value('media_token') || value('media_username'));

  const makeJellyfin = () => createJellyfin({
    getBaseUrl: async () => baseUrlFromStatus(await socket.get('media_server')),
    getCredentials: async () => ({ username: value('media_username'), password: value('media_password'), token: value('media_token') }),
    loadToken: async () => state.token,
    saveToken: async (token) => {
      state.token = token;
      saveState();
    },
    fetchImpl: deps.fetchImpl,
    device: { client: extension.name, deviceId: state.deviceId, version: VERSION },
  });

  // ---- inventory ---------------------------------------------------------------------------

  const excludedDirs = () => [ value('staging_directory'), value('holding_directory') ].filter(Boolean);

  const refreshInventory = async () => {
    if (inventoryRunning) return;
    inventoryRunning = true;
    try {
      const roots = await socket.get('share_roots');
      shareRoots = (Array.isArray(roots) ? roots : []).map((r) => r.path).filter(Boolean);
      const { releases, truncated, looseVideos } = await walkShare(shareRoots, { exclude: excludedDirs(), fsImpl: deps.fsImpl });
      if (truncated) {
        socket.logger.info('The share is very large: only part of it was looked at');
      }

      let libraryItems = null;
      if (hasLogin() && jellyfin) {
        try {
          libraryItems = await fetchLibrary(jellyfin);
        } catch (error) {
          logEvent(`could not read the media library (${errorText(error)}); checking the share folders instead`, 'warning');
        }
      }

      mode = libraryItems ? 'library' : 'share';
      inventory = buildInventory({ releases, libraryItems, looseVideos });
      lastInventoryAt = now();

      // Forget rotation records of things that are gone
      for (const key of Object.keys(state.items)) {
        if (!inventory.has(key)) delete state.items[key];
      }

      saveState();
      socket.logger.info(`Inventory: ${inventory.size} title(s) from ${mode === 'library' ? 'the media library' : 'the share'}`);
    } catch (error) {
      socket.logger.error(`Inventory failed: ${errorText(error)}`);
    } finally {
      inventoryRunning = false;
    }
  };

  // ---- found upgrades ----------------------------------------------------------------------

  const foundId = (key, name) => `${key}|${String(name).toLowerCase()}`;

  const recordFound = (key, entry, candidate, { passive }) => {
    const id = foundId(key, candidate.parsed.name);
    const existing = state.found[id];
    if (existing) {
      existing.seen = now();
      return { record: existing, isNew: false };
    }

    const record = {
      id, key, at: now(), seen: now(), current: entry.best.name, currentPath: entry.best.path || null,
      candidate: candidate.parsed.name, reason: candidate.reason, passive: Boolean(passive), status: 'found', jobId: null, note: null,
    };
    state.found[id] = record;

    // Bounded: the oldest finished or report-only records go first
    const ids = Object.keys(state.found);
    if (ids.length > MAX_FOUND) {
      ids.filter((i) => !state.found[i].jobId || !ACTIVE.includes((state.jobs[state.found[i].jobId] || {}).state))
        .sort((a, b) => state.found[a].at - state.found[b].at)
        .slice(0, ids.length - MAX_FOUND)
        .forEach((i) => delete state.found[i]);
    }

    const recent = foundEvents.filter((t) => t > now() - HOUR);
    foundEvents.length = 0;
    foundEvents.push(...recent);
    if (foundEvents.length < MAX_FOUND_EVENTS_PER_HOUR) {
      foundEvents.push(now());
      logEvent(`upgrade found for ${entry.best.name}: ${candidate.parsed.name} (${candidate.reason})`);
    }

    return { record, isNew: true };
  };

  // ---- automatic replacing: start --------------------------------------------------------

  const activeJobs = () => Object.values(state.jobs).filter((j) => ACTIVE.includes(j.state));

  // Why an upgrade cannot be queued automatically now, or null
  const autoQueueBlocker = async (key, entry, candidate) => {
    const staging = value('staging_directory');
    const holding = value('holding_directory');
    if (!staging || !holding) return 'no staging or holding folder is set';
    if (!path.isAbsolute(staging) || !path.isAbsolute(holding)) return 'the staging and holding folders must be full paths';
    if (isInside(staging, holding) || isInside(holding, staging)) return 'the staging and holding folders overlap';
    if (shareRoots.some((root) => isInside(holding, root))) return 'the holding folder is inside the share';
    if (shareRoots.some((root) => isInside(root, staging) || isInside(root, holding))) return 'a share folder is inside the staging or holding folder';
    const blocked = replaceableReason(entry, shareRoots);
    if (blocked) return blocked;
    if (isInside(entry.best.path, staging) || isInside(entry.best.path, holding)) return 'the copy is inside the staging or holding folder';
    if (activeJobs().some((j) => j.key === key)) return 'an upgrade for it is already under way';
    if (activeJobs().length >= value('max_active_upgrades')) return 'enough upgrades are under way already';
    const name = candidate.parsed.name;
    if (/[\\/]/.test(name) || /[. ]$/.test(name) || name === '..' || name === '.') return 'the release name cannot be a folder name';
    if (await exists(path.join(staging, name))) return `${name} is already in the staging folder`;
    if (await exists(path.join(path.dirname(entry.best.path), name))) return `${name} already exists beside the old copy`;
    return null;
  };

  const startJob = async (key, entry, candidate, searchId, record) => {
    const blocker = await autoQueueBlocker(key, entry, candidate);
    if (blocker) {
      record.note = `not replaced automatically: ${blocker}`;
      return;
    }

    const staging = value('staging_directory');
    const id = crypto.randomBytes(6).toString('hex');
    const old = entry.best;
    // On disk BEFORE the download is queued: a kill right after the POST must not leave a
    // download in the staging folder that no job knows about
    state.jobs[id] = {
      id, key, state: 'queued', created: now(), updated: now(),
      oldPath: old.path, oldName: path.basename(old.path), parentDir: path.dirname(old.path),
      newName: candidate.parsed.name, stagingPath: path.join(staging, candidate.parsed.name),
      holdingDir: value('holding_directory'), bundleId: null, completedAt: null,
      oldJellyfinId: old.jellyfinId || null, watched: old.userData || null, newJellyfinId: null,
      attempts: 0, nextAt: 0, since: null, placedAt: null, heldAt: null, heldName: null, heldPath: null, note: null,
    };
    record.jobId = id;
    record.status = 'queued';
    saveState();

    try {
      await socket.post(`search/${searchId}/results/${candidate.id}/download`, {
        target_directory: staging.replace(/[\\/]*$/, path.sep),
        target_name: candidate.parsed.name,
      });
    } catch (error) {
      delete state.jobs[id];
      record.jobId = null;
      record.status = 'found';
      record.note = `could not queue it (${errorText(error)})`;
      saveState();
      return;
    }

    logEvent(`downloading ${candidate.parsed.name} to the staging folder to replace ${old.name}`);
  };

  // ---- searching ---------------------------------------------------------------------------

  const resultCandidates = (results) => (Array.isArray(results) ? results : [])
    .filter((r) => r && r.type && r.type.id === 'directory' && typeof r.name === 'string')
    // Already shared, queued or downloaded before: nothing to gain
    .filter((r) => !(r.dupe && r.dupe.id && /^(share|queue|finished)_/.test(r.dupe.id)))
    .map((r) => ({ id: r.id, hits: r.hits, parsed: parseRelease(r.name) }))
    .filter((c) => c.parsed);

  const nothingToGain = (entry, profile) => {
    const best = entry.best.parsed;
    return !profile.takeProper && !profile.codecUpgrade && (!profile.upgradeResolution || (best.resolution || 0) >= profile.maxResolution);
  };

  const searchOnce = async () => {
    if (searching || stopped || inventory.size === 0) return false;
    const t = now();
    state.searches = pruneSearches(state.searches, t);
    const verdict = budgetAllows(state.searches, t, { perHour: value('searches_per_hour'), spacingMs: value('search_spacing_seconds') * 1000 });
    if (!verdict.allowed) return false;

    const profile = profileOf(currentValues());
    const key = pickNext([ ...inventory.keys() ], state.items, t, {
      recheckMs: value('recheck_days') * DAY,
      skip: (k) => activeJobs().some((j) => j.key === k) || nothingToGain(inventory.get(k), profile),
    });
    if (!key) return false;

    const entry = inventory.get(key);
    const pattern = searchPatternOf(entry.best.parsed);
    searching = true;
    state.searches.push(t);
    state.items[key] = { lastChecked: t, priority: 0 };
    saveState();

    let searchId = null;
    try {
      const instance = await socket.post('search', { expiration: 10, owner_suffix: 'quality-upgrader' });
      searchId = instance.id;
      ownSearchIds.add(searchId);
      const queued = await socket.post(`search/${searchId}/hub_search`, { query: { pattern, file_type: 'directory' } });
      if (!queued || !queued.queued_count) {
        socket.logger.verbose(`No hub to search "${pattern}" on`);
        return true;
      }

      await sleep(Math.min(Number(queued.queue_time) || 0, 5 * MINUTE) + COLLECT_MS);
      if (stopped) return true;
      const results = await socket.get(`search/${searchId}/results/0/200`);
      const best = bestUpgrade({ ...entry.best.parsed }, resultCandidates(results), profile);
      state.items[key].lastResult = best ? best.parsed.name : null;
      if (best) {
        const { record, isNew } = recordFound(key, entry, best, { passive: false });
        if (value('auto_queue') && (isNew || !record.jobId)) {
          await startJob(key, entry, best, searchId, record);
        }
      }

      saveState();
      return true;
    } catch (error) {
      socket.logger.error(`Search for "${pattern}" failed: ${errorText(error)}`);
      return true;
    } finally {
      searching = false;
      if (searchId !== null) {
        socket.delete(`search/${searchId}`).catch(() => {});
        // Late results of our own instance are not "other searches"
        const forget = setTimeout(() => ownSearchIds.delete(searchId), 15 * MINUTE);
        if (forget.unref) forget.unref();
      }
    }
  };

  const currentValues = () => SettingDefinitions.reduce((r, d) => ({ ...r, [d.key]: value(d.key) }), {});

  // Results of searches somebody else started in this client: looked at, never acted on directly.
  // An item seen with a better copy is searched for next, by the budgeted search.
  const onSearchResult = (data, instanceId) => {
    try {
      if (!value('watch_other_searches') || ownSearchIds.has(instanceId) || !data || !data.result) return;
      const [ candidate ] = resultCandidates([ data.result ]);
      if (!candidate) return;
      const key = identityKey(candidate.parsed);
      const entry = key ? inventory.get(key) : null;
      if (!entry) return;
      const verdict = judge(entry.best.parsed, candidate.parsed, profileOf(currentValues()));
      if (!verdict.upgrade) return;
      recordFound(key, entry, { ...candidate, reason: verdict.reason }, { passive: true });
      state.items[key] = { ...(state.items[key] || {}), priority: now() };
      saveState();
    } catch (error) {
      socket.logger.error(`search_result_added handler failed: ${errorText(error)}`);
    }
  };

  // ---- automatic replacing: finishing ------------------------------------------------------

  const renameHashes = async (files) => {
    let renamed = 0;
    for (const file of files || []) {
      try {
        await socket.post('hash/rename_path', { old_path: file.from, new_path: file.to });
        renamed++;
      } catch (error) {
        socket.logger.verbose(`No hash entry moved for ${file.from}: ${errorText(error)}`);
      }
    }

    return renamed;
  };

  const refreshShare = async (directory) => {
    try {
      await socket.post('share/refresh/paths', { paths: [ directory.replace(/[\\/]*$/, path.sep) ] });
    } catch (error) {
      socket.logger.verbose(`No share refresh for ${directory}: ${errorText(error)}`);
    }
  };

  const finish = (job, jobState, note, severity = 'info') => {
    job.state = jobState;
    job.note = note || job.note;
    job.updated = now();
    const record = Object.values(state.found).find((f) => f.jobId === job.id);
    if (record) record.status = jobState;
    saveState();
    if (note) {
      logEvent(`${job.newName}: ${note}`, severity);
    }
  };

  const retryLater = (job, error, deadlineFrom, giveUpNote) => {
    job.attempts++;
    if (!job.since) job.since = now();
    if (now() - (deadlineFrom || job.since) > IN_USE_GIVE_UP_MS) {
      finish(job, 'failed', `${giveUpNote} (${errorText(error)})`, 'error');
      return;
    }

    job.nextAt = now() + backoffMs(job.attempts);
    if (job.attempts === 1) {
      logEvent(`${job.newName}: ${errorText(error)}; trying again later`, 'warning');
    }

    saveState();
  };

  const videoFilesOf = async (p) => {
    try {
      const stat = await fsp.stat(p);
      if (stat.isFile()) return [ path.basename(p).toLowerCase() ];
      return (await fsp.readdir(p)).filter((n) => VIDEO.test(n) && !/(^|[._ -])sample([._ -]|$)/i.test(n)).map((n) => n.toLowerCase());
    } catch (error) {
      return [];
    }
  };

  // The library item of the new copy, by file name (the library hides real paths)
  const findLibraryItem = async (job) => {
    const names = new Set(await videoFilesOf(path.join(job.parentDir, job.newName)));
    if (names.size === 0) return null;
    const items = await fetchLibrary(jellyfin);
    const match = items.filter((i) => names.has(fileNameOfItem(i)));
    return match.length === 1 ? match[0].Id : null;
  };

  const useLibrary = () => hasLogin() && jellyfin;

  // Whether two trees hold the same files (relative paths and sizes)
  const sameFiles = async (a, b) => {
    try {
      const strip = (list) => new Map(list.files.map((f) => [ f.rel.split(path.sep).slice(1).join(path.sep).toLowerCase(), f.size ]));
      const [ x, y ] = [ strip(await listFiles(a)), strip(await listFiles(b)) ];
      return x.size > 0 && x.size === y.size && [ ...x ].every(([ rel, size ]) => y.get(rel) === size);
    } catch (error) {
      return false;
    }
  };

  const stepDownloaded = async (job) => {
    const dest = path.join(job.parentDir, job.newName);
    const stagingThere = await exists(job.stagingPath);
    if (!stagingThere && await exists(dest)) {
      // Cut short after the move, before it was written down
      job.state = 'placed';
      job.placedAt = job.placedAt || now();
      saveState();
      return true;
    }

    if (!stagingThere) {
      finish(job, 'failed', 'the download is no longer in the staging folder; nothing was changed', 'error');
      return false;
    }

    if (await exists(dest)) {
      // Cut short after a cross-drive copy reached its final name, before the staging original
      // was deleted: the destination holds exactly the staging files. Carry on; delete nothing.
      if (job.moveStarted && await sameFiles(job.stagingPath, dest)) {
        job.state = 'placed';
        job.placedAt = job.placedAt || now();
        job.note = `a leftover copy remains in the staging folder: ${job.stagingPath}`;
        saveState();
        return true;
      }

      finish(job, 'failed', `${dest} already exists; the download stays in the staging folder`, 'error');
      return false;
    }

    if (!await exists(job.oldPath)) {
      finish(job, 'failed', `the old copy ${job.oldPath} is gone; the download stays in the staging folder`, 'warning');
      return false;
    }

    // Watched state as it is now, before the old copy leaves the library
    if (useLibrary() && job.oldJellyfinId && !job.watchedChecked) {
      try {
        const data = await jellyfin.get(`/UserItems/${encodeURIComponent(job.oldJellyfinId)}/UserData`);
        const played = Boolean(data && data.Played);
        const position = Number(data && data.PlaybackPositionTicks) || 0;
        job.watched = played || position > 0 ? { Played: played, PlaybackPositionTicks: played ? 0 : position } : null;
        job.watchedChecked = true;
      } catch (error) {
        socket.logger.verbose(`Could not read the watched state of ${job.oldName}: ${errorText(error)}`);
      }
    }

    // Out of the queue first: a finished bundle whose files are gone fails to load later
    if (job.bundleId !== null && job.bundleId !== undefined && !job.bundleRemoved) {
      try {
        await socket.post(`queue/bundles/${job.bundleId}/remove`, { remove_finished: false });
      } catch (error) {
        if (error.code !== 404) {
          retryLater(job, error, null, 'could not take the download out of the queue; it stays in the staging folder');
          return false;
        }
      }

      job.bundleRemoved = true;
      saveState();
    }

    job.moveStarted = true;
    saveState();
    let result;
    try {
      result = await moveImpl(job.stagingPath, job.parentDir);
    } catch (error) {
      if (RETRY_CODES.includes(error.code)) {
        retryLater(job, error, null, 'the download could not be moved; it stays in the staging folder');
      } else {
        finish(job, 'failed', `could not move the download beside the old copy (${errorText(error)}); it stays in the staging folder`, 'error');
      }

      return false;
    }

    job.state = 'placed';
    job.placedAt = now();
    job.attempts = 0;
    job.since = null;
    job.nextAt = 0;
    if (result.leftovers && result.leftovers.length > 0) {
      job.note = `a leftover copy remains in the staging folder: ${job.stagingPath}`;
    }

    saveState();
    await renameHashes(result.files);
    await refreshShare(job.parentDir);
    logEvent(`put ${job.newName} in ${job.parentDir}`);
    return true;
  };

  const uniqueHeldName = async (holdingDir, name) => {
    if (!await exists(path.join(holdingDir, name))) return name;
    for (let i = 1; i < 1000; i++) {
      const candidate = `${name}.${i}`;
      if (!await exists(path.join(holdingDir, candidate))) return candidate;
    }

    throw Object.assign(new Error('no free name in the holding folder'), { code: 'EEXIST' });
  };

  const stepPlaced = async (job) => {
    // Wait for the library to list the new copy while the old one is still there: the media
    // server then moves every user's watched state to it by itself (PlaybackStateStore::adopt,
    // MediaServerManager.cpp:807 on origin/master) when the new copy is the larger one
    if (useLibrary() && !job.newJellyfinId && now() - job.placedAt < LIBRARY_WAIT_MS) {
      try {
        job.newJellyfinId = await findLibraryItem(job);
      } catch (error) {
        socket.logger.verbose(`Library lookup failed: ${errorText(error)}`);
      }

      if (!job.newJellyfinId) {
        job.nextAt = now() + 5 * MINUTE;
        saveState();
        return false;
      }
    }

    if (!job.heldName) {
      if (!await exists(job.oldPath)) {
        finish(job, 'done', 'the old copy was already gone');
        return false;
      }

      try {
        job.heldName = await uniqueHeldName(job.holdingDir, job.oldName);
      } catch (error) {
        finish(job, 'failed', `no room in the holding folder (${errorText(error)}); the old copy stays beside the new one`, 'error');
        return false;
      }

      saveState();
    }

    const heldPath = path.join(job.holdingDir, job.heldName);
    if (!await exists(job.oldPath) && await exists(heldPath)) {
      // Cut short after the move, before it was written down
      job.heldPath = heldPath;
    } else {
      // Never move the old copy away while the new one is not there (deleted or moved meanwhile)
      if (!await exists(path.join(job.parentDir, job.newName))) {
        finish(job, 'failed', 'the new copy is no longer beside the old one; the old copy stays where it is', 'error');
        return false;
      }

      let result;
      try {
        result = await moveImpl(job.oldPath, job.holdingDir, { targetName: job.heldName });
      } catch (error) {
        if (RETRY_CODES.includes(error.code)) {
          retryLater(job, error, null, 'the old copy could not be moved to the holding folder; both copies are kept');
        } else {
          finish(job, 'failed', `could not move the old copy to the holding folder (${errorText(error)}); both copies are kept`, 'error');
        }

        return false;
      }

      job.heldPath = result.target;
      await renameHashes(result.files);
    }

    job.state = 'held';
    job.heldAt = now();
    job.attempts = 0;
    job.since = null;
    job.nextAt = 0;
    state.held.push({ path: job.heldPath, at: now(), holdingDir: job.holdingDir });
    saveState();
    await refreshShare(job.parentDir);
    logEvent(`replaced ${job.oldName} with ${job.newName}; the old copy is in ${job.heldPath}`);
    return true;
  };

  const stepHeld = async (job) => {
    if (!job.watched || !useLibrary()) {
      finish(job, 'done', null);
      return false;
    }

    if (now() - job.heldAt > WATCHED_WAIT_MS) {
      finish(job, 'done', 'the watched state could not be carried over (the library never listed the new copy)', 'warning');
      return false;
    }

    try {
      if (!job.newJellyfinId) {
        job.newJellyfinId = await findLibraryItem(job);
      }

      if (!job.newJellyfinId) {
        job.nextAt = now() + 10 * MINUTE;
        saveState();
        return false;
      }

      // JellyfinApi.cpp:17971-18035 (origin/master): GET/POST /UserItems/{id}/UserData, the
      // POST reads Played and PlaybackPositionTicks
      const target = `/UserItems/${encodeURIComponent(job.newJellyfinId)}/UserData`;
      const there = await jellyfin.get(target);
      if (there && (there.Played || Number(there.PlaybackPositionTicks) > 0)) {
        finish(job, 'done', null);
        return false;
      }

      await jellyfin.post(target, { Played: job.watched.Played, PlaybackPositionTicks: job.watched.PlaybackPositionTicks });
      finish(job, 'done', null);
      socket.logger.info(`Watched state carried over to ${job.newName}`);
    } catch (error) {
      job.nextAt = now() + 10 * MINUTE;
      socket.logger.verbose(`Watched state not carried yet: ${errorText(error)}`);
      saveState();
    }

    return false;
  };

  const processJob = async (id) => {
    const job = state.jobs[id];
    if (!job || job.nextAt > now()) return;
    let more = true;
    while (more && !stopped) {
      // "Replace automatically" switched off: nothing more is moved until it is on again
      if ((job.state === 'downloaded' || job.state === 'placed') && !value('auto_queue')) break;
      if (job.state === 'downloaded') more = await stepDownloaded(job);
      else if (job.state === 'placed') more = await stepPlaced(job);
      else if (job.state === 'held') more = await stepHeld(job);
      else more = false;
    }
  };

  const enqueue = (job) => {
    chain = chain.then(job).catch((error) => socket.logger.error(`Upgrade step failed: ${errorText(error)}`));
    return chain;
  };

  const jobForBundle = (bundle) => {
    if (!bundle || !bundle.target) return null;
    const target = normalizeDir(bundle.target);
    return Object.values(state.jobs).find((j) => j.state === 'queued' && normalizeDir(j.stagingPath) === target) || null;
  };

  // The bundle completed; `removed` = it is no longer in the queue (nothing to take out)
  const markDownloaded = (job, bundleId, removed) => {
    job.state = 'downloaded';
    job.bundleId = bundleId;
    if (removed) job.bundleRemoved = true;
    job.updated = now();
    saveState();
  };

  const onBundleCompleted = (bundle) => {
    const job = jobForBundle(bundle);
    if (!job || settleTimers.has(job.id) || stopped) return;
    // Written at once: a completed bundle can leave the queue without any event (the core's
    // "Remove finished bundles on exit", QueueManager.cpp:100), and the download must not be
    // stranded in the staging folder then
    if (!job.completedAt) {
      job.completedAt = now();
      job.bundleId = bundle.id;
      saveState();
    }

    settleTimers.set(job.id, setTimeout(() => {
      settleTimers.delete(job.id);
      enqueue(async () => {
        let current;
        try {
          current = await socket.get(`queue/bundles/${bundle.id}`);
        } catch (error) {
          if (error && error.code === 404 && job.state === 'queued') {
            // Removed after it completed: still complete in the staging folder
            markDownloaded(job, bundle.id, true);
            await processJob(job.id);
          }

          return;
        }

        if (!current.status || !current.status.completed || job.state !== 'queued') return;
        markDownloaded(job, bundle.id, false);
        await processJob(job.id);
      });
    }, deps.settleMs !== undefined ? deps.settleMs : SETTLE_MS));
    const timer = settleTimers.get(job.id);
    if (timer.unref) timer.unref();
  };

  const onBundleStatus = (bundle) => {
    try {
      if (bundle && bundle.status && bundle.status.completed) onBundleCompleted(bundle);
    } catch (error) {
      socket.logger.error(`queue_bundle_status handler failed: ${errorText(error)}`);
    }
  };

  const onBundleRemoved = (bundle) => {
    try {
      const job = jobForBundle(bundle);
      if (!job) return;
      if ((bundle.status && bundle.status.completed) || job.completedAt) {
        // "Remove completed" in the queue: the files stay, the replacement carries on
        markDownloaded(job, bundle.id, true);
        enqueue(() => processJob(job.id));
        return;
      }

      finish(job, 'cancelled', 'the download was removed from the queue; nothing was changed');
    } catch (error) {
      socket.logger.error(`queue_bundle_removed handler failed: ${errorText(error)}`);
    }
  };

  // At start: downloads that finished while the extension was not running, and completed ones
  // that left the queue meanwhile
  const reconcileQueue = async () => {
    let bundles;
    try {
      bundles = await socket.get('queue/bundles/0/100000');
    } catch (error) {
      socket.logger.error(`Could not read the queue: ${errorText(error)}`);
      return;
    }

    const list = Array.isArray(bundles) ? bundles : [];
    list.filter((b) => b.status && b.status.completed).forEach(onBundleCompleted);
    const targets = new Set(list.filter((b) => b && b.target).map((b) => normalizeDir(b.target)));
    for (const job of Object.values(state.jobs)) {
      if (job.state === 'queued' && job.completedAt && !targets.has(normalizeDir(job.stagingPath))) {
        markDownloaded(job, job.bundleId, true);
      }
    }
  };

  const processDue = () => enqueue(async () => {
    for (const job of Object.values(state.jobs)) {
      if (job.state === 'queued' && now() - job.created > QUEUED_EXPIRY_MS) {
        finish(job, 'expired', 'the download did not finish in two weeks; it was left in the queue', 'warning');
      } else if ([ 'downloaded', 'placed', 'held' ].includes(job.state) && job.nextAt <= now()) {
        await processJob(job.id);
      }
    }
  });

  // A move cut short by a stop or a crash leaves "<name>.upgrader-partial" while the original is
  // still complete: remove the partial copy, the retry starts over
  const cleanPartials = async () => {
    for (const job of Object.values(state.jobs)) {
      const pairs = [];
      if (job.state === 'downloaded') pairs.push([ path.join(job.parentDir, job.newName) + PARTIAL_SUFFIX, job.stagingPath ]);
      if (job.state === 'placed' && job.heldName) pairs.push([ path.join(job.holdingDir, job.heldName) + PARTIAL_SUFFIX, job.oldPath ]);
      for (const [ partial, source ] of pairs) {
        if (await exists(partial) && await exists(source)) {
          await fsp.rm(partial, { recursive: true, force: true }).catch((error) => socket.logger.error(`Could not remove ${partial}: ${errorText(error)}`));
        }
      }
    }
  };

  // Off by default. Only what this extension put in the holding folder, only inside it.
  const purgeHolding = async () => {
    const days = value('holding_purge_days');
    if (!days || days <= 0) return;
    const keep = [];
    for (const held of state.held) {
      if (now() - held.at < days * DAY) {
        keep.push(held);
        continue;
      }

      if (!held.holdingDir || !isStrictlyInside(held.path, held.holdingDir)) {
        continue; // not ours to delete; forget it
      }

      try {
        await fsp.rm(held.path, { recursive: true, force: true });
        logEvent(`deleted the replaced copy ${held.path} (older than ${days} days)`);
      } catch (error) {
        keep.push(held);
        socket.logger.error(`Could not delete ${held.path}: ${errorText(error)}`);
      }
    }

    state.held = keep;
    saveState();
  };

  // ---- the periodic tick -------------------------------------------------------------------

  const tick = async () => {
    if (stopped) return;
    if (!inventoryRunning && now() - lastInventoryAt > INVENTORY_EVERY_MS) {
      await refreshInventory();
    }

    processDue();
    if (now() - lastPurgeAt > HOUR) {
      lastPurgeAt = now();
      await purgeHolding();
    }

    await searchOnce();
  };

  // ---- chat --------------------------------------------------------------------------------

  const reply = async (base, sessionId, lines, owner) => {
    for (const line of lines) {
      // Local status lines only; prefixed all the same
      await socket.post(`${base}/${sessionId}/status_message`, { text: `[upgrade] ${line}`, severity: 'info', ...(owner ? { owner } : {}) });
    }
  };

  const statusLines = () => {
    const searches = state.searches.filter((t) => t > now() - HOUR).length;
    const active = activeJobs().length;
    return [
      `${inventory.size} title(s) from ${mode === 'library' ? 'the media library' : 'the share'}; ${Object.keys(state.found).length} upgrade(s) found; ${active} being replaced.`,
      `${searches} of ${value('searches_per_hour')} searches used this hour. Automatic replacing is ${value('auto_queue') ? 'ON' : 'off (report only)'}.`,
      `Report: ${reportPath()}`,
    ];
  };

  const onTextCommand = (base) => async (data, sessionId) => {
    try {
      if (!data || !data.command) return;
      const command = String(data.command).toLowerCase();
      if (command === 'help') {
        await reply(base, sessionId, [ HELP ], data.owner);
        return;
      }

      if (command !== 'upgrade') return;
      const sub = String((data.args || [])[0] || 'list').toLowerCase();
      if (sub === 'status') {
        await reply(base, sessionId, statusLines(), data.owner);
      } else if (sub === 'list') {
        writeReport();
        await reply(base, sessionId, [ ...chatList({ found: state.found, jobs: state.jobs }), `Full report: ${reportPath()}` ], data.owner);
      } else {
        await reply(base, sessionId, [ HELP ], data.owner);
      }
    } catch (error) {
      socket.logger.error(`Chat command failed: ${errorText(error)}`);
    }
  };

  // ---- start / stop ------------------------------------------------------------------------

  extension.onStart = async () => {
    // The state first, and the handler only after load(): load() ends by calling onValuesUpdated
    // with EVERY value, and the handler saves the state, so a handler set before load() wrote the
    // empty default state over state.json on every start (live test 2026-10-19: jobs, finds and
    // the search budget were lost on each restart)
    loadState();
    await settings.load();
    settings.onValuesUpdated = (values) => {
      const updated = values || {};
      if ('media_username' in updated || 'media_password' in updated || 'media_token' in updated) {
        state.token = null;
        saveState();
        if (jellyfin) jellyfin.forget();
        lastInventoryAt = 0;
      }

      if ('staging_directory' in updated || 'holding_directory' in updated) {
        lastInventoryAt = 0;
      }
    };

    jellyfin = makeJellyfin();
    await cleanPartials();

    const listen = (module, event, handler) => socket.addListener(module, event, handler)
      .catch((error) => socket.logger.error(`Could not listen to ${event}: ${errorText(error)}`));

    await listen('queue', 'queue_bundle_status', onBundleStatus);
    await listen('queue', 'queue_bundle_removed', onBundleRemoved);
    await listen('search', 'search_result_added', onSearchResult);
    await listen('hubs', 'hub_text_command', onTextCommand('hubs'));
    await listen('private_chat', 'private_chat_text_command', onTextCommand('private_chat'));

    await reconcileQueue();

    // The share needs a moment after a start; the first inventory waits
    lastInventoryAt = now() - INVENTORY_EVERY_MS + FIRST_INVENTORY_DELAY_MS;
    processDue();
    const timer = setInterval(() => {
      tick().catch((error) => socket.logger.error(`Tick failed: ${errorText(error)}`));
    }, TICK_MS);
    if (timer.unref) timer.unref();
    timers.push(timer);
  };

  extension.onStop = () => {
    stopped = true;
    timers.forEach(clearInterval);
    for (const t of settleTimers.values()) clearTimeout(t);
    settleTimers.clear();
    if (reportTimer) clearTimeout(reportTimer);
  };

  // For the tests
  return {
    refreshInventory, searchOnce, onSearchResult, onBundleStatus, onBundleRemoved, processDue, processJob, reconcileQueue,
    cleanPartials, purgeHolding, onTextCommand, writeReport, loadState, saveState,
    getState: () => state, getInventory: () => inventory, getMode: () => mode, idle: () => chain,
    setJellyfin: (j) => { jellyfin = j; },
    init: async () => {
      await settings.load();
      loadState();
      jellyfin = jellyfin || makeJellyfin();
    },
  };
};
