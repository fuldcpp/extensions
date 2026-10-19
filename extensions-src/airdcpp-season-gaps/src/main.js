'use strict';

// Finds the aired episodes missing from the series in the media library, reports them, and on
// request searches the hubs for exactly those episodes. Listeners and timers only; the single
// hook is the list of the extension's own menu items, which only ever adds an item.
//
// Web API routes used (airdcpp-webapi at origin/master f163a4989):
// - GET  media_server               {enabled, running, address, port} (MediaServerApi.cpp:33, :92-:98)
// - POST events                     event log line (EventApi.cpp:43)
// - hubs hub_text_command, private_chat private_chat_text_command (HubInfo.cpp:38,
//   PrivateChatInfo.cpp:36) and POST {hubs|private_chat}/{id}/status_message
//   (ChatController.h:40): /gaps answers locally, nothing is sent to a hub
// - menus extension_list_menuitems hook + extension_menuitem_selected (MenuApi.cpp:168)
// - the search and queue routes listed in filler.js

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SettingsManager = require('airdcpp-extension-settings');

const { SettingDefinitions } = require('./settings');
const { createJellyfin } = require('./jellyfin');
const { createTmdb } = require('./tmdb');
const { runCheck } = require('./checker');
const { createFiller } = require('./filler');
const report = require('./report');
const { version } = require('../package.json');

const CONFIG_VERSION = 1;
const STATE_FILE = 'state.json';
const RESULT_FILE = 'last-check.json';
const REPORT_FILE = 'season-gaps.md';
const SCHEDULE_POLL_MS = 10 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 3 * 60 * 1000;
const FILL_POLL_MS = 5 * 1000;
const MAX_CHAT_LINES = 20;
const MENU_ITEM_ID = 'check_now';
const RETRY_FAILED_MS = 60 * 60 * 1000;
// The media server fills a season's missing list in the background after the first question
const NATIVE_RECHECK_MS = 10 * 1000;

const HELP = [
  '/gaps: missing episodes of the series in your media library (airdcpp-season-gaps)',
  '/gaps <show>: the missing episodes of one show',
  '/gaps check: check the library now',
  '/gaps fill <show> [S02]: search the hubs for the missing episodes of one show (or one season)',
  '/gaps stop: forget the episodes still waiting to be searched for',
];

const errorText = (error) => (error && (error.message || error.code)) || String(error);

