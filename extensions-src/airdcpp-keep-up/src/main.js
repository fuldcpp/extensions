'use strict';

// Keeps the next episodes of the shows being watched downloaded.
//
// Every N minutes: what the followed account watched within D days (the media server's own
// Jellyfin API, over loopback), the next K episodes of each of those shows (TMDB, or the server's
// own "missing" rows without a key), and for each one that has aired and is neither in the library
// nor in the queue: one hub search for exactly that episode, within an hourly budget. Only a
// result whose release name is that show and exactly that SxxEyy is ever taken; nothing else is a
// fallback. Polling and listeners only, never a hook.
//
// State (sign-in, search budget, per-episode retries, what was queued) is written to disk as it
// changes: on Windows the client ends extensions with TerminateProcess and onStop never runs.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SettingsManager = require('airdcpp-extension-settings');

const { SettingDefinitions } = require('./settings');
const { createJellyfin } = require('./jellyfin');
const { createTmdb } = require('./tmdb');
const release = require('./release');
const plan = require('./plan');

const CONFIG_VERSION = 1;
const STATE_FILE = 'keep-up-state.json';
const CACHE_FILE = 'tmdb-cache.json';
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;   // let the hubs connect first
const SEARCH_SPACING_MS = 20 * 1000;        // the peer ignores searches closer than ~15 s
const RESULT_WAIT_MS = 30 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const RECORD_RETENTION_MS = 90 * plan.DAY_MS;
const SIZE_RETRY_MS = HOUR_MS;
const EXISTS_RETRY_MS = 24 * HOUR_MS;
const DRY_RUN_RETRY_MS = 24 * HOUR_MS;
const MAX_PLAYED_ITEMS = 500;
const GB = 1024 * 1024 * 1024;
const HELP = '/keepup status | /keepup run: next-episode downloads for the shows being watched (airdcpp-keep-up)';

const errorText = (error) => (error && (error.message || error.code)) || String(error);
const formatGb = (bytes) => `${(bytes / GB).toFixed(1)} GB`;

