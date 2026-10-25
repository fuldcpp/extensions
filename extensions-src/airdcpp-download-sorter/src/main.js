'use strict';

// Listens for finished bundles (an event, never a hook: nothing in the core waits for this
// extension) and moves each into its category folder once it has settled.
//
// Every move that has started is recorded in pending-moves.json first. A move that fails for a
// passing reason (a file open for an upload) is retried with backoff, also across restarts, so a
// release taken out of the queue is never simply forgotten.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const SettingsManager = require('airdcpp-extension-settings');

const { SettingDefinitions } = require('./settings');
const { destinationOf, parseCustomRules, isStrictlyInside, isInside, normalizeDir, isRootedDirectory } = require('./classify');
const { moveInto, exists, PARTIAL_SUFFIX } = require('./mover');

const CONFIG_VERSION = 1;
const PENDING_FILE = 'pending-moves.json';
const RETRY_CODES = [ 'EBUSY', 'EPERM', 'EACCES' ]; // a file still open (an upload in progress)
const BACKOFF_MINUTES = [ 1, 2, 5, 10, 30, 60 ];
const GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;
const PENDING_CHECK_MS = 60 * 1000;

const backoffMs = (attempts) => BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)] * 60 * 1000;

module.exports = function (socket, extension, { moveImpl = moveInto, now = () => Date.now() } = {}) {
  const settings = SettingsManager(socket, {
    extensionName: extension.name,
    configFile: extension.configPath + 'config.json',
    configVersion: CONFIG_VERSION,
    definitions: SettingDefinitions,
  });

  const pendingPathOf = () => path.join(extension.configPath || '.', PENDING_FILE);
  const scheduled = new Map(); // bundle id -> timeout
  let pending = {}; // release path -> { source, directory, name, attempts, since, nextAt }
  let chain = Promise.resolve(); // one move at a time
  let pendingTimer = null;
  let stopped = false;
  let clientDownloadDir = '';

  const errorText = (error) => (error && (error.message || error.code)) || String(error);

  const logEvent = (text, severity = 'info') => {
    socket.logger.info(text);
    socket.post('events', { text: `${extension.name}: ${text}`, severity })
      .catch((error) => socket.logger.error(`Could not post an event message: ${errorText(error)}`));
  };

  const loadPending = () => {
    try {
      const data = JSON.parse(fs.readFileSync(pendingPathOf(), 'utf8'));
      const loaded = (data && typeof data.pending === 'object' && data.pending) || {};

      // A move with no source or destination (a hand-edited or torn file) cannot be retried, and
      // reading it later would throw at every start
      pending = {};
      for (const [key, entry] of Object.entries(loaded)) {
        if (entry && typeof entry.source === 'string' && entry.source && typeof entry.directory === 'string' && entry.directory) {
          // Without its times or count the move is never due (nextAt <= now is false for undefined) and never
          // given up on: a torn entry is retried from now, as a new move would be
          const number = (value, fallback) => (Number.isFinite(value) ? value : fallback);
          pending[key] = { ...entry, attempts: number(entry.attempts, 0), since: number(entry.since, now()), nextAt: number(entry.nextAt, now()) };
        } else {
          socket.logger.error(`Dropping a pending move without a source or destination from ${PENDING_FILE}: ${key}`);
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        socket.logger.error(`Could not read ${PENDING_FILE}: ${errorText(error)}`);
      }

      pending = {};
    }
  };

  const savePending = () => {
    try {
      const tmp = `${pendingPathOf()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, pending }, null, 2));
      fs.renameSync(tmp, pendingPathOf());
    } catch (error) {
      socket.logger.error(`Could not save ${PENDING_FILE}: ${errorText(error)}`);
    }
  };

  const currentRules = () => parseCustomRules(settings.getValue('custom_rules'));

  const destinationRoots = () => [
    settings.getValue('tv_directory'), settings.getValue('movies_directory'), settings.getValue('music_directory'),
    ...currentRules().rules.map((r) => r.directory),
  ].filter(Boolean);

  const sortSettings = () => ({
    tvDirectory: settings.getValue('tv_directory'),
    moviesDirectory: settings.getValue('movies_directory'),
    musicDirectory: settings.getValue('music_directory'),
    tvGroupByShow: settings.getValue('tv_group_by_show'),
    customRules: currentRules().rules,
  });

  const sourceDirectory = () => settings.getValue('source_directory') || clientDownloadDir;

  // A directory bundle's target ends with a separator; the release on disk is that folder
  const releasePathOf = (bundle) => bundle.target.replace(/[\\/]+$/, '');

  const renameHashes = async (files) => {
    let renamed = 0;
    for (const file of files) {
      try {
        await socket.post('hash/rename_path', { old_path: file.from, new_path: file.to });
        renamed++;
      } catch (error) {
        // Expected for files outside the share: only shared files are in the hash database
        socket.logger.verbose(`No hash entry moved for ${file.from}: ${errorText(error)}`);
      }
    }

    return renamed;
  };

  const refreshShare = async (directory) => {
    try {
      await socket.post('share/refresh/paths', { paths: [ directory ] });
    } catch (error) {
      // 417: not inside a share root - nothing to refresh
      socket.logger.verbose(`No share refresh for ${directory}: ${errorText(error)}`);
    }
  };

  // One attempt for a pending move; updates the record and reports the outcome
  const attemptMove = async (key) => {
    const entry = pending[key];
    if (!entry) {
      return;
    }

    let result;
    try {
      result = await moveImpl(entry.source, entry.directory);
    } catch (error) {
      const retryable = RETRY_CODES.includes(error.code);
      if (retryable && now() - entry.since < GIVE_UP_AFTER_MS) {
        entry.attempts++;
        entry.nextAt = now() + backoffMs(entry.attempts);
        if (entry.attempts === 1) {
          logEvent(`${entry.name} is in use (${error.code}); it will be moved once it is free`);
        }
      } else {
        delete pending[key];
        logEvent(`could not move ${entry.name} (${error.code || errorText(error)}); it stays in ${path.dirname(entry.source)}`, 'error');
      }

      savePending();
      return;
    }

    delete pending[key];
    savePending();

    const renamed = await renameHashes(result.files);
    await refreshShare(path.dirname(entry.source));
    await refreshShare(entry.directory);
    logEvent(`moved ${entry.name} to ${entry.directory}${renamed ? ` (${renamed} hashed file(s) kept)` : ''}`);
    if (result.leftovers.length > 0) {
      logEvent(`${result.leftovers.length} file(s) of the original ${entry.name} could not be deleted (still in use): ${result.leftovers.join(', ')}`, 'warning');
    }
  };

  const sortBundle = async (bundleId) => {
    let bundle;
    try {
      bundle = await socket.get(`queue/bundles/${bundleId}`);
    } catch (error) {
      return; // removed meanwhile
    }

    if (!bundle.status || !bundle.status.completed) {
      return; // back in the queue (recheck) or never finished
    }

    const source = sourceDirectory();
    if (!source || !isStrictlyInside(bundle.target, source)) {
      socket.logger.verbose(`${bundle.name}: not inside ${source || '(no source folder)'}, left alone`);
      return;
    }

    const releasePath = releasePathOf(bundle);
    const roots = destinationRoots();
    // Already sorted, or a release that is (or holds) a destination folder: never touch it
    if (roots.some((root) => isInside(releasePath, root) || isInside(root, releasePath))) {
      socket.logger.verbose(`${bundle.name}: inside or around a destination folder, left alone`);
      return;
    }

    const destination = destinationOf(bundle.name, sortSettings());
    if (!destination) {
      socket.logger.verbose(`${bundle.name}: no category, left alone`);
      return;
    }

    if (!isRootedDirectory(destination.directory)) {
      logEvent(`not moving ${bundle.name}: ${destination.directory} is not a full path`, 'warning');
      return;
    }

    if (normalizeDir(path.dirname(releasePath)) === normalizeDir(destination.directory)) {
      return; // already where it belongs
    }

    if (settings.getValue('dry_run')) {
      logEvent(`dry run: would move ${releasePath} to ${destination.directory} (${destination.category})`);
      return;
    }

    // Everything that can be checked is checked while the bundle is still in the queue
    const targetPath = path.join(destination.directory, path.basename(releasePath));
    if (await exists(targetPath)) {
      logEvent(`not moving ${bundle.name}: ${targetPath} already exists`, 'warning');
      return;
    }

    try {
      await fsp.access(path.parse(destination.directory).root);
    } catch (error) {
      logEvent(`not moving ${bundle.name}: the drive of ${destination.directory} is not available`, 'warning');
      return;
    }

    // Out of the queue first (no file is touched for a completed bundle): a finished bundle
    // whose files are gone fails to load at the next start
    try {
      await socket.post(`queue/bundles/${bundleId}/remove`, { remove_finished: false });
    } catch (error) {
      logEvent(`not moving ${bundle.name}: could not remove it from the queue (${errorText(error)})`, 'warning');
      return;
    }

    pending[releasePath] = { source: releasePath, directory: destination.directory, name: bundle.name, attempts: 0, since: now(), nextAt: now() };
    savePending();
    await attemptMove(releasePath);
  };

  const enqueue = (job) => {
    chain = chain.then(job).catch((error) => socket.logger.error(`Sorting failed: ${errorText(error)}`));
    return chain;
  };

  const processPending = () => enqueue(async () => {
    for (const key of Object.keys(pending)) {
      if (pending[key] && pending[key].nextAt <= now()) {
        await attemptMove(key);
      }
    }
  });

  const schedule = (bundleId) => {
    if (stopped || scheduled.has(bundleId)) {
      return;
    }

    scheduled.set(bundleId, setTimeout(() => {
      scheduled.delete(bundleId);
      enqueue(() => sortBundle(bundleId));
    }, settings.getValue('settle_seconds') * 1000));
  };

  const onBundleStatus = (bundle) => {
    try {
      if (bundle && bundle.status && bundle.status.completed) {
        schedule(bundle.id);
      }
    } catch (error) {
      socket.logger.error(`queue_bundle_status handler failed: ${errorText(error)}`);
    }
  };

  // A move cut short by a stop or crash leaves "<name>.sorter-partial" at its destination while
  // the original is still complete: remove the partial copy, the retry starts over
  // One at a time, each on its own: a destination that cannot even be looked at (permissions changed,
  // a share with other credentials) threw out of the start, and the sorter died at every start for as
  // long as that move was pending. Now it is logged and the rest are cleaned; the retry reports it.
  const cleanPartials = async () => {
    for (const entry of Object.values(pending)) {
      try {
        const partial = path.join(entry.directory, path.basename(entry.source)) + PARTIAL_SUFFIX;
        if (await exists(partial) && await exists(entry.source)) {
          await fsp.rm(partial, { recursive: true, force: true }).catch((error) => socket.logger.error(`Could not remove ${partial}: ${errorText(error)}`));
        }
      } catch (error) {
        socket.logger.error(`Could not check for a partial copy of ${entry.source}: ${errorText(error)}`);
      }
    }
  };

  extension.onStart = async () => {
    settings.onValuesUpdated = (updated) => {
      if ('custom_rules' in updated) {
        const { errors } = currentRules();
        if (errors.length > 0) {
          logEvent(`ignoring part of the own rules: ${errors.join('; ')}`, 'warning');
        }
      }
    };

    await settings.load();
    loadPending();
    await cleanPartials();

    try {
      const values = await socket.post('settings/get', { keys: [ 'download_directory' ] });
      clientDownloadDir = values.download_directory || '';
    } catch (error) {
      socket.logger.error(`Could not read the download folder: ${errorText(error)}`);
    }

    await socket.addListener('queue', 'queue_bundle_status', onBundleStatus);

    // Downloads that finished while the extension was not running
    try {
      const bundles = await socket.get('queue/bundles/0/100000');
      bundles.filter((b) => b.status && b.status.completed).forEach((b) => schedule(b.id));
    } catch (error) {
      socket.logger.error(`Could not read the queue: ${errorText(error)}`);
    }

    processPending();
    pendingTimer = setInterval(processPending, PENDING_CHECK_MS);
  };

  extension.onStop = () => {
    stopped = true;
    clearInterval(pendingTimer);
    for (const timer of scheduled.values()) {
      clearTimeout(timer);
    }

    scheduled.clear();
  };

  // For the tests
  return { sortBundle, processPending, getPending: () => pending, loadPending, cleanPartials, idle: () => chain };
};
