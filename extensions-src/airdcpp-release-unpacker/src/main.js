'use strict';

// Unpacks finished RAR / ZIP / 7z releases so the media server can play them.
//
// Triggers: a finished directory bundle (the queue_bundle_status EVENT, never a hook), the
// "Unpack release" menu item (queue bundles, and folders of your own share in its file list),
// and the /unpack chat command.
//
// One release at a time, from a queue kept in unpack-state.json. The client ends extensions
// with TerminateProcess on Windows, so the file is written at every step: every temporary
// folder is recorded BEFORE it is created, every file moved into the release is recorded BEFORE
// it is moved. A new start removes the temporary folders of the interrupted run (and only those)
// and runs that release again from the start.
//
// Files are unpacked into a hidden ".unpacking-<id>-<n>" folder beside the output, checked
// (size and CRC-32 of every file against the archive), and only then moved to their real names,
// without ever replacing a file that exists.

const fs = require('fs');
const path = require('path');

const SettingsManager = require('airdcpp-extension-settings');

const { SettingDefinitions } = require('./settings');
const { detectSets, parseSfv, missingFromSfv, parsePatterns, isExcluded, SAMPLE_FOLDER, SKIPPED_FOLDER } = require('./sets');
const { planSet, safeRelativePath, hasRoom, formatBytes } = require('./plan');
const { createRunner, defaultVendor } = require('./runner');
const { recycleFiles } = require('./recycle');

const CONFIG_VERSION = 1;
const STATE_FILE = 'unpack-state.json';
const WORK_PREFIX = '.unpacking-';
const NESTED_DIR = '.nested';
const HANDLED_LIMIT = 500;
const MAX_ATTEMPTS = 3;
const MAX_SETS_PER_RELEASE = 60; // a season pack in episode folders is fine; a whole drive is not
const MENU_ITEM_ID = 'unpack_release';
const HELP = '/unpack <folder>: unpack the archives of a release folder; /unpack: what is queued (airdcpp-release-unpacker)';

const errorText = (error) => (error && (error.message || error.code)) || String(error);
const stripSeparator = (p) => String(p).replace(/[\\/]+$/, '');
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