module.exports = function (socket, extension, deps = {}) {
  const {
    fetchImpl = (...args) => fetch(...args),
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }),
    resultWaitMs = RESULT_WAIT_MS,
    searchSpacingMs = SEARCH_SPACING_MS,
  } = deps;

  const settings = SettingsManager(socket, {
    extensionName: extension.name,
    configFile: extension.configPath + 'config.json',
    configVersion: CONFIG_VERSION,
    definitions: SettingDefinitions,
  });

  const dir = () => extension.configPath || '.';
  const statePath = () => path.join(dir(), STATE_FILE);
  const cachePath = () => path.join(dir(), CACHE_FILE);

  let state = null;
  let running = null;
  let intervalTimer = null;
  let firstTimer = null;
  let stopped = false;
  let version = '1.0.0';
  try {
    version = require('../package.json').version || version;
  } catch (error) {
    // bundled without it
  }

  // ---- persistence (tmp + rename, written as it changes) ----

  const emptyState = () => ({ version: 1, deviceId: crypto.randomBytes(12).toString('hex'), token: null, searches: [], lastSearchAt: 0, episodes: {}, lastRun: null });

  const readJson = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        socket.logger.error(`Could not read ${path.basename(file)} (${error.code || 'not JSON'}); starting it afresh`);
      }

      return null;
    }
  };

  const writeJson = (file, data) => {
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
      fs.renameSync(tmp, file);
    } catch (error) {
      socket.logger.error(`Could not save ${path.basename(file)} (${error.code || errorText(error)})`);
    }
  };

  const loadState = () => {
    const loaded = readJson(statePath());
    state = { ...emptyState(), ...(loaded && typeof loaded === 'object' ? loaded : {}) };
    if (!state.episodes || typeof state.episodes !== 'object') state.episodes = {};
    if (!Array.isArray(state.searches)) state.searches = [];
    if (!loaded || !loaded.deviceId) saveState();
  };

  const saveState = () => writeJson(statePath(), state);

  // ---- events ----

  const logEvent = (text, severity = 'info') => {
    socket.logger.info(text);
    socket.post('events', { text: `${extension.name}: ${text}`, severity })
      .catch((error) => socket.logger.error(`Could not post an event message: ${errorText(error)}`));
  };

  // ---- the media server ----

  const normalizeLocal = (address) => {
    try {
      const url = new URL(address);
      if ([ '0.0.0.0', '[::]', '::', '' ].includes(url.hostname)) {
        url.hostname = '127.0.0.1';
      }

      return url.origin;
    } catch (error) {
      return '';
    }
  };

  // GET media_server (MediaServerApi.cpp:32, :88-99): {enabled, running, address, port}
  const getBaseUrl = async () => {
    const configured = String(settings.getValue('media_server_url') || '').trim();
    if (configured) {
      return normalizeLocal(configured);
    }

    const status = await socket.get('media_server');
    if (!status || !status.running) {
      throw new Error('the media server is not running');
    }

    return normalizeLocal(status.address || `http://127.0.0.1:${status.port}`);
  };

  const jellyfin = createJellyfin({
    getBaseUrl,
    getCredentials: () => ({
      username: settings.getValue('media_username'),
      password: settings.getValue('media_password'),
      token: settings.getValue('media_access_token'),
      deviceId: state ? state.deviceId : '',
      client: extension.name,
      version,
    }),
    loadToken: () => (state ? state.token : null),
    saveToken: (token) => {
      state.token = token;
      saveState();
    },
    fetchImpl,
    now,
  });

  const tmdb = createTmdb({
    getKey: () => settings.getValue('tmdb_api_key'),
    fetchImpl,
    loadCache: () => readJson(cachePath()),
    saveCache: (cache) => writeJson(cachePath(), cache),
    now,
  });

  const hasCredentials = () => Boolean(settings.getValue('media_access_token') || settings.getValue('media_username'));

  // The TV libraries (CollectionType "tvshows", JellyfinApi.cpp:4768-4769; route :16971)
  const tvLibraries = async (userId) => {
    const views = await jellyfin.get('/UserViews', { UserId: userId });
    const ids = ((views && views.Items) || []).filter((v) => v && v.CollectionType === 'tvshows' && v.Id).map((v) => v.Id);
    return ids.length > 0 ? ids : [ '' ];
  };

  // Episodes played, most recent first. Every played-state route answers for the TOKEN's user
  // (JellyfinApi.cpp:14077-14083); the id in the path is not who is asked about (:18056).
  // Recursive / IncludeItemTypes / Filters=IsPlayed / SortBy=DatePlayed: browse :7360, :7033, :7321.
  const playedEpisodes = async (userId) => {
    const items = [];
    for (const parentId of await tvLibraries(userId)) {
      const page = await jellyfin.get(`/Users/${encodeURIComponent(userId)}/Items`, {
        ParentId: parentId || undefined,
        Recursive: 'true',
        IncludeItemTypes: 'Episode',
        Filters: 'IsPlayed',
        SortBy: 'DatePlayed',
        SortOrder: 'Descending',
        Limit: MAX_PLAYED_ITEMS,
        Fields: 'UserData',
      });
      items.push(...((page && page.Items) || []));
    }

    return items;
  };

  // Every held episode of a show, with its played state (/Shows/{id}/Episodes, :16560-16612)
  const showEpisodes = async (userId, seriesId) => {
    const page = await jellyfin.get(`/Shows/${encodeURIComponent(seriesId)}/Episodes`, { UserId: userId, Limit: 1000 });
    return (page && page.Items) || [];
  };

  // ---- the hubs ----

  const pruneSearches = () => {
    const since = now() - HOUR_MS;
    state.searches = state.searches.filter((t) => t > since && t <= now() + HOUR_MS);
  };

  const budgetLeft = () => {
    pruneSearches();
    return Math.max(0, settings.getValue('searches_per_hour') - state.searches.length);
  };

  const removeInstance = (id) => socket.delete(`search/${id}`)
    .catch((error) => socket.logger.verbose(`Could not remove search instance ${id}: ${errorText(error)}`));

  // One hub search; resolves to { results, instanceId } or throws (nothing was sent then)
  const hubSearch = async (pattern) => {
    const wait = (state.lastSearchAt || 0) + searchSpacingMs - now();
    if (wait > 0) {
      await sleep(wait);
    }

    // SearchApi.cpp:63 + :197 (expiration in minutes, owner_suffix)
    const instance = await socket.post('search', { expiration: 10, owner_suffix: 'keep-up' });
    try {
      // SearchEntity.cpp:47 + FileSearchParser.cpp:32 ({query: {pattern}}, priority LOW by default)
      await socket.post(`search/${instance.id}/hub_search`, { query: { pattern } });
      state.lastSearchAt = now();
      state.searches.push(now());
      saveState();
      await sleep(resultWaitMs);
      // SearchEntity.cpp:50 (grouped results: name, size, type, dupe, users.count, slots.free)
      const results = await socket.get(`search/${instance.id}/results/0/200`);
      return { results: Array.isArray(results) ? results : [], instanceId: instance.id };
    } catch (error) {
      await removeInstance(instance.id);
      throw error;
    }
  };

  // ---- one check ----

  const recordOf = (key) => state.episodes[key];
  const setRecord = (key, data) => {
    state.episodes[key] = { ...(state.episodes[key] || {}), ...data, updatedAt: now() };
    saveState();
  };

  const pruneRecords = () => {
    const limit = now() - RECORD_RETENTION_MS;
    for (const [ key, record ] of Object.entries(state.episodes)) {
      if (!record || !(record.updatedAt > limit)) delete state.episodes[key];
    }
  };

  const hasId = (id) => id !== undefined && id !== null && id !== '';

  // The downloads this extension started that are still waiting in the queue: [{ name, size }].
  // Tracked by the bundle id the download answered (or its directory download's, until the
  // source's file list has arrived and made it a bundle); by name only for what has no id, and
  // then the id is remembered, so a bundle renamed in the queue still counts.
  //   bundles: GET queue/bundles (QueueBundleUtils.cpp: id, name, size, status.completed)
  //   directoryDownloads: GET filelists/directory_downloads (FilelistApi.cpp:64; id, state)
  const activeBundles = (bundles, directoryDownloads) => {
    const byId = new Map();
    const byName = new Map();
    for (const bundle of bundles) {
      if (bundle && hasId(bundle.id) && !(bundle.status && bundle.status.completed)) {
        byId.set(String(bundle.id), bundle);
        if (bundle.name) byName.set(bundle.name, bundle);
      }
    }

    const pending = new Set((directoryDownloads || [])
      .filter((d) => d && hasId(d.id) && d.state === 'pending')
      .map((d) => String(d.id)));

    const active = [];
    const counted = new Set();
    let changed = false;
    for (const record of Object.values(state.episodes)) {
      if (!record || record.status !== 'queued') continue;
      if (!hasId(record.bundleId) && hasId(record.directoryDownloadId) && pending.has(String(record.directoryDownloadId))) {
        active.push({ name: record.bundleName, size: Number(record.size) || 0 });
        continue;
      }

      let bundle = hasId(record.bundleId) ? byId.get(String(record.bundleId)) : undefined;
      if (!hasId(record.bundleId) && record.bundleName) {
        bundle = byName.get(record.bundleName);
        if (bundle) {
          record.bundleId = bundle.id;
          changed = true;
        }
      }

      if (!bundle || counted.has(String(bundle.id))) continue;
      counted.add(String(bundle.id));
      active.push({ name: bundle.name, size: Number(bundle.size) || Number(record.size) || 0 });
    }

    if (changed) saveState();
    return active;
  };

  const queueState = async () => {
    // QueueApi.cpp:85 (bundles: id, name, size, status)
    const bundles = await socket.get('queue/bundles/0/100000');
    let directoryDownloads = [];
    try {
      directoryDownloads = await socket.get('filelists/directory_downloads');
    } catch (error) {
      socket.logger.verbose(`Could not list the directory downloads: ${errorText(error)}`);
    }

    const list = Array.isArray(bundles) ? bundles : [];
    return { bundles: list, active: activeBundles(list, Array.isArray(directoryDownloads) ? directoryDownloads : []) };
  };

  const recordOfDirectoryDownload = (id) => (hasId(id)
    ? Object.entries(state.episodes).find(([ , r ]) => r && r.status === 'queued' && !hasId(r.bundleId) && String(r.directoryDownloadId) === String(id))
    : undefined);

  // filelist_directory_download_processed (FilelistApi.cpp:264-273): the bundle it became
  const onDirectoryDownloadProcessed = (data) => {
    try {
      const download = data && data.directory_download;
      const found = recordOfDirectoryDownload(download && download.id);
      const bundleId = data && data.result && data.result.bundle && data.result.bundle.id;
      if (found && hasId(bundleId)) {
        setRecord(found[0], { bundleId });
      }
    } catch (error) {
      socket.logger.error(`Directory download update failed: ${errorText(error)}`);
    }
  };

  // filelist_directory_download_failed (FilelistApi.cpp:275-285; DirectoryListingManager.cpp:474):
  // the source's file list never came, so nothing was queued. Not the user's answer, so it is
  // looked for again after a backoff.
  const onDirectoryDownloadFailed = (data) => {
    try {
      const download = data && data.directory_download;
      const found = recordOfDirectoryDownload(download && download.id);
      if (!found) return;
      const [ key, record ] = found;
      const attempts = (record.attempts || 0) + 1;
      setRecord(key, { status: 'download_failed', attempts, nextAt: now() + plan.backoffMs(attempts), directoryDownloadId: null });
      logEvent(`${record.bundleName} for ${record.label} could not be queued (the source's file list did not arrive); it is looked for again later`, 'warning');
    } catch (error) {
      socket.logger.error(`Directory download update failed: ${errorText(error)}`);
    }
  };

  const downloadDirectory = async () => {
    const own = String(settings.getValue('download_directory') || '').trim();
    if (own) return own;
    try {
      const values = await socket.post('settings/get', { keys: [ 'download_directory' ] });
      return (values && values.download_directory) || '';
    } catch (error) {
      return '';
    }
  };

  // What one show needs: [{ key, show, identity, season, episode }]
  const wantedFor = async (userId, show, bundles, unknown = null) => {
    const episodes = await showEpisodes(userId, show.seriesId);
    const furthest = plan.furthestPlayed(episodes);
    if (!furthest) return [];
    const held = plan.heldEpisodes(episodes);
    const count = settings.getValue('episodes_ahead');

    // The series item: name, year, TMDB id where the catalogue gave one (addMetadata
    // JellyfinApi.cpp:5331, single item :11660)
    let series = null;
    try {
      series = await jellyfin.get(`/Users/${encodeURIComponent(userId)}/Items/${encodeURIComponent(show.seriesId)}`);
    } catch (error) {
      socket.logger.verbose(`${show.seriesName}: no series details (${errorText(error)})`);
    }

    const seriesName = (series && series.Name) || show.seriesName;
    const localYear = series && Number.isInteger(series.ProductionYear) ? series.ProductionYear : null;
    const names = [ seriesName, show.seriesName ];
    let tmdbYear = null;
    let next = [];

    if (String(settings.getValue('tmdb_api_key') || '').trim()) {
      const known = series && series.ProviderIds && Number(series.ProviderIds.Tmdb);
      const tmdbId = known || await tmdb.findShow(seriesName, localYear);
      if (!tmdbId) {
        socket.logger.verbose(`${seriesName}: not found on TMDB by its exact name`);
        return [];
      }

      const answer = await tmdb.episodesAfter(tmdbId, furthest.season, furthest.episode, count);
      if (answer.numberingDiffers) {
        socket.logger.info(`${seriesName}: the library numbers its episodes differently from TMDB (no ${release.episodeTag(furthest.season, furthest.episode)} there); left alone`);
        return [];
      }

      names.push(answer.info.name, answer.info.originalName);
      tmdbYear = answer.info.year || null;
      next = answer.episodes;
    } else {
      // The server's own missing rows, in the held seasons from the furthest one on (withMissingEpisodes :1304-1425)
      const seasonIds = new Map();
      for (const e of episodes) {
        if (e.SeasonId && Number(e.ParentIndexNumber) >= furthest.season) seasonIds.set(e.SeasonId, Number(e.ParentIndexNumber));
      }

      const rows = [];
      for (const seasonId of Array.from(seasonIds.keys()).sort((a, b) => seasonIds.get(a) - seasonIds.get(b))) {
        const page = await jellyfin.get(`/Shows/${encodeURIComponent(show.seriesId)}/Episodes`, { SeasonId: seasonId, UserId: userId });
        rows.push(...((page && page.Items) || []));
      }

      next = plan.nextFromMissingRows(rows, furthest, count);
      // The server lists missing rows only for a show its own metadata identified (that match is
      // what fills ProviderIds.Tmdb). Unidentified, "nothing missing" means "unknown": say so.
      const identified = series && series.ProviderIds && Number(series.ProviderIds.Tmdb);
      if (!identified && !rows.some((r) => r && r.LocationType === 'Virtual') && unknown) {
        unknown.push(seriesName);
        socket.logger.info(`${seriesName}: no TMDB key here and the media server's metadata has not identified the show; its next episodes are unknown`);
      }
    }

    const identity = release.showIdentity(names, localYear, tmdbYear);
    // Searched by the first name that leaves words to search for (a TMDB English name, say)
    const searchName = names.find((n) => release.normalizeTitle(release.splitTitleYear(n || '').title)) || '';
    return plan.wantedEpisodes(next, held, now())
      .filter((e) => !bundles.some((b) => release.bundleCovers(b.name, identity, e.season, e.episode)))
      .map((e) => ({
        key: `${show.seriesId}:${release.episodeTag(e.season, e.episode)}`,
        label: `${seriesName} ${release.episodeTag(e.season, e.episode)}`,
        seriesName,
        searchName,
        identity,
        season: e.season,
        episode: e.episode,
      }));
  };

  const prefs = () => ({
    quality: String(settings.getValue('quality') || '').trim(),
    qualityRequired: settings.getValue('quality_required'),
    preferredGroups: settings.getValue('preferred_groups'),
    blockedGroups: settings.getValue('blocked_groups'),
    acceptedTags: settings.getValue('accepted_language_tags'),
    maxSizeBytes: settings.getValue('max_episode_size_gb') * GB,
  });

  // Search for one episode and queue (or, in dry run, name) the best result
  const fetchEpisode = async (wanted, active, targetDir) => {
    if (!wanted.searchName) {
      // A name with no Latin letters or digits would search for a bare SxxEyy: every show's
      setRecord(wanted.key, { label: wanted.label, status: 'unsearchable', nextAt: now() + plan.DAY_MS });
      socket.logger.info(`${wanted.label}: the show's name cannot be searched for as a release name`);
      return 'unsearchable';
    }

    const quality = prefs().qualityRequired ? prefs().quality : '';
    const pattern = release.searchPattern(wanted.searchName, wanted.season, wanted.episode, quality);
    const previous = recordOf(wanted.key) || {};
    const { results, instanceId } = await hubSearch(pattern);
    try {
      const ranked = release.rankResults(results, wanted.identity, wanted.season, wanted.episode, prefs());
      if (ranked.length === 0) {
        const attempts = (previous.attempts || 0) + 1;
        setRecord(wanted.key, { label: wanted.label, status: 'not_found', attempts, nextAt: now() + plan.backoffMs(attempts) });
        socket.logger.info(`${wanted.label}: no matching release among ${results.length} result(s); next try in ${Math.round(plan.backoffMs(attempts) / HOUR_MS)} h`);
        return 'not_found';
      }

      const best = ranked[0].result;
      const size = Number(best.size) || 0;
      const activeSize = active.reduce((sum, b) => sum + b.size, 0);
      if (activeSize + size > settings.getValue('max_total_size_gb') * GB) {
        setRecord(wanted.key, { label: wanted.label, status: 'waiting_size', nextAt: now() + SIZE_RETRY_MS });
        socket.logger.info(`${wanted.label}: ${best.name} (${formatGb(size)}) would pass the total size limit; waiting`);
        return 'size';
      }

      // Never into something that is already there (a folder of the user's own included)
      if (targetDir && fs.existsSync(path.join(targetDir, best.name))) {
        setRecord(wanted.key, { label: wanted.label, status: 'exists', nextAt: now() + EXISTS_RETRY_MS });
        logEvent(`not queuing ${best.name}: ${path.join(targetDir, best.name)} already exists`, 'warning');
        return 'exists';
      }

      if (settings.getValue('dry_run')) {
        setRecord(wanted.key, { label: wanted.label, status: 'dry_run', nextAt: now() + DRY_RUN_RETRY_MS, bundleName: best.name, size });
        // Counted as the real run would count it, so the dry run keeps to the same caps
        active.push({ name: best.name, size });
        logEvent(`dry run: would queue ${best.name} (${formatGb(size)}) for ${wanted.label}`);
        return 'dry_run';
      }

      // SearchEntity.cpp:52 (+ Deserializer::deserializeDownloadParams: target_directory, target_name, priority)
      const body = { target_name: best.name };
      if (String(settings.getValue('download_directory') || '').trim()) {
        body.target_directory = settings.getValue('download_directory');
      }

      // A file answers its bundle's id; a directory a directory download, which becomes a bundle
      // once the source's file list has arrived (SearchEntity.cpp:153-163)
      const answer = await socket.post(`search/${instanceId}/results/${best.id}/download`, body);
      const bundleId = answer && answer.bundle_info && hasId(answer.bundle_info.id) ? answer.bundle_info.id : null;
      const download = answer && Array.isArray(answer.directory_download_ids) ? answer.directory_download_ids[0] : undefined;
      const directoryDownloadId = download && typeof download === 'object' ? download.id : download;
      setRecord(wanted.key, {
        label: wanted.label, status: 'queued', bundleName: best.name, size, queuedAt: now(), nextAt: 0,
        bundleId, directoryDownloadId: hasId(directoryDownloadId) ? directoryDownloadId : null,
      });
      active.push({ name: best.name, size });
      logEvent(`queued ${best.name} (${formatGb(size)}) for ${wanted.label}`);
      return 'queued';
    } finally {
      await removeInstance(instanceId);
    }
  };

  const check = async () => {
    const summary = { at: now(), shows: [], queued: 0, wouldQueue: 0, notFound: 0, skipped: '', unknown: [] };
    const finish = (skipped) => {
      summary.skipped = skipped || '';
      state.lastRun = summary;
      saveState();
      return summary;
    };

    if (!hasCredentials()) {
      return finish('no media-server account is set');
    }

    pruneRecords();
    const userId = await jellyfin.userId();
    const shows = plan.recentShows(await playedEpisodes(userId), now(), settings.getValue('recent_days'));
    summary.shows = shows.map((s) => s.seriesName);
    if (shows.length === 0) {
      return finish(`nothing watched in the last ${settings.getValue('recent_days')} day(s)`);
    }

    const { bundles, active } = await queueState();
    const targetDir = await downloadDirectory();

    for (const show of shows) {
      let wanted;
      try {
        wanted = await wantedFor(userId, show, bundles, summary.unknown);
      } catch (error) {
        socket.logger.error(`${show.seriesName}: could not work out the next episodes (${errorText(error)})`);
        if (error.status === 401 && /TMDB/.test(errorText(error))) {
          logEvent('TMDB refused the API key; check it in the extension settings', 'warning');
          return finish('TMDB refused the key');
        }

        continue;
      }

      for (const one of wanted) {
        if (stopped) return finish('stopped');
        const record = recordOf(one.key);
        // Queued once by this extension: never again (removing it from the queue is an answer)
        if (record && record.status === 'queued') continue;
        if (record && record.nextAt > now()) continue;

        if (active.length >= settings.getValue('max_active_bundles')) {
          return finish(settings.getValue('dry_run')
            ? `${active.length} download(s) would be in the queue (the cap)`
            : `${active.length} download(s) of this extension are already in the queue`);
        }

        if (budgetLeft() <= 0) {
          return finish('the hourly search budget is used up');
        }

        let outcome;
        try {
          outcome = await fetchEpisode(one, active, targetDir);
        } catch (error) {
          // Nothing reached the hubs (no hub online, search queue full): not this episode's fault
          socket.logger.error(`${one.label}: search failed (${errorText(error)})`);
          return finish(`a search failed (${errorText(error)})`);
        }

        if (outcome === 'queued') summary.queued++;
        if (outcome === 'dry_run') summary.wouldQueue++;
        if (outcome === 'not_found') summary.notFound++;
      }
    }

    return finish('');
  };

  const runOnce = () => {
    if (running) return running;
    running = check()
      .catch((error) => {
        const text = errorText(error);
        socket.logger.error(`Check failed: ${text}`);
        state.lastRun = { at: now(), shows: [], queued: 0, wouldQueue: 0, notFound: 0, skipped: `failed: ${text}` };
        saveState();
        return state.lastRun;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };

  // ---- chat commands ----

  const describeRun = (run) => {
    if (!run) return 'not checked yet';
    const when = new Date(run.at).toISOString().replace('T', ' ').slice(0, 16);
    const parts = [ `${run.queued} queued`, `${run.wouldQueue} would be queued (dry run)`, `${run.notFound} not found` ];
    const unknown = Array.isArray(run.unknown) && run.unknown.length
      ? `; next episodes unknown for: ${run.unknown.join(', ')} (no TMDB key, and the media server's metadata has not identified it)` : '';
    return `${when} UTC: ${parts.join(', ')}${run.skipped ? `; stopped early: ${run.skipped}` : ''}${unknown}`;
  };

  const statusLines = async () => {
    pruneSearches();
    let active = [];
    try {
      ({ active } = await queueState());
    } catch (error) {
      // the counts below then say 0
    }

    const waiting = Object.values(state.episodes)
      .filter((r) => r.status !== 'queued' && r.nextAt > now())
      .slice(0, 8)
      .map((r) => `${r.label} (${r.status.replace('_', ' ')}, again in ${Math.max(1, Math.round((r.nextAt - now()) / 60000))} min)`);

    const lines = [
      `[keep-up] dry run is ${settings.getValue('dry_run') ? 'ON (nothing is queued)' : 'off'}; ${running ? 'a check is running now' : `checks every ${settings.getValue('interval_minutes')} min`}`,
      `[keep-up] last check: ${describeRun(state.lastRun)}`,
      `[keep-up] following: ${state.lastRun && state.lastRun.shows.length ? state.lastRun.shows.join(', ') : 'no show'}`,
      `[keep-up] searches in the last hour: ${state.searches.length} of ${settings.getValue('searches_per_hour')}; its downloads in the queue: ${active.length} of ${settings.getValue('max_active_bundles')} (${formatGb(active.reduce((s, b) => s + b.size, 0))} of ${settings.getValue('max_total_size_gb')} GB)`,
    ];
    if (waiting.length > 0) {
      lines.push(`[keep-up] waiting: ${waiting.join('; ')}`);
    }

    return lines;
  };

  const reply = async (base, sessionId, lines, owner) => {
    for (const line of lines) {
      await socket.post(`${base}/${sessionId}/status_message`, { text: line, severity: 'info', ...(owner ? { owner } : {}) });
    }
  };

  const onTextCommand = (base) => async (data, sessionId) => {
    try {
      if (!data || !data.command) return;
      const command = String(data.command).toLowerCase();
      if (command === 'help') {
        await reply(base, sessionId, [ HELP ], data.owner);
        return;
      }

      if (command !== 'keepup') return;
      const sub = String((data.args || [])[0] || 'status').toLowerCase();
      if (sub === 'run') {
        const already = Boolean(running);
        runOnce().catch(() => {});
        await reply(base, sessionId, [ already ? '[keep-up] a check is already running' : '[keep-up] checking now; /keepup status shows the result' ], data.owner);
      } else if (sub === 'status') {
        await reply(base, sessionId, await statusLines(), data.owner);
      } else {
        await reply(base, sessionId, [ 'Usage: /keepup status | /keepup run' ], data.owner);
      }
    } catch (error) {
      socket.logger.error(`/keepup failed: ${errorText(error)}`);
    }
  };

  // ---- lifecycle ----

  const schedule = () => {
    clearInterval(intervalTimer);
    intervalTimer = setInterval(() => runOnce(), settings.getValue('interval_minutes') * 60 * 1000);
    if (intervalTimer && typeof intervalTimer.unref === 'function') intervalTimer.unref();
  };

  extension.onStart = async () => {
    settings.onValuesUpdated = (updated) => {
      // settings.load() ends with a call carrying EVERY value, before loadState() below: that is
      // the load, not a change (handled as one it would drop the stored sign-in at every start)
      if (!state) return;
      try {
        if ('interval_minutes' in updated) schedule();
        // Leaving dry run: what it only named is looked for again at the next check
        if (updated.dry_run === false) {
          for (const [ key, record ] of Object.entries(state.episodes)) {
            if (record.status === 'dry_run') delete state.episodes[key];
          }

          saveState();
        }

        // A changed account: the stored sign-in is someone else's
        if ('media_username' in updated || 'media_password' in updated || 'media_access_token' in updated) {
          state.token = null;
          saveState();
        }
      } catch (error) {
        socket.logger.error(`Settings update failed: ${errorText(error)}`);
      }
    };

    await settings.load();
    loadState();

    await socket.addListener('hubs', 'hub_text_command', onTextCommand('hubs'));
    await socket.addListener('private_chat', 'private_chat_text_command', onTextCommand('private_chat'));
    await socket.addListener('filelists', 'filelist_directory_download_processed', onDirectoryDownloadProcessed);
    await socket.addListener('filelists', 'filelist_directory_download_failed', onDirectoryDownloadFailed);

    if (!hasCredentials()) {
      logEvent('set a media-server user name and password (or an access token) in the extension settings to start', 'warning');
    }

    schedule();
    firstTimer = setTimeout(() => runOnce(), FIRST_RUN_DELAY_MS);
    if (firstTimer && typeof firstTimer.unref === 'function') firstTimer.unref();
  };

  extension.onStop = () => {
    stopped = true;
    clearInterval(intervalTimer);
    clearTimeout(firstTimer);
  };

  // For the tests
  return { runOnce, onTextCommand, getState: () => state, loadState };
};
