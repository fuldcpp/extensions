'use strict';

// Finds films and episodes that every counted media server account has watched, writes a report
// (and a summary to the event log) once a day, and on "/cleanup run" moves them to the Windows
// Recycle Bin. Uses listeners and polling only: no hooks.
//
// Web API routes (airdcpp-windows origin/master f163a4989, airdcpp-webapi/api):
//   GET  media_server                              MediaServerApi.cpp:33 {enabled, running, address, port}
//   GET  share_roots                               ShareRootApi.cpp:41
//   POST share/directories/by_real                 ShareApi.cpp:87  (a root's path id)
//   POST share/directories/by_real/content/{s}/{n} ShareApi.cpp:86  (ids of what is in a folder)
//   POST queue/check_path_queued                   QueueApi.cpp:125 (QueueManager.cpp:4060)
//   POST share/refresh/paths                       ShareApi.cpp:94
//   POST events, POST hubs|private_chat/{id}/status_message, listeners *_text_command
// Jellyfin routes (airdcpp/airdcpp/modules/mediaserver/JellyfinApi.cpp):
//   GET /Users/Me (14182), GET /Users (14544: every account, to any signed-in account),
//   GET /Users/{id}/Views (16971), GET /Users/{id}/Items (18055 -> browse 7360: Recursive,
//   ParentId, IncludeItemTypes, Filters IsPlayed/IsResumable/IsFavorite at 7015-7040, Limit <= 1000
//   at 58), GET /Items/{id}/Ancestors (18273), GET /Items/{id}/Collections (18449 -> 20877).
//   The watched state in every answer is the SIGNED-IN account's own (browse reads requestUserId,
//   7863 / 3179, from the session; the {id} in the address is not read): there is no route that
//   tells one account what another has watched, administrator or not. Each counted account
//   therefore signs in itself.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SettingsManager = require('airdcpp-extension-settings');

const { SettingDefinitions } = require('./settings');
const { createJellyfin } = require('./jellyfin');
const { createResolver } = require('./resolver');
const { createRecycler } = require('./recycle');
const {
  DAY_MS, GIB, normId, base32ToHex16, isUnder, isRecordingName, selectCandidates, planRemoval, applyCaps,
  formatBytes, totalsByDrive, titleOf, buildReport,
} = require('./decide');

const CONFIG_VERSION = 1;
const STATE_FILE = 'state.json';
const REPORT_FILE = 'watched-cleanup-report.md';
const HISTORY_FILE = 'cleanup-history.log';
const FIRST_PASS_DELAY_MS = 5 * 60 * 1000;
const PAGE = 1000;
const MAX_PAGES = 40;
const MAX_SHOWN = 25;
const VERSION = '1.0.0-beta.1';
const HELP = [
  '/cleanup list: what could be moved to the Recycle Bin (watched by every counted account), and writes the report',
  '/cleanup run: moves that list (capped) to the Recycle Bin, after showing it',
  '(airdcpp-watched-cleanup)',
];

let rejectionLoggerInstalled = false;