module.exports = function (socket, extension, options = {}) {
  const settings = SettingsManager(socket, {
    extensionName: extension.name,
    configFile: extension.configPath + 'config.json',
    configVersion: CONFIG_VERSION,
    definitions: SettingDefinitions,
  });

  const now = options.now || (() => Date.now());
  const recycle = options.recycle || ((paths) => recycleFiles(paths, extension.configPath || undefined));
  let runner = options.runner || null;

  const statePathOf = () => path.join(extension.configPath || '.', STATE_FILE);
  let state = { queue: [], active: null, handled: {}, lastSeen: 0, nextId: 1 };
  let busy = null; // the promise of the release being unpacked
  let stopped = false;
  let myCid = null;
  let progress = null; // { name, bytes } of the running unpack, for /unpack
  const scheduled = new Map(); // bundle id -> timer

  // ------------------------------------------------------------------------------------------
  // State

  const loadState = () => {
    try {
      const data = JSON.parse(fs.readFileSync(statePathOf(), 'utf8'));
      state = {
        queue: Array.isArray(data.queue) ? data.queue : [],
        active: data.active && typeof data.active === 'object' ? data.active : null,
        handled: data.handled && typeof data.handled === 'object' ? data.handled : {},
        lastSeen: typeof data.lastSeen === 'number' ? data.lastSeen : 0,
        nextId: typeof data.nextId === 'number' ? data.nextId : 1,
      };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        socket.logger.error(`Could not read ${STATE_FILE}, starting empty: ${errorText(error)}`);
      }
    }
  };

  const saveState = () => {
    try {
      const tmp = `${statePathOf()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...state }, null, 2));
      fs.renameSync(tmp, statePathOf());
    } catch (error) {
      socket.logger.error(`Could not save ${STATE_FILE}: ${errorText(error)}`);
    }
  };

  // A temporary folder of a job: removed only when it was recorded for that job AND carries that
  // job's name (".unpacking-<job id>-<n>"); anything else recorded by mistake stays
  const removeWorkDir = (job, workDir) => {
    const base = path.basename(workDir);
    if (!/^\.unpacking-\d+-\d+$/.test(base) || !base.startsWith(`${WORK_PREFIX}${job.id}-`) || !path.isAbsolute(workDir)) {
      socket.logger.error(`Not removing ${workDir}: not a folder of this extension`);
      return;
    }

    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (error) {
      socket.logger.error(`Could not remove ${workDir}: ${errorText(error)}`);
    }
  };

  const recoverInterrupted = () => {
    const job = state.active;
    if (!job) return;
    for (const workDir of job.workDirs || []) {
      removeWorkDir(job, workDir);
    }

    job.workDirs = [];
    state.active = null;
    // A release that ended its run every time (a decoder that never finishes on it, or a crash)
    // must not block the queue for good
    job.attempts = (job.attempts || 0) + 1;
    if (job.attempts > MAX_ATTEMPTS) {
      saveState();
      logEvent(`${job.name}: given up after ${MAX_ATTEMPTS} interrupted attempts; unpack it by hand if needed`, 'error');
      return;
    }

    state.queue = [ job, ...state.queue.filter((j) => !samePath(j.dir, job.dir)) ];
    saveState();
    socket.logger.info(`Resuming the interrupted unpack of ${job.name}`);
  };

  // ------------------------------------------------------------------------------------------
  // Reporting

  const logEvent = (text, severity = 'info') => {
    if (severity === 'error') socket.logger.error(text); else socket.logger.info(text);
    socket.post('events', { text: `${extension.name}: ${text}`, severity })
      .catch((error) => socket.logger.error(`Could not post an event message: ${errorText(error)}`));
  };

  // ------------------------------------------------------------------------------------------
  // Settings

  const currentOptions = () => ({
    unpackStored: !!settings.getValue('unpack_stored'),
    mediaOnly: !!settings.getValue('media_only'),
    nested: !!settings.getValue('nested_archives'),
    includeSamples: !!settings.getValue('include_samples'),
    deleteArchives: !!settings.getValue('delete_archives'),
    marginGiB: Number(settings.getValue('free_space_margin_gib')) || 0,
    targetDirectory: stripSeparator(settings.getValue('target_directory') || ''),
    excludes: parsePatterns(settings.getValue('exclude_patterns')),
  });

  // ------------------------------------------------------------------------------------------
  // Queue

  const enqueue = ({ dir, source, bundleId = null }) => {
    const clean = stripSeparator(dir);
    if (!path.isAbsolute(clean)) {
      return { added: false, why: 'not a full path' };
    }

    // A drive or share root is no release folder
    if (samePath(path.parse(clean + path.sep).root, clean + path.sep)) {
      return { added: false, why: 'a whole drive is not a release folder' };
    }

    if ((state.active && samePath(state.active.dir, clean)) || state.queue.some((j) => samePath(j.dir, clean))) {
      return { added: false, why: 'already queued' };
    }

    const job = { id: state.nextId++, dir: clean, name: path.basename(clean), source, bundleId, addedAt: now(), workDirs: [], committed: [] };
    state.queue.push(job);
    saveState();
    pump();
    return { added: true, job };
  };

  const pump = () => {
    if (busy || stopped || state.queue.length === 0) return;
    const job = state.queue.shift();
    state.active = job;
    saveState();
    busy = processJob(job)
      .catch((error) => logEvent(`unpacking ${job.name} failed: ${errorText(error)}`, 'error'))
      .finally(() => {
        progress = null;
        if (stopped) return; // interrupted: the state keeps it active for the next start
        state.active = null;
        if (job.bundleId !== null && job.bundleId !== undefined) markHandled(job.bundleId);
        saveState();
        busy = null;
        setImmediate(pump);
      });
  };

  const markHandled = (bundleId) => {
    state.handled[bundleId] = now();
    const keys = Object.keys(state.handled);
    if (keys.length > HANDLED_LIMIT) {
      keys.sort((a, b) => state.handled[a] - state.handled[b]).slice(0, keys.length - HANDLED_LIMIT).forEach((k) => delete state.handled[k]);
    }
  };

  // ------------------------------------------------------------------------------------------
  // One release

  const listDir = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      return null;
    }
  };

  // The release folder and its direct sub folders (CD1, CD2, Subs), without samples (unless
  // asked), proofs and our own temporary folders
  const foldersOf = (dir, opts) => {
    const folders = [ dir ];
    for (const entry of listDir(dir) || []) {
      if (!entry.isDirectory() || entry.name.startsWith(WORK_PREFIX)) continue;
      if (SKIPPED_FOLDER.test(entry.name)) continue;
      if (SAMPLE_FOLDER.test(entry.name) && !opts.includeSamples) continue;
      folders.push(path.join(dir, entry.name));
    }

    return folders;
  };

  const exists = (p) => {
    try {
      fs.lstatSync(p);
      return true;
    } catch (error) {
      return false;
    }
  };

  // Free bytes where the output goes, asked from the client (filesystem/disk_info); the nearest
  // folder that exists stands in for one not made yet
  const freeSpaceAt = async (dir) => {
    let probe = dir;
    while (!exists(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    const infos = await socket.post('filesystem/disk_info', { paths: [ probe ] });
    const info = Array.isArray(infos) ? infos[0] : null;
    return info && typeof info.free_space === 'number' ? info.free_space : -1;
  };

  // Moves one verified file to its real name; never replaces anything. A hard link fails if
  // the name is taken (no race); where links are not possible (FAT, some network shares) the
  // existence check right before the rename has to do.
  const commitFile = (from, to) => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
      fs.linkSync(from, to);
      fs.unlinkSync(from);
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') return false;
    }

    if (exists(to)) return false;
    fs.renameSync(from, to);
    return true;
  };

  const hideFolder = (dir) => {
    if (process.platform !== 'win32') return;
    // The share skips hidden folders (SharePathValidator.cpp:227 unless "share hidden" is on),
    // so half-written files are not hashed. Best effort.
    try {
      require('child_process').execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'attrib.exe'), [ '+h', dir ], { windowsHide: true }, () => {});
    } catch (error) {
      // only cosmetic
    }
  };

  // A thread that runs longer than this is ended (a decoder looping on a malformed archive would
  // otherwise hold the queue until the next restart): listing 10 minutes; unpacking 15 minutes
  // plus 2 MiB/s for the bytes it writes (a slow USB disk or NAS still fits)
  const timeoutOf = options.timeoutOf || ((data) => (data.op === 'extract'
    ? 15 * 60 * 1000 + Math.ceil((data.files || []).reduce((s, f) => s + (f.size > 0 ? f.size : 0), 0) / (2 * 1024 * 1024)) * 1000
    : 10 * 60 * 1000));

  const runOp = (data, name) => getRunner().run(data, (bytes) => { progress = { name, bytes }; }, timeoutOf(data));

  const reasonText = (error) => {
    switch (error && error.reason) {
      case 'encrypted': return 'it is password protected';
      case 'missing_volume': return `a volume is missing (${errorText(error)})`;
      case 'damaged': return `it is damaged: ${errorText(error)}`;
      case 'disk_full': return 'the disk became full';
      case 'timeout': return `the decoder did not finish (${errorText(error)})`;
      case 'unsafe_name': return errorText(error);
      default: return errorText(error);
    }
  };

  // Unpacks a group of sets of one folder into outDir: a RAR set alone, or (with nested archives
  // on) all the zip/7z sets of the folder together, because old releases split one RAR set over
  // several zips. Returns the outcomes for the summary.
  const unpackGroup = async (job, sets, folder, outDir, opts) => {
    const outcomes = [];
    const planned = [];
    for (const set of sets) {
      const label = path.relative(job.dir, path.join(folder, set.first)) || set.first;
      let listing;
      try {
        listing = await runOp({ op: 'list', kind: set.kind, dir: folder, first: set.first }, label);
      } catch (error) {
        if (error.reason === 'stopped') throw error;
        outcomes.push({ status: 'skipped', label, why: reasonText(error) });
        continue;
      }

      const plan = planSet(set.kind, listing, opts);
      if (plan.action === 'skip') {
        outcomes.push({ status: 'skipped', label, why: plan.reason, quiet: plan.quiet });
        continue;
      }

      planned.push({ set, plan, label });
    }

    if (planned.length === 0) return outcomes;
    const label = planned.length === 1 ? planned[0].label : `${planned[0].label} + ${planned.length - 1} more`;

    // Files that exist already are left alone: never overwritten
    const conflicts = [];
    let alreadyDone = 0;
    let needed = 0;
    for (const p of planned) {
      p.wanted = [];
      for (const f of p.plan.files) {
        const final = path.join(outDir, safeRelativePath(f.name));
        if (exists(final)) {
          // Moved there by this job before an interruption: done, not a conflict
          if (job.committed.some((c) => samePath(c, final))) alreadyDone++;
          else conflicts.push(path.relative(outDir, final));
          continue;
        }

        p.wanted.push(f);
      }

      // RAR unpacks only the wanted entries; 7-Zip unpacks the whole archive
      needed += (p.set.kind === 'rar' ? p.wanted : (p.wanted.length ? p.plan.files : [])).reduce((s, f) => s + f.size, 0);
    }

    const todo = planned.filter((p) => p.wanted.length > 0);
    if (todo.length === 0) {
      outcomes.push(conflicts.length
        ? { status: 'skipped', label, why: `every file exists already (${conflicts.slice(0, 3).join(', ')})` }
        : { status: 'unpacked', label, files: alreadyDone, bytes: 0, conflicts, complete: true, volumes: volumesOf(planned, folder) });
      return outcomes;
    }

    let free;
    try {
      free = await freeSpaceAt(outDir);
    } catch (error) {
      outcomes.push({ status: 'skipped', label, why: `the free space could not be read (${errorText(error)})` });
      return outcomes;
    }

    if (!hasRoom(free, needed, opts.marginGiB)) {
      outcomes.push({ status: 'skipped', label, why: `not enough free space: ${formatBytes(needed)} needed + ${opts.marginGiB} GiB margin, ${free >= 0 ? formatBytes(free) : 'unknown'} free` });
      return outcomes;
    }

    fs.mkdirSync(outDir, { recursive: true });
    const workDir = path.join(outDir, `${WORK_PREFIX}${job.id}-${job.workDirs.length + 1}`);
    job.workDirs.push(workDir);
    saveState(); // recorded before it exists
    fs.mkdirSync(workDir); // not recursive: an existing folder of that name is never adopted
    hideFolder(workDir);

    const committedNow = [];
    try {
      let outputs = [];
      let n = 0;
      for (const p of todo) {
        // Each archive into its own folder: old zips all carry the same file_id.diz
        const dest = path.join(workDir, String(++n));
        fs.mkdirSync(dest);
        const extracted = await runOp({ op: 'extract', kind: p.set.kind, dir: folder, first: p.set.first, outDir: dest, files: p.wanted }, label);
        outputs.push(...extracted.results.map((r) => ({ from: path.join(dest, r.rel), rel: r.rel, size: r.size })));
      }

      if (opts.nested) {
        outputs = await unpackNested(workDir, outputs, opts, label);
      }

      // The same name from two archives: the first one is kept
      const seen = new Set();
      let bytes = 0;
      for (const out of outputs) {
        const key = out.rel.toLowerCase();
        if (seen.has(key)) {
          socket.logger.verbose(`${label}: ${out.rel} comes from more than one archive; the first one is kept`);
          conflicts.push(out.rel);
          continue;
        }

        seen.add(key);
        const final = path.join(outDir, out.rel);
        job.committed.push(final);
        saveState(); // recorded before the move
        if (commitFile(out.from, final)) {
          committedNow.push(final);
          bytes += out.size;
        } else {
          job.committed.pop();
          conflicts.push(out.rel);
        }
      }

      saveState();
      outcomes.push({
        status: 'unpacked', label, files: committedNow.length + alreadyDone, bytes, conflicts,
        complete: conflicts.length === 0 && todo.length === planned.length,
        volumes: volumesOf(planned, folder),
      });
    } catch (error) {
      if (error.reason === 'stopped') throw error;
      outcomes.push({ status: 'failed', label, why: reasonText(error), kept: committedNow.length });
    } finally {
      if (!stopped) {
        removeWorkDir(job, workDir);
        job.workDirs = job.workDirs.filter((w) => w !== workDir);
        saveState();
      }
    }

    return outcomes;
  };

  const volumesOf = (planned, folder) => planned.flatMap((p) => p.set.volumes.map((v) => path.join(folder, v)));

  // Archives inside the unpacked files (one level): their volumes are gathered in one folder of
  // the temporary folder and unpacked there too; only their contents reach the release, the
  // inner archives themselves never do
  const unpackNested = async (workDir, outputs, opts, label) => {
    const topLevel = outputs.filter((o) => !o.rel.includes(path.sep));
    const inner = detectSets(topLevel.map((o) => o.rel)).filter((s) => s.first && s.missing.length === 0);
    if (inner.length === 0) return outputs;

    const gather = path.join(workDir, NESTED_DIR);
    fs.mkdirSync(gather);
    const byName = new Map(topLevel.map((o) => [ o.rel.toLowerCase(), o ]));
    const consumed = new Set();
    const result = [];
    let n = 0;
    for (const set of inner) {
      // Together in one folder, as the decoder finds the next volume beside the first
      for (const v of set.volumes) {
        const o = byName.get(v.toLowerCase());
        const to = path.join(gather, v);
        if (o && !exists(to)) {
          fs.renameSync(o.from, to);
          o.from = to;
        }
      }

      let listing;
      try {
        listing = await runOp({ op: 'list', kind: set.kind, dir: gather, first: set.first }, label);
      } catch (error) {
        if (error.reason === 'stopped') throw error;
        socket.logger.info(`${label}: inner archive ${set.first} left packed: ${reasonText(error)}`);
        continue;
      }

      // An inner set is unpacked even when stored: inside the temporary folder nothing plays it
      const plan = planSet(set.kind, listing, { ...opts, unpackStored: true, nested: false });
      if (plan.action === 'skip') {
        socket.logger.info(`${label}: inner archive ${set.first} left packed: ${plan.reason}`);
        continue;
      }

      const free = await freeSpaceAt(workDir);
      if (!hasRoom(free, plan.bytes, opts.marginGiB)) {
        const e = new Error(`not enough free space for the inner archive ${set.first}`);
        e.reason = 'disk_full';
        throw e;
      }

      const dest = path.join(gather, `${WORK_PREFIX}out-${++n}`);
      fs.mkdirSync(dest);
      const extracted = await runOp({ op: 'extract', kind: set.kind, dir: gather, first: set.first, outDir: dest, files: plan.files }, label);
      set.volumes.forEach((v) => consumed.add(v.toLowerCase()));
      for (const r of extracted.results) {
        result.push({ from: path.join(dest, r.rel), rel: r.rel, size: r.size });
      }
    }

    // The outer files that were not volumes of an unpacked inner set stay (an nfo beside them)
    return [ ...outputs.filter((o) => o.rel.includes(path.sep) || !consumed.has(o.rel.toLowerCase())), ...result ];
  };

  const processJob = async (job) => {
    const opts = currentOptions();
    const manual = job.source !== 'bundle';
    const say = (text, severity) => {
      if (manual || severity !== 'quiet') logEvent(text, severity === 'quiet' ? 'info' : severity);
      // info, not verbose: the logger drops verbose unless the extension runs with --debug, and a
      // quiet skip must still be findable in output.log (live test 2026-10-18)
      else socket.logger.info(text);
    };

    if (!listDir(job.dir)) {
      say(`${job.name}: the folder ${job.dir} is not there (any more)`, 'warning');
      return;
    }

    if (isExcluded(job.dir, opts.excludes)) {
      say(`${job.name}: excluded by the setting, not unpacked`, 'quiet');
      return;
    }

    if (opts.targetDirectory && (isInside(opts.targetDirectory, job.dir) || samePath(opts.targetDirectory, job.dir))) {
      say(`${job.name}: the unpack folder is inside this release; not unpacked`, 'warning');
      return;
    }

    const outputBase = opts.targetDirectory ? path.join(opts.targetDirectory, job.name) : job.dir;
    const outcomes = [];
    const plans = []; // [{ folder, groups }]
    let setCount = 0;
    for (const folder of foldersOf(job.dir, opts)) {
      const entries = listDir(folder) || [];
      const names = entries.filter((e) => e.isFile()).map((e) => e.name);
      const sfvNames = [];
      for (const name of names.filter((n) => /\.sfv$/i.test(n))) {
        try {
          sfvNames.push(...parseSfv(fs.readFileSync(path.join(folder, name), 'latin1')));
        } catch (error) {
          // an unreadable SFV only means fewer checks
        }
      }

      const complete = [];
      for (const set of detectSets(names)) {
        setCount++;
        const label = path.relative(job.dir, path.join(folder, set.first || set.volumes[0]));
        const missing = Array.from(new Set([ ...set.missing, ...missingFromSfv(set, sfvNames, names) ]));
        if (missing.length > 0 || !set.first) {
          outcomes.push({ status: 'skipped', label, why: `volumes are missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}` });
          continue;
        }

        complete.push(set);
      }

      // A RAR set alone; zips and 7z together when nested archives are on (see unpackGroup)
      const groups = complete.filter((s) => s.kind === 'rar').map((s) => [ s ]);
      const others = complete.filter((s) => s.kind !== 'rar');
      if (opts.nested && others.length > 0) groups.push(others);
      else others.forEach((s) => groups.push([ s ]));
      plans.push({ folder, groups });
    }

    if (setCount === 0) {
      say(`${job.name}: no archives found`, 'quiet');
      return;
    }

    // A folder full of releases (picked by mistake) is not one release
    if (setCount > MAX_SETS_PER_RELEASE) {
      say(`${job.name}: ${setCount} archive sets in one folder; not unpacked. Pick a release folder.`, 'warning');
      return;
    }

    for (const { folder, groups } of plans) {
      const outDir = path.join(outputBase, path.relative(job.dir, folder));
      for (const group of groups) {
        outcomes.push(...await unpackGroup(job, group, folder, outDir, opts));
        if (stopped) return;
      }
    }

    const unpacked = outcomes.filter((o) => o.status === 'unpacked');

    // Archive volumes go to the Recycle Bin only for sets whose every file is now beside them
    // (or in the unpack folder) and verified; a set with a file left alone keeps its archives
    if (opts.deleteArchives && unpacked.length > 0) {
      await removeArchives(job, unpacked.filter((o) => o.complete && o.volumes));
    }

    if (unpacked.length > 0) {
      try {
        await socket.post('share/refresh/paths', { paths: [ outputBase + path.sep ] });
      } catch (error) {
        // 417 and friends: not inside a share root, nothing to refresh
        socket.logger.verbose(`No share refresh for ${outputBase}: ${errorText(error)}`);
      }
    }

    for (const o of outcomes) {
      if (o.status === 'unpacked') {
        const target = samePath(outputBase, job.dir) ? '' : ` into ${outputBase}`;
        logEvent(`unpacked ${job.name}: ${o.label}, ${o.files} file(s), ${formatBytes(o.bytes)}${target}`);
        if (o.conflicts.length > 0) {
          logEvent(`${job.name}: ${o.conflicts.length} file(s) existed already and were left alone: ${o.conflicts.slice(0, 5).join(', ')}`, 'warning');
        }
      } else if (o.status === 'skipped') {
        say(`${job.name}: ${o.label} not unpacked, ${o.why}`, o.quiet ? 'quiet' : 'warning');
      } else {
        const kept = o.kept ? `${o.kept} verified file(s) were already in place and stay` : 'nothing of it was kept';
        logEvent(`${job.name}: unpacking ${o.label} failed, ${o.why}; ${kept}`, 'error');
      }
    }
  };

  const removeArchives = async (job, sets) => {
    const volumes = sets.flatMap((s) => s.volumes).filter((v) => isInside(v, job.dir) && exists(v));
    if (volumes.length === 0) return;

    // A finished bundle whose files are gone fails to load at the next start: out of the queue
    // first (remove_finished:false touches no file). The queue is read again NOW, never trusted
    // from when the job was queued: a finished download can go back to downloading meanwhile
    // (more files added to its folder, a recheck), and removing a bundle that still has queued
    // files deletes their partial .dctmp files (QueueManager::removeBundle). Every download of
    // this folder, of a folder inside it, or of a folder it is in counts.
    let related;
    try {
      const bundles = await socket.get('queue/bundles/0/100000');
      related = (bundles || []).filter((b) => {
        if (typeof b.target !== 'string') return false;
        const target = stripSeparator(b.target);
        return samePath(target, job.dir) || isInside(target, job.dir) || isInside(job.dir, target);
      });
    } catch (error) {
      logEvent(`${job.name}: archives kept, the queue could not be read (${errorText(error)})`, 'warning');
      return;
    }

    if (related.some((b) => !(b.status && b.status.downloaded === true && b.status.id !== 'recheck'))) {
      logEvent(`${job.name}: archives kept, it is still downloading`, 'warning');
      return;
    }

    for (const b of related) {
      try {
        await socket.post(`queue/bundles/${b.id}/remove`, { remove_finished: false });
      } catch (error) {
        const gone = error && (error.code === 404 || /not found/i.test(String(error.message || '')));
        if (!gone) {
          logEvent(`${job.name}: archives kept, the download could not be taken out of the queue (${errorText(error)})`, 'warning');
          return;
        }
      }
    }

    const results = await recycle(volumes);
    const done = results.filter((r) => r.ok).length;
    const kept = results.filter((r) => !r.ok);
    logEvent(`${job.name}: ${done} archive volume(s) moved to the Recycle Bin`);
    if (kept.length > 0) {
      logEvent(`${job.name}: ${kept.length} archive volume(s) kept: ${kept.slice(0, 3).map((r) => `${path.basename(r.path)} (${r.why})`).join(', ')}`, 'warning');
    }
  };

  // ------------------------------------------------------------------------------------------
  // Triggers

  const isFinishedDirectoryBundle = (bundle) => !!bundle && !!bundle.status && bundle.status.completed === true
    && bundle.status.failed !== true && !!bundle.type && bundle.type.id === 'directory' && typeof bundle.target === 'string';

  const onBundleFinished = async (bundleId) => {
    if (!settings.getValue('auto_unpack') || state.handled[bundleId]) return;
    let bundle;
    try {
      bundle = await socket.get(`queue/bundles/${bundleId}`);
    } catch (error) {
      return; // removed meanwhile
    }

    if (!isFinishedDirectoryBundle(bundle)) return;
    markHandled(bundleId);
    saveState();
    enqueue({ dir: bundle.target, source: 'bundle', bundleId });
  };

  const scheduleBundle = (bundleId) => {
    if (stopped || scheduled.has(bundleId) || state.handled[bundleId]) return;
    const timer = setTimeout(() => {
      scheduled.delete(bundleId);
      onBundleFinished(bundleId).catch((error) => socket.logger.error(`Bundle ${bundleId}: ${errorText(error)}`));
    }, settings.getValue('settle_seconds') * 1000);
    if (timer && typeof timer.unref === 'function') timer.unref();
    scheduled.set(bundleId, timer);
  };

  const onBundleStatus = (bundle) => {
    if (isFinishedDirectoryBundle(bundle) && settings.getValue('auto_unpack')) {
      scheduleBundle(bundle.id);
    }
  };

  // Manual: the folder of a queued download
  const unpackBundles = async (ids) => {
    for (const id of ids) {
      try {
        const bundle = await socket.get(`queue/bundles/${id}`);
        if (!bundle || !bundle.type || bundle.type.id !== 'directory') {
          logEvent(`${(bundle && bundle.name) || id}: only folder downloads can be unpacked`, 'warning');
          continue;
        }

        if (!bundle.status || !bundle.status.downloaded) {
          logEvent(`${bundle.name}: not unpacked, it has not finished downloading`, 'warning');
          continue;
        }

        const r = enqueue({ dir: bundle.target, source: 'manual', bundleId: bundle.id });
        if (!r.added) logEvent(`${bundle.name}: ${r.why}`);
      } catch (error) {
        logEvent(`Could not read download ${id}: ${errorText(error)}`, 'warning');
      }
    }
  };

  // Manual: a folder of the own share, picked in its file list
  const unpackOwnListItems = async (cid, ids) => {
    if (!myCid || cid !== myCid) {
      logEvent('"Unpack release" works in your own share\'s file list only', 'warning');
      return;
    }

    for (const id of ids) {
      try {
        const item = await socket.get(`filelists/${cid}/items/${id}`);
        if (!item || !item.type || item.type.id !== 'directory') {
          logEvent(`${(item && item.name) || id}: pick a folder to unpack`, 'warning');
          continue;
        }

        const paths = await socket.post('share/find_dupe_paths', { path: item.path });
        if (!Array.isArray(paths) || paths.length === 0) {
          logEvent(`${item.name}: its folder on disk was not found`, 'warning');
          continue;
        }

        for (const p of paths) {
          const r = enqueue({ dir: p, source: 'manual' });
          if (!r.added) logEvent(`${item.name}: ${r.why}`);
        }
      } catch (error) {
        logEvent(`Could not read the file list item ${id}: ${errorText(error)}`, 'warning');
      }
    }
  };

  const statusText = () => {
    const lines = [];
    if (state.active) {
      const p = progress && progress.bytes ? ` (${formatBytes(progress.bytes)} written)` : '';
      lines.push(`[unpack] unpacking ${state.active.name}${p}`);
    }

    if (state.queue.length) {
      lines.push(`[unpack] waiting: ${state.queue.map((j) => j.name).join(', ')}`);
    }

    return lines.length ? lines.join('\n') : '[unpack] nothing queued';
  };

  const reply = async (base, sessionId, text, owner) => {
    for (const line of text.split('\n')) {
      await socket.post(`${base}/${sessionId}/status_message`, { text: line, severity: 'info', ...(owner ? { owner } : {}) });
    }
  };

  const onTextCommand = (base) => async (data, sessionId) => {
    if (!data || !data.command) return;
    const command = String(data.command).toLowerCase();
    if (command === 'help') {
      await reply(base, sessionId, HELP, data.owner);
      return;
    }

    if (command !== 'unpack') return;
    const arg = (data.args || []).join(' ').trim().replace(/^"(.*)"$/, '$1');
    if (!arg) {
      await reply(base, sessionId, statusText(), data.owner);
      return;
    }

    if (!path.isAbsolute(arg) || !listDir(arg)) {
      await reply(base, sessionId, '[unpack] give the full path of an existing folder: /unpack D:\\Downloads\\Release.Name', data.owner);
      return;
    }

    const r = enqueue({ dir: arg, source: 'manual' });
    await reply(base, sessionId, r.added ? `[unpack] queued ${r.job.name}; the event log gets the result` : `[unpack] ${r.why}`, data.owner);
  };

  // ------------------------------------------------------------------------------------------
  // Menus. The client asks for menu items through a hook: answered at once from memory (no
  // request inside), so a menu never waits. A missed answer only means no menu item.

  const subscriberInfo = () => ({ id: extension.name, name: 'Release unpacker' });

  const addMenu = async (menuId, isWanted, onSelect) => {
    await socket.addHook('menus', `${menuId}_list_menuitems`, (data, accept) => {
      try {
        accept({ menuitems: isWanted(data) ? [ { id: MENU_ITEM_ID, title: 'Unpack release' } ] : [] });
      } catch (error) {
        socket.logger.error(`${menuId} menu: ${errorText(error)}`);
      }
    }, subscriberInfo());

    await socket.addListener('menus', `${menuId}_menuitem_selected`, (data) => {
      if (!data || data.hook_id !== subscriberInfo().id || data.menuitem_id !== MENU_ITEM_ID) return;
      Promise.resolve()
        .then(() => onSelect(data))
        .catch((error) => socket.logger.error(`${menuId} menu item: ${errorText(error)}`));
    });
  };

  const guarded = (name, handler) => async (...args) => {
    try {
      await handler(...args);
    } catch (error) {
      socket.logger.error(`${name} failed: ${errorText(error)}`);
    }
  };

  const getRunner = () => {
    if (!runner) {
      const workerFile = options.workerFile || path.join(__dirname, 'index.js');
      runner = createRunner({ workerFile, vendor: options.vendor || defaultVendor(path.dirname(workerFile)) });
    }

    return runner;
  };

  extension.onStart = async () => {
    await settings.load();
    loadState();
    recoverInterrupted();

    try {
      const info = await socket.get('system/system_info');
      myCid = (info && info.cid) || null;
    } catch (error) {
      socket.logger.error(`Could not read the own CID: ${errorText(error)}`);
    }

    await socket.addListener('queue', 'queue_bundle_status', guarded('queue_bundle_status', onBundleStatus));
    await socket.addListener('hubs', 'hub_text_command', guarded('hub_text_command', onTextCommand('hubs')));
    await socket.addListener('private_chat', 'private_chat_text_command', guarded('private_chat_text_command', onTextCommand('private_chat')));

    try {
      await addMenu('queue_bundle', () => true, (data) => unpackBundles(data.selected_ids || []));
      await addMenu('filelist_item', (data) => !!myCid && data.entity_id === myCid, (data) => unpackOwnListItems(data.entity_id, data.selected_ids || []));
    } catch (error) {
      socket.logger.error(`Could not add the menu items: ${errorText(error)}`);
    }

    // Downloads that finished while the extension was not running. Never on the first run:
    // installing it does not unpack every finished download still in the queue.
    const since = state.lastSeen;
    state.lastSeen = Math.floor(now() / 1000);
    saveState();
    if (since > 0) {
      try {
        const bundles = await socket.get('queue/bundles/0/100000');
        bundles.filter((b) => isFinishedDirectoryBundle(b) && (b.time_finished || 0) >= since).forEach((b) => scheduleBundle(b.id));
      } catch (error) {
        socket.logger.error(`Could not read the queue: ${errorText(error)}`);
      }
    }

    // lastSeen moves on while running, so a later restart catches up from about then
    const alive = setInterval(() => {
      state.lastSeen = Math.floor(now() / 1000);
      saveState();
    }, 5 * 60 * 1000);
    if (alive && typeof alive.unref === 'function') alive.unref();
    timers.push(alive);

    pump();
  };

  const timers = [];
  extension.onStop = () => {
    stopped = true;
    timers.forEach(clearInterval);
    for (const timer of scheduled.values()) clearTimeout(timer);
    scheduled.clear();
    if (runner) runner.stopAll();
  };

  // For the tests
  return {
    enqueue, onBundleStatus, onBundleFinished, onTextCommand, unpackBundles, unpackOwnListItems,
    idle: async () => {
      while (!stopped && (busy || state.queue.length > 0)) {
        if (busy) await busy; else await new Promise((resolve) => setImmediate(resolve));
      }
    },
    getState: () => state, loadState, recoverInterrupted, statusText,
  };
};