module.exports = function (socket, extension, { now = () => Date.now(), fetchImpl, sleep } = {}) {
  const settings = SettingsManager(socket, {
    extensionName: extension.name,
    configFile: extension.configPath + 'config.json',
    configVersion: CONFIG_VERSION,
    definitions: SettingDefinitions,
  });

  // A forgotten promise must never take the process down
  if (!module.exports.rejectionLogger) {
    module.exports.rejectionLogger = (reason) => socket.logger.error(`Unhandled rejection: ${errorText(reason)}`);
    process.on('unhandledRejection', module.exports.rejectionLogger);
  }

  const dir = () => extension.configPath || `.${path.sep}`;
  const fileOf = (name) => path.join(dir(), name);
  const values = () => SettingDefinitions.reduce((r, d) => ({ ...r, [d.key]: settings.getValue(d.key) }), {});

  let state = null;
  let lastResult = null;
  let checking = null;
  const timers = [];

  const writeAtomic = (name, text) => {
    const tmp = `${fileOf(name)}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, fileOf(name));
  };

  const freshState = () => ({
    version: 1, deviceId: crypto.randomBytes(12).toString('hex'), token: null, lastCheckAt: 0, searches: [], attempts: {}, pending: [],
  });

  const loadState = () => {
    state = freshState();
    try {
      const data = JSON.parse(fs.readFileSync(fileOf(STATE_FILE), 'utf8'));
      if (data && typeof data === 'object') {
        if (typeof data.deviceId === 'string' && /^[0-9a-f]{8,64}$/.test(data.deviceId)) state.deviceId = data.deviceId;
        if (typeof data.token === 'string') state.token = data.token;
        if (typeof data.lastCheckAt === 'number') state.lastCheckAt = data.lastCheckAt;
        if (Array.isArray(data.searches)) state.searches = data.searches.filter((t) => typeof t === 'number');
        if (data.attempts && typeof data.attempts === 'object') state.attempts = data.attempts;
        if (Array.isArray(data.pending)) state.pending = data.pending.filter((p) => p && typeof p.key === 'string' && Array.isArray(p.keys));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') socket.logger.error(`Could not read ${STATE_FILE}, starting empty: ${errorText(error)}`);
    }

    try {
      lastResult = JSON.parse(fs.readFileSync(fileOf(RESULT_FILE), 'utf8'));
      if (!lastResult || !Array.isArray(lastResult.shows)) lastResult = null;
    } catch (error) {
      lastResult = null;
    }
  };

  const saveState = () => {
    try {
      writeAtomic(STATE_FILE, JSON.stringify(state));
    } catch (error) {
      socket.logger.error(`Could not save ${STATE_FILE}: ${errorText(error)}`);
    }
  };

  const postEvent = (text, severity = 'info') => {
    socket.logger.info(text);
    if (settings.getValue('log_events')) {
      socket.post('events', { text: `${extension.name}: ${text}`, severity })
        .catch((error) => socket.logger.error(`Could not post an event message: ${errorText(error)}`));
    }
  };

  // The built-in media server, on loopback: a bind to every address is reached at 127.0.0.1
  const baseUrl = async () => {
    const configured = String(settings.getValue('media_server_url') || '').trim();
    if (configured) return configured;

    const status = await socket.get('media_server');
    if (!status || !status.running) {
      const error = new Error(status && status.enabled ? 'the media server is enabled but not running' : 'the media server is not enabled');
      error.status = 0;
      throw error;
    }

    const port = Number(status.port);
    let host = '127.0.0.1';
    const match = /^https?:\/\/(\[[^\]]*\]|[^:/]*)(?::(\d+))?/i.exec(String(status.address || ''));
    if (match && [ '[::]', '[::0]' ].includes(match[1])) {
      host = '[::1]';
    } else if (match && match[1] && ![ '0.0.0.0', 'localhost' ].includes(match[1])) {
      host = match[1];
    }
    const usePort = match && match[2] ? Number(match[2]) : port;
    if (!Number.isInteger(usePort) || usePort <= 0 || usePort > 65535) {
      const error = new Error('the media server port is not known');
      error.status = 0;
      throw error;
    }

    return `http://${host}:${usePort}`;
  };

  const jellyfin = createJellyfin({
    getBaseUrl: baseUrl,
    getCredentials: () => ({
      username: String(settings.getValue('media_server_user') || '').trim(),
      password: settings.getValue('media_server_password') || '',
      token: settings.getValue('media_server_token') || '',
      deviceId: state.deviceId,
      client: extension.name,
      version,
    }),
    loadToken: () => state.token,
    saveToken: (token) => {
      state.token = token || null;
      saveState();
    },
    fetchImpl,
  });

  const tmdbClient = createTmdb({
    getKey: () => settings.getValue('tmdb_key'),
    getLanguage: () => settings.getValue('tmdb_language'),
    cacheDir: path.join(dir(), 'tmdb-cache'),
    fetchImpl,
    now,
    ...(sleep ? { sleep } : {}),
  });

  const filler = createFiller({
    socket,
    getValues: values,
    store: { get: () => state, save: saveState },
    now,
    ...(sleep ? { sleep } : {}),
    onEvent: (text) => postEvent(text),
  });

  const missingItems = (show, seasonNumber) => {
    const items = [];
    for (const season of show.seasons) {
      if (seasonNumber !== undefined && season.season !== seasonNumber) continue;
      for (const m of season.missing) {
        items.push({ seriesId: show.seriesId, show: show.name, keys: show.keys, years: show.years || [], season: season.season, episode: m.episode });
      }
    }

    return items;
  };

  const check = async () => {
    const v = values();
    const tmdb = String(v.tmdb_key || '').trim() ? tmdbClient : null;
    if (tmdb) tmdb.prune();

    const result = await runCheck({
      jellyfin,
      tmdb,
      now: now(),
      log: (text) => socket.logger.info(text),
      ...(sleep ? { sleep } : {}),
      options: {
        graceDays: v.grace_days,
        includeSpecials: v.include_specials,
        between: v.report_seasons_between,
        after: v.report_seasons_after,
        before: v.report_seasons_before,
        identifyByName: v.identify_by_name,
        setDisplayMissing: v.set_display_missing,
        ignoredShows: v.ignored_shows,
        recheckDelayMs: NATIVE_RECHECK_MS,
      },
    });

    lastResult = result;
    state.lastCheckAt = result.at;
    saveState();
    try {
      writeAtomic(RESULT_FILE, JSON.stringify(result));
      writeAtomic(REPORT_FILE, report.buildMarkdown(result));
    } catch (error) {
      socket.logger.error(`Could not write the report: ${errorText(error)}`);
    }

    postEvent(`${report.summaryText(result)}. Report: ${fileOf(REPORT_FILE)}`);

    if (v.auto_fill) {
      const items = result.shows.flatMap((show) => missingItems(show));
      const added = filler.enqueue(items, { max: v.auto_fill_max });
      if (added > 0) postEvent(`automatic fill: ${added} episode(s) waiting to be searched for`);
    }

    return result;
  };

  // One check at a time; a second request joins the one running
  const checkOnce = () => {
    if (!checking) {
      state.lastCheckAt = now();
      saveState();
      checking = check()
        .catch((error) => {
          // A failed check is tried again within the hour rather than a whole interval later
          const intervalMs = settings.getValue('check_interval_hours') * 60 * 60 * 1000;
          state.lastCheckAt = now() - intervalMs + Math.min(intervalMs, RETRY_FAILED_MS);
          saveState();
          postEvent(`check failed: ${errorText(error)}`, 'error');
          throw error;
        })
        .finally(() => {
          checking = null;
        });
    }

    return checking;
  };

  const maybeScheduledCheck = () => {
    const due = state.lastCheckAt + settings.getValue('check_interval_hours') * 60 * 60 * 1000;
    if (now() >= due && !checking) {
      checkOnce().catch(() => {});
    }
  };

  const reply = async (base, sessionId, lines, owner) => {
    for (const line of lines.slice(0, MAX_CHAT_LINES + 2)) {
      await socket.post(`${base}/${sessionId}/status_message`, { text: line, severity: 'info', ...(owner ? { owner } : {}) });
    }
  };

  const fillCommand = (args) => {
    if (!lastResult) return [ 'No check has run yet. Type /gaps check first.' ];
    let seasonNumber;
    const words = [ ...args ];
    const seasonMatch = words.length > 1 ? /^s?(\d{1,3})$/i.exec(words[words.length - 1]) : null;
    if (seasonMatch) {
      seasonNumber = Number(seasonMatch[1]);
      words.pop();
    }

    const typed = words.join(' ').trim();
    if (!typed) return [ 'Usage: /gaps fill <show> [S02]' ];
    const found = report.findShows(lastResult, typed);
    if (found.length === 0) return [ `No show with gaps matches "${typed}".` ];
    if (found.length > 1) return [ `"${typed}" matches ${found.length} shows, be more exact:`, ...found.slice(0, 10).map((s) => `  ${s.name}`) ];

    const items = missingItems(found[0], seasonNumber);
    if (items.length === 0) return [ `${found[0].name}: nothing missing${seasonNumber !== undefined ? ` in season ${seasonNumber}` : ''}.` ];
    const added = filler.enqueue(items, { manual: true });
    const v = values();
    return [
      `${found[0].name}: ${added} episode(s) added to the search list (${state.pending.length} waiting in all).`,
      `At most ${v.searches_per_hour} hub search(es) an hour, ${v.search_spacing_seconds} s apart. Only releases whose name is exactly this show and episode${v.quality ? ` in ${v.quality}` : ''} are downloaded, into the normal download folder (airdcpp-download-sorter can file them).`,
    ];
  };

  const onTextCommand = (base) => async (data, sessionId) => {
    if (!data || !data.command) return;
    const command = String(data.command).toLowerCase();
    if (command === 'help') {
      await reply(base, sessionId, HELP, data.owner);
      return;
    }

    if (command !== 'gaps') return;
    const args = (data.args || []).map(String);
    const sub = (args[0] || '').toLowerCase();
    let lines;
    if (sub === 'help') {
      lines = HELP;
    } else if (sub === 'check') {
      await reply(base, sessionId, [ 'Checking the media library for missing episodes...' ], data.owner);
      try {
        const result = await checkOnce();
        lines = report.summaryLines(result, fileOf(REPORT_FILE), MAX_CHAT_LINES);
      } catch (error) {
        lines = [ `The check failed: ${errorText(error)}` ];
      }
    } else if (sub === 'fill') {
      lines = fillCommand(args.slice(1));
    } else if (sub === 'stop') {
      lines = [ `${filler.clear()} waiting episode(s) removed from the search list. Downloads already queued are not touched.` ];
    } else if (args.length > 0) {
      const found = lastResult ? report.findShows(lastResult, args.join(' ')) : [];
      lines = found.length === 0 ? [ `No show with gaps matches "${args.join(' ')}".` ] :
        found.slice(0, 5).flatMap((show) => report.showLines(show, Math.floor(MAX_CHAT_LINES / Math.min(found.length, 5))));
    } else {
      lines = report.summaryLines(lastResult, fileOf(REPORT_FILE), MAX_CHAT_LINES);
      if (state.pending.length > 0) lines.push(`${state.pending.length} episode(s) waiting to be searched for.`);
    }

    await reply(base, sessionId, lines, data.owner);
  };

  const guarded = (name, handler) => async (...args) => {
    try {
      await handler(...args);
    } catch (error) {
      socket.logger.error(`${name} failed: ${errorText(error)}`);
    }
  };

  // The extension's own row in the Extensions window: "Check for season gaps now". A list hook
  // only adds an item; if it ever times out, the menu simply lacks it.
  const addMenu = async () => {
    const subscriber = { id: extension.name, name: 'Season gaps' };
    await socket.addListener('menus', 'extension_menuitem_selected', guarded('menu', (data) => {
      if (data && data.hook_id === subscriber.id && data.menuitem_id === MENU_ITEM_ID) {
        checkOnce().catch(() => {});
      }
    }));
    await socket.addHook('menus', 'extension_list_menuitems', (data, accept) => {
      const ours = data && Array.isArray(data.selected_ids) && data.selected_ids.includes(extension.name);
      accept({ menuitems: ours ? [ { id: MENU_ITEM_ID, title: 'Check for season gaps now' } ] : [] });
    }, subscriber);
  };

  const every = (fn, ms) => {
    const timer = setInterval(fn, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    timers.push(timer);
  };

  const later = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    timers.push(timer);
  };

  extension.onStart = async () => {
    await settings.load();
    loadState();
    saveState();

    await socket.addListener('hubs', 'hub_text_command', guarded('hub_text_command', onTextCommand('hubs')));
    await socket.addListener('private_chat', 'private_chat_text_command', guarded('private_chat_text_command', onTextCommand('private_chat')));
    await socket.addListener('filelists', 'filelist_directory_download_failed', guarded('filelist_directory_download_failed', (data) => {
      const count = filler.onDirectoryDownloadFailed(data);
      if (count > 0) postEvent(`a folder download for ${count} episode(s) could not be queued (the source's file list did not arrive); looked for again later`, 'warning');
    }));
    try {
      await addMenu();
    } catch (error) {
      socket.logger.error(`Could not add the menu item: ${errorText(error)}`);
    }

    every(maybeScheduledCheck, SCHEDULE_POLL_MS);
    every(() => filler.tick().catch((error) => socket.logger.error(`Fill failed: ${errorText(error)}`)), FILL_POLL_MS);
    // The media server may still be starting with the client: the first check waits a little
    later(maybeScheduledCheck, FIRST_CHECK_DELAY_MS);
  };

  // Not run on Windows (the process is terminated); state is written as it changes
  extension.onStop = () => {
    timers.forEach((t) => {
      clearInterval(t);
      clearTimeout(t);
    });
  };

  // For the tests
  return {
    check: checkOnce, onTextCommand, filler, getState: () => state, getLastResult: () => lastResult, loadState, maybeScheduledCheck, baseUrl,
  };
};
