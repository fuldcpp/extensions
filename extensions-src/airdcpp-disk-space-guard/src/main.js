'use strict';

// Polls the queue and the free space of each bundle's folder. Uses no hooks: nothing the core
// does waits for this extension.

const fs = require('fs');
const path = require('path');

const SettingsManager = require('airdcpp-extension-settings');

const { SettingDefinitions } = require('./settings');
const { decide, foldersToCheck, formatGiB, PRIORITY_PAUSED_FORCE } = require('./decide');

const CONFIG_VERSION = 1;
const STATE_FILE = 'paused-bundles.json';

module.exports = function (socket, extension) {
  const settings = SettingsManager(socket, {
    extensionName: extension.name,
    configFile: extension.configPath + 'config.json',
    configVersion: CONFIG_VERSION,
    definitions: SettingDefinitions,
  });

  // Resolved on use: configPath is not guaranteed before the extension has started
  const statePathOf = () => path.join(extension.configPath || '.', STATE_FILE);
  let paused = {};   // bundle id -> { id, auto, name }: what this extension paused, and how to restore it
  let released = {}; // bundle id -> true: taken back by the user while the drive was low
  let timer = null;
  let running = false;
  let stopped = false;

  const errorText = (error) => (error && (error.message || error.code)) || String(error);
  const isNotFound = (error) => !!error && (error.code === 404 || /not found/i.test(String(error.message || '')));

  // The record survives restarts: after a crash or reboot the guard still knows which pauses
  // are its own and resumes exactly those
  const loadState = () => {
    try {
      const data = JSON.parse(fs.readFileSync(statePathOf(), 'utf8'));
      paused = (data && typeof data.paused === 'object' && data.paused) || {};
      released = (data && typeof data.released === 'object' && data.released) || {};
    } catch (error) {
      if (error.code !== 'ENOENT') {
        socket.logger.error(`Could not read ${STATE_FILE}, starting empty: ${errorText(error)}`);
      }

      paused = {};
      released = {};
    }
  };

  const saveState = () => {
    try {
      const tmp = `${statePathOf()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, paused, released }, null, 2));
      fs.renameSync(tmp, statePathOf());
    } catch (error) {
      socket.logger.error(`Could not save ${STATE_FILE}: ${errorText(error)}`);
    }
  };

  const logAction = (text, severity = 'info') => {
    socket.logger.info(text);
    if (settings.getValue('log_actions')) {
      socket.post('events', { text: `${extension.name}: ${text}`, severity })
        .catch((error) => socket.logger.error(`Could not post an event message: ${errorText(error)}`));
    }
  };

  const setPriority = (id, priority) => socket.post(`queue/bundles/${id}/priority`, { priority });

  const check = async () => {
    const bundles = await socket.get('queue/bundles/0/100000');
    const folders = foldersToCheck(bundles, paused, released);

    const freeByFolder = new Map();
    if (folders.length > 0) {
      const infos = await socket.post('filesystem/disk_info', { paths: folders });
      // The response keeps the request order
      folders.forEach((folder, index) => {
        const info = infos[index];
        freeByFolder.set(folder, info && typeof info.free_space === 'number' ? info.free_space : -1);
      });
    }

    const minFreeGiB = settings.getValue('min_free_gib');
    const { pause, resume, forget, release, unrelease } = decide({
      bundles, freeByFolder, paused, released, minFreeGiB, resumeMarginGiB: settings.getValue('resume_margin_gib'),
    });

    for (const id of forget) {
      delete paused[id];
    }

    for (const id of release) {
      released[id] = true;
    }

    for (const id of unrelease) {
      delete released[id];
    }

    // Every pause is on disk BEFORE its call: if the process dies halfway through the loop, the
    // next start still knows which force-pauses are its own. An entry whose call never ran is
    // harmless: its priority is not "paused (forced)", so the next round forgets it.
    for (const item of pause) {
      paused[item.id] = item.saved;
    }

    if (forget.length || release.length || unrelease.length || pause.length) {
      saveState();
    }

    const pausedNow = [];
    let failedPause = false;
    for (const item of pause) {
      try {
        await setPriority(item.id, PRIORITY_PAUSED_FORCE);
        pausedNow.push(item);
      } catch (error) {
        delete paused[item.id];
        failedPause = true;
        socket.logger.error(`Could not pause ${item.name}: ${errorText(error)}`);
      }
    }

    const resumedNow = [];
    let resumedAny = false;
    for (const item of resume) {
      try {
        await setPriority(item.id, item.priority);
        resumedNow.push(item.name);
        delete paused[item.id];
        resumedAny = true;
      } catch (error) {
        // Only a bundle that no longer exists is forgotten. A timeout or a busy client keeps
        // the entry, and the next round tries again.
        if (isNotFound(error)) {
          delete paused[item.id];
          resumedAny = true;
        }

        socket.logger.error(`Could not resume ${item.name}: ${errorText(error)}`);
      }
    }

    if (failedPause || resumedAny) {
      saveState();
    }

    if (pausedNow.length > 0) {
      // One message per drive: folders on one drive report the same free bytes, two low drives
      // must not share one figure
      const byFree = new Map();
      for (const item of pausedNow) {
        const entry = byFree.get(item.free) || { free: item.free, names: [] };
        entry.names.push(item.name);
        byFree.set(item.free, entry);
      }

      for (const { free, names } of byFree.values()) {
        logAction(`paused ${names.length} download(s), ${formatGiB(free)} free is below the ${minFreeGiB} GiB limit: ${names.join(', ')}`, 'warning');
      }
    }

    if (resumedNow.length > 0) {
      logAction(`resumed ${resumedNow.length} download(s), enough free space again: ${resumedNow.join(', ')}`);
    }
  };

  const schedule = () => {
    if (stopped) {
      return;
    }

    timer = setTimeout(tick, settings.getValue('check_interval_seconds') * 1000);
  };

  const tick = async () => {
    timer = null;
    if (running) {
      // The running check schedules the next one; a second timer would double the polling
      return;
    }

    running = true;
    try {
      await check();
    } catch (error) {
      socket.logger.error(`Check failed: ${errorText(error)}`);
    } finally {
      running = false;
      schedule();
    }
  };

  extension.onStart = async () => {
    await settings.load();
    loadState();
    settings.onValuesUpdated = (updated) => {
      // A new limit takes effect at once rather than at the next scheduled check
      if (('min_free_gib' in updated || 'resume_margin_gib' in updated || 'check_interval_seconds' in updated) && timer) {
        clearTimeout(timer);
        tick();
      }
    };

    await tick();
  };

  extension.onStop = () => {
    stopped = true;
    clearTimeout(timer);
  };

  // For the tests
  return { check, getPaused: () => paused, getReleased: () => released, loadState };
};