module.exports = function (socket, extension, deps = {}) {
  const now = deps.now || (() => Date.now());
  const fetchImpl = deps.fetchImpl;
  const recycler = deps.recycler || createRecycler();
  const fsp = deps.fsPromises || fs.promises;

  const settings = SettingsManager(socket, {
    extensionName: extension.name,
    configFile: extension.configPath + 'config.json',
    configVersion: CONFIG_VERSION,
    definitions: SettingDefinitions,
  });

  const fileOf = (name) => path.join(extension.configPath || '.', name);
  let state = { deviceId: '', tokens: {}, creds: {}, lastPassAt: 0 };
  let timer = null;
  let busy = false;
  let stopped = false;

  const errorText = (error) => (error && (error.message || error.code)) || String(error);

  const loadState = () => {
    try {
      const data = JSON.parse(fs.readFileSync(fileOf(STATE_FILE), 'utf8'));
      state = {
        deviceId: typeof data.deviceId === 'string' ? data.deviceId : '',
        tokens: data.tokens && typeof data.tokens === 'object' ? data.tokens : {},
        creds: data.creds && typeof data.creds === 'object' ? data.creds : {},
        lastPassAt: Number(data.lastPassAt) || 0,
      };
    } catch (error) {
      if (error.code !== 'ENOENT') socket.logger.error(`Could not read ${STATE_FILE}, starting empty: ${errorText(error)}`);
    }

    ensureDeviceId();
  };

  // One stable id per installation, so the media server's device list shows one device
  function ensureDeviceId() {
    if (!state.deviceId) {
      state.deviceId = crypto.randomBytes(12).toString('hex');
      saveState();
    }

    return state.deviceId;
  }

  // tmp + rename: the client ends extensions with TerminateProcess on Windows
  const writeAtomic = (name, text) => {
    const tmp = `${fileOf(name)}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, fileOf(name));
  };

  function saveState() {
    try {
      writeAtomic(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (error) {
      socket.logger.error(`Could not save ${STATE_FILE}: ${errorText(error)}`);
    }
  }

  const appendHistory = (entry) => {
    try {
      fs.appendFileSync(fileOf(HISTORY_FILE), `${JSON.stringify({ at: new Date(now()).toISOString(), ...entry })}\n`);
    } catch (error) {
      socket.logger.error(`Could not write ${HISTORY_FILE}: ${errorText(error)}`);
    }
  };

  const postEvent = (text, severity = 'info') => {
    socket.post('events', { text: `${extension.name}: ${text}`, severity })
      .catch((error) => socket.logger.error(`Could not post an event message: ${errorText(error)}`));
  };

  // The media server's own address, loopback when it listens on every interface
  let baseUrl = '';
  const refreshBaseUrl = async () => {
    const status = await socket.get('media_server');
    if (!status || !status.running || typeof status.address !== 'string' || !status.address) {
      throw new Error('The media server is not running');
    }

    baseUrl = status.address.replace('//0.0.0.0', '//127.0.0.1').replace('//[::]', '//[::1]');
  };

  const accountsFromSettings = () => {
    const list = [ {
      username: String(settings.getValue('server_user') || '').trim(),
      password: String(settings.getValue('server_password') || ''),
      token: String(settings.getValue('server_token') || ''),
    } ];
    for (const extra of settings.getValue('extra_accounts') || []) {
      const username = String((extra && extra.username) || '').trim();
      if (username) list.push({ username, password: String(extra.password || ''), token: '' });
    }

    return list;
  };

  const clients = new Map(); // account key -> jellyfin client
  const clientFor = (account, index) => {
    const key = `${index}:${account.username}`;
    const tokenKey = `${account.username || '(token)'}`;
    const known = clients.get(key);
    if (known && known.password === account.password && known.token === account.token) return known.client;

    // A saved token belongs to the credentials it was signed in with. Found by user name alone,
    // it outlived a password changed in the settings: a WRONG password was never tried and
    // "/cleanup run" went ahead (live test 2026-10-19). Changed credentials sign in again.
    const cred = crypto.createHash('sha256').update(`${account.username}|${account.password}|${account.token}`).digest('hex').slice(0, 16);
    const client = createJellyfin({
      getBaseUrl: () => baseUrl,
      getCredentials: () => ({ ...account, deviceId: `${ensureDeviceId()}-${index}` }),
      loadToken: () => (state.creds[tokenKey] === cred ? state.tokens[tokenKey] || '' : ''),
      saveToken: (token) => {
        if (token) {
          state.tokens[tokenKey] = token;
          state.creds[tokenKey] = cred;
        } else {
          delete state.tokens[tokenKey];
          delete state.creds[tokenKey];
        }

        saveState();
      },
      fetchImpl,
      client: extension.name,
      version: VERSION,
    });
    clients.set(key, { client, password: account.password, token: account.token });
    return client;
  };

  const pages = async (jf, userId, query) => {
    const items = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const answer = await jf.get(`/Users/${userId}/Items`, { ...query, StartIndex: page * PAGE, Limit: PAGE });
      const got = (answer && Array.isArray(answer.Items)) ? answer.Items : [];
      items.push(...got);
      if (got.length < PAGE || items.length >= (answer.TotalRecordCount || 0)) break;
    }

    return items;
  };

  const dedupe = (items) => {
    const seen = new Map();
    for (const item of items) {
      if (item && item.Id && !seen.has(normId(item.Id))) seen.set(normId(item.Id), item);
    }

    return Array.from(seen.values());
  };

  // One account's view: who it is, and what it has watched, is watching and keeps
  const gatherAccount = async (jf) => {
    const me = await jf.get('/Users/Me');
    if (!me || !me.Id) throw new Error('The media server did not say who is signed in');
    const userId = normId(me.Id);
    const views = await jf.get(`/Users/${userId}/Views`);
    const parents = ((views && views.Items) || [])
      .filter((v) => v && (v.CollectionType === 'movies' || v.CollectionType === 'tvshows'))
      .map((v) => v.Id);
    // No typed libraries: the whole library, which the server scans up to its own cap
    const scopes = parents.length > 0 ? parents : [ '' ];
    const fetchAll = async (query) => {
      const all = [];
      for (const parentId of scopes) {
        all.push(...await pages(jf, userId, { ...query, ParentId: parentId, Recursive: 'true', Fields: 'DateCreated' }));
      }

      return dedupe(all);
    };

    return {
      id: userId,
      name: String(me.Name || ''),
      played: await fetchAll({ IncludeItemTypes: 'Movie,Episode', Filters: 'IsPlayed' }),
      resumable: await fetchAll({ IncludeItemTypes: 'Movie,Episode', Filters: 'IsResumable' }),
      favorites: await fetchAll({ IncludeItemTypes: 'Movie,Episode,Series,Season', Filters: 'IsFavorite' }),
    };
  };

  // Everything in a folder, from the disk. Bounded: a release folder is small, and a folder too big
  // or too deep to list whole is never moved as a whole.
  const listFolder = async (folder) => {
    const entries = [];
    let overflow = false;
    const walk = async (dir, rel, depth) => {
      if (depth > 4) { overflow = true; return; }
      for (const d of await fsp.readdir(dir, { withFileTypes: true })) {
        if (entries.length >= 300) { overflow = true; return; }
        const childRel = rel ? `${rel}\\${d.name}` : d.name;
        const full = path.join(dir, d.name);
        if (d.isDirectory()) {
          entries.push({ rel: childRel, size: 0, isDir: true });
          await walk(full, childRel, depth + 1);
        } else {
          let size = 0;
          try { size = (await fsp.stat(full)).size; } catch (e) { /* gone meanwhile */ }
          // Links and the like are not plain files: count them as strangers so the folder stays
          entries.push({ rel: d.isFile() ? childRel : `${childRel}.link-or-device`, size, isDir: false });
        }
      }
    };

    await walk(folder, '', 0);
    return { entries, overflow };
  };

  const isQueued = async (p) => {
    const answer = await socket.post('queue/check_path_queued', { path: p });
    return !!(answer && answer.bundle);
  };

  /* One full look: candidates, their files, the plan. Writes the report. Moves nothing. */
  const survey = async () => {
    await refreshBaseUrl();
    const accounts = accountsFromSettings();
    const gathered = [];
    for (let i = 0; i < accounts.length; i++) {
      const jf = clientFor(accounts[i], i);
      try {
        gathered.push({ ...await gatherAccount(jf), jf });
      } catch (error) {
        throw new Error(`Account ${accounts[i].username || '(token)'}: ${errorText(error)}`);
      }
    }

    const main = gathered[0];
    const counted = new Set(gathered.map((g) => g.id));
    if (counted.size !== gathered.length) throw new Error('The same account is listed twice');
    const users = await main.jf.get('/Users');
    const uncovered = (Array.isArray(users) ? users : [])
      .filter((u) => u && u.Id && !counted.has(normId(u.Id)) && !(u.Policy && u.Policy.IsDisabled === true))
      .map((u) => String(u.Name || u.Id));

    const watchedDays = settings.getValue('watched_days');
    const { candidates, excluded } = selectCandidates({
      accounts: gathered, now: now(), watchedDays, addedDays: settings.getValue('added_days'),
      keepLastEpisodes: settings.getValue('keep_last_episodes'),
    });

    // The share roots that are also media library roots, by the id both sides compute
    const roots = await socket.get('share_roots');
    const rootsById = new Map();
    for (const r of Array.isArray(roots) ? roots : []) {
      if (!r || typeof r.path !== 'string') continue;
      try {
        const dir = await socket.post('share/directories/by_real', { path: r.path });
        const hex = dir && base32ToHex16(dir.id);
        if (hex) rootsById.set(hex, dir.path || r.path);
      } catch (error) {
        socket.logger.verbose(`Share root not readable: ${errorText(error)}`);
      }
    }

    const top = await main.jf.get(`/Users/${main.id}/Items`, { Limit: PAGE });
    const libraryRootIds = new Set(((top && top.Items) || []).map((i) => normId(i.Id)));
    const shareRootPaths = Array.from(rootsById.values());

    const keepFolders = (settings.getValue('keep_folders') || []).filter(Boolean);
    const dvrFolder = settings.getValue('dvr_folder');
    const neverTouch = [ ...keepFolders, ...(dvrFolder ? [ dvrFolder ] : []) ];
    const keepCollections = new Set((settings.getValue('keep_collections') || []).map((c) => String(c).trim().toLowerCase()).filter(Boolean));

    const resolver = createResolver({ jellyfin: main.jf, socket, rootsById, libraryRootIds });
    const planned = [];
    const skipped = [];
    const leave = (item, reason, p) => skipped.push({ item, reason, path: p });

    for (const item of candidates) {
      const found = await resolver.resolve(item);
      if (!found.path) { leave(item, found.reason); continue; }
      const file = found.path;

      if (isRecordingName(path.basename(file))) { leave(item, 'a recording (the client manages those)', file); continue; }
      if (neverTouch.some((k) => isUnder(file, k))) { leave(item, 'in a keep-forever folder', file); continue; }
      if (!shareRootPaths.some((r) => isUnder(file, r) && !isUnder(r, file))) { leave(item, 'outside the share roots', file); continue; }

      if (keepCollections.size > 0) {
        try {
          const inside = await main.jf.get(`/Items/${item.Id}/Collections`);
          if (((inside && inside.Items) || []).some((c) => keepCollections.has(String(c.Name || '').trim().toLowerCase()))) {
            leave(item, 'in a keep-forever collection', file);
            continue;
          }
        } catch (error) {
          leave(item, 'its collections could not be read', file);
          continue;
        }
      }

      let stat;
      try {
        stat = await fsp.stat(file);
      } catch (error) {
        leave(item, 'the file is not on the disk', file);
        continue;
      }

      if (!stat.isFile() || (found.shareSize > 0 && stat.size !== found.shareSize)) {
        leave(item, 'the file changed since the share last saw it', file);
        continue;
      }

      let listing;
      try {
        listing = await listFolder(path.dirname(file));
      } catch (error) {
        leave(item, 'its folder could not be read', file);
        continue;
      }

      const plan = planRemoval({
        file, type: item.Type, entries: listing.entries, overflow: listing.overflow,
        guarded: [ ...shareRootPaths, ...neverTouch ],
      });
      if (plan.skip) { leave(item, plan.skip, file); continue; }

      try {
        const queued = await isQueued(file) || (plan.kind === 'folder' && await isQueued(`${plan.paths[0].replace(/[\\/]+$/, '')}\\`));
        if (queued) { leave(item, 'in the download queue', file); continue; }
      } catch (error) {
        leave(item, 'the download queue could not be asked', file);
        continue;
      }

      planned.push({ item, ...plan, root: found.root, size: stat.size });
    }

    const settingsText = `watched more than ${watchedDays} days ago by every counted account, added more than ${settings.getValue('added_days')} days ago, `
      + `not a favourite, no episode of the series in progress, last ${settings.getValue('keep_last_episodes')} watched episode(s) of each series kept.`;
    const report = buildReport({ planned, skipped, excluded, accounts: gathered.map((g) => g.name), uncovered, now: now(), settingsText });
    try {
      writeAtomic(REPORT_FILE, report);
    } catch (error) {
      socket.logger.error(`Could not write ${REPORT_FILE}: ${errorText(error)}`);
    }

    return { planned, skipped, uncovered, accounts: gathered.map((g) => g.name), shareRootPaths, neverTouch };
  };

  const describe = (planned) => {
    const total = planned.reduce((sum, p) => sum + p.bytes, 0);
    const drives = totalsByDrive(planned).map(([ d, b ]) => `${d} ${formatBytes(b)}`).join(', ');
    return `${planned.length} item(s), ${formatBytes(total)}${drives ? ` (${drives})` : ''}`;
  };

  const itemLines = (planned) => {
    const lines = planned.slice(0, MAX_SHOWN).map((p) => `  ${titleOf(p.item)}: ${formatBytes(p.bytes)}, ${p.kind === 'folder' ? 'folder ' : ''}${p.paths[0]}${p.paths.length > 1 ? ` (+${p.paths.length - 1} beside it)` : ''}`);
    if (planned.length > MAX_SHOWN) lines.push(`  ...and ${planned.length - MAX_SHOWN} more, see ${fileOf(REPORT_FILE)}`);
    return lines;
  };

  // The last checks, made again right before each move
  const stillSafe = async (p, result) => {
    for (const target of p.paths) {
      if (!result.shareRootPaths.some((r) => isUnder(target, r) && !isUnder(r, target))) return 'outside the share roots';
      if (result.neverTouch.some((k) => isUnder(target, k) || isUnder(k, target))) return 'in a keep-forever folder';
    }

    try {
      if (await isQueued(p.kind === 'folder' ? `${p.paths[0].replace(/[\\/]+$/, '')}\\` : p.paths[0])) return 'in the download queue';
    } catch (error) {
      return 'the download queue could not be asked';
    }

    return null;
  };

  /* Moves the capped plan to the Recycle Bin. Returns the lines to show. */
  const clean = async (result, out) => {
    if (result.uncovered.length > 0 && !settings.getValue('ignore_other_accounts')) {
      out(`Not cleaning: the media server also has ${result.uncovered.join(', ')}, whose watched state this extension cannot read. Add them under "Other accounts whose watched state counts", or turn on "Clean even though...".`);
      return { moved: 0, bytes: 0 };
    }

    const { taken } = applyCaps(result.planned, settings.getValue('max_items_per_run'), settings.getValue('max_gib_per_run') * GIB);
    if (taken.length === 0) {
      out('Nothing to move.');
      return { moved: 0, bytes: 0 };
    }

    out(`Moving to the Recycle Bin: ${describe(taken)}`);
    itemLines(taken).forEach(out);

    let moved = 0;
    let bytes = 0;
    const refresh = new Set();
    for (const p of taken) {
      const unsafe = await stillSafe(p, result);
      if (unsafe) {
        out(`  skipped ${titleOf(p.item)}: ${unsafe}`);
        continue;
      }

      appendHistory({ action: 'recycling', title: titleOf(p.item), paths: p.paths });
      let results;
      try {
        // The video (or its folder) first, alone: its sidecars only follow once it has gone, so a
        // failed move never leaves a video stripped of its subtitles. A folder's size for the
        // bin check is the whole plan.
        results = await recycler.recycle([ { path: p.paths[0], is_dir: p.kind === 'folder', size: p.kind === 'folder' ? p.bytes : p.size } ]);
        if (results[0] && results[0].ok && p.paths.length > 1) {
          results = results.concat(await recycler.recycle(p.paths.slice(1).map((x) => ({ path: x, is_dir: false, size: 0 }))));
        }
      } catch (error) {
        out(`  failed ${titleOf(p.item)}: ${errorText(error)}`);
        appendHistory({ action: 'failed', title: titleOf(p.item), reason: errorText(error) });
        continue;
      }

      // Anything moved changed the folder, whether or not the video itself went
      if (results.some((r) => r.ok)) refresh.add(p.refresh);
      const first = results[0];
      appendHistory({ action: 'recycled', title: titleOf(p.item), results });
      if (first && first.ok) {
        moved++;
        bytes += p.bytes;
        if (!first.in_bin) out(`  ${titleOf(p.item)}: moved, but not found in the Recycle Bin afterwards - check it`);
      } else {
        out(`  not moved ${titleOf(p.item)}: ${(first && first.reason) || 'unknown'}`);
      }

      results.slice(1).filter((r) => !r.ok).forEach((r) => out(`  left beside it: ${r.path} (${r.reason})`));
    }

    if (refresh.size > 0) {
      try {
        await socket.post('share/refresh/paths', { paths: Array.from(refresh).map((f) => `${f.replace(/[\\/]+$/, '')}\\`) });
      } catch (error) {
        out(`The share could not be refreshed (${errorText(error)}); it catches up on its next refresh.`);
      }
    }

    out(`Moved ${moved} item(s), ${formatBytes(bytes)}, to the Recycle Bin.`);
    return { moved, bytes };
  };

  // Runs one thing at a time; a second request while one runs is answered, not queued
  const exclusive = async (fn, out) => {
    if (busy) {
      out('Already working on a pass; try again in a minute.');
      return null;
    }

    busy = true;
    try {
      return await fn();
    } catch (error) {
      out(`Failed: ${errorText(error)}`);
      return null;
    } finally {
      busy = false;
    }
  };

  const configured = () => {
    const first = accountsFromSettings()[0];
    return !!((first.username && first.password) || first.token);
  };

  const periodicPass = () => exclusive(async () => {
    if (!configured()) {
      socket.logger.verbose('No media server account is set; skipping the pass');
      return null;
    }

    state.lastPassAt = now();
    saveState();
    const result = await survey();
    if (settings.getValue('log_summary')) {
      postEvent(`watched and done with: ${describe(result.planned)}; report in ${fileOf(REPORT_FILE)}${result.uncovered.length ? `; not counted: ${result.uncovered.join(', ')}` : ''}`);
    }

    if (settings.getValue('clean_automatically') && result.planned.length > 0) {
      const lines = [];
      const { moved, bytes } = await clean(result, (l) => lines.push(l));
      lines.forEach((l) => socket.logger.info(l));
      postEvent(`automatic clean: moved ${moved} item(s), ${formatBytes(bytes)}, to the Recycle Bin`, moved > 0 ? 'warning' : 'info');
    }

    return result;
  }, (line) => {
    socket.logger.error(line);
    postEvent(line, 'error');
  });

  const schedule = () => {
    if (stopped) return;
    clearTimeout(timer);
    const interval = settings.getValue('check_interval_hours') * 3600 * 1000;
    const due = Math.max(now() + FIRST_PASS_DELAY_MS, (state.lastPassAt || 0) + interval);
    timer = setTimeout(() => {
      timer = null;
      periodicPass().catch((error) => socket.logger.error(`Pass failed: ${errorText(error)}`)).finally(schedule);
    }, Math.min(due - now(), 0x7fffffff));
    if (timer && typeof timer.unref === 'function') timer.unref();
  };

  const onTextCommand = (base) => async (data, sessionId) => {
    if (!data || String(data.command || '').toLowerCase() !== 'cleanup') {
      if (data && String(data.command || '').toLowerCase() === 'help') {
        for (const line of HELP) await socket.post(`${base}/${sessionId}/status_message`, { text: line, severity: 'info', ...(data.owner ? { owner: data.owner } : {}) });
      }

      return;
    }

    // Local status lines only: never sent to the hub. Each starts with a tag so a path can never
    // read as a command.
    const lines = [];
    const out = (line) => lines.push(`[cleanup] ${line}`);
    const sub = String((data.args || [])[0] || '').toLowerCase();
    if (sub === 'list') {
      await exclusive(async () => {
        const result = await survey();
        out(`Could be moved to the Recycle Bin: ${describe(result.planned)}`);
        itemLines(result.planned).forEach(out);
        if (result.skipped.length) out(`${result.skipped.length} watched item(s) left alone (reasons in the report).`);
        if (result.uncovered.length) out(`Not counted: ${result.uncovered.join(', ')}; "/cleanup run" refuses until they are.`);
        out(`Report: ${fileOf(REPORT_FILE)}`);
      }, out);
    } else if (sub === 'run') {
      await exclusive(async () => {
        const result = await survey();
        out(`Dry run first: ${describe(result.planned)} watched by everyone counted.`);
        const { moved, bytes } = await clean(result, out);
        if (moved > 0) postEvent(`moved ${moved} item(s), ${formatBytes(bytes)}, to the Recycle Bin ("/cleanup run")`, 'warning');
      }, out);
    } else {
      HELP.forEach(out);
    }

    for (const line of lines) {
      await socket.post(`${base}/${sessionId}/status_message`, { text: line, severity: 'info', ...(data.owner ? { owner: data.owner } : {}) });
    }
  };

  const guarded = (name, handler) => async (...args) => {
    try {
      await handler(...args);
    } catch (error) {
      socket.logger.error(`${name} failed: ${errorText(error)}`);
    }
  };

  extension.onStart = async () => {
    if (!rejectionLoggerInstalled) {
      rejectionLoggerInstalled = true;
      process.on('unhandledRejection', (reason) => socket.logger.error(`Unhandled rejection: ${errorText(reason)}`));
    }

    await settings.load();
    loadState();
    settings.onValuesUpdated = (updated) => {
      if ('check_interval_hours' in updated) schedule();
    };

    await socket.addListener('hubs', 'hub_text_command', guarded('hub_text_command', onTextCommand('hubs')));
    await socket.addListener('private_chat', 'private_chat_text_command', guarded('private_chat_text_command', onTextCommand('private_chat')));
    schedule();
  };

  extension.onStop = () => {
    stopped = true;
    clearTimeout(timer);
  };

  // For the tests
  return { survey, clean, periodicPass, onTextCommand, getState: () => state, loadState, DAY_MS };
};
