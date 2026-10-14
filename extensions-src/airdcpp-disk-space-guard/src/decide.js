'use strict';

// The whole policy as one pure function: given the queue, the free space per folder and what
// this extension paused (or handed back to the user) earlier, decide what to pause, resume,
// forget and release. Covered by the unit tests without a client.

const GIB = 1024 * 1024 * 1024;

// Priority ids as the Web API serializes them (core/types/Priority.h)
const PRIORITY_PAUSED_FORCE = 0;
const PRIORITY_DEFAULT = -1; // "auto" when sent back

const ACTIVE_STATES = [ 'new', 'queued' ];

// The folder whose drive a bundle fills: a directory bundle's target ends with a separator, a
// file bundle's target is the file itself. Unfinished parts are written next to the target.
const folderOf = (target) => {
  const t = String(target || '');
  if (/[\\/]$/.test(t)) {
    return t;
  }

  const cut = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'));
  return cut >= 0 ? t.slice(0, cut + 1) : t;
};

const isActive = (bundle) => !!bundle && !!bundle.status && !bundle.status.downloaded && ACTIVE_STATES.includes(bundle.status.id);

// A bundle the guard may pause: still downloading, not in a state the core manages itself
// (download_error has its own free-space resume; recheck ignores priority changes), and not
// already force-paused by the user.
const isPausable = (bundle) => isActive(bundle) && !(bundle.priority && bundle.priority.id === PRIORITY_PAUSED_FORCE);

// The priority to send back on resume: auto stays auto, otherwise the exact earlier level
const restorePriority = (saved) =>
  (saved.auto || saved.id === null || saved.id === undefined) ? PRIORITY_DEFAULT : saved.id;

const freeOf = (freeByFolder, bundle) => {
  const free = freeByFolder.get(folderOf(bundle.target));
  return (free === undefined || free < 0) ? null : free;
};

// bundles: API bundle list; freeByFolder: Map(folder -> free bytes, -1 when unknown);
// paused: { [id]: { id, auto, name } } saved when the guard paused it;
// released: { [id]: true } bundles the user took back while their drive was low;
// minFreeGiB / resumeMarginGiB: settings.
const decide = ({ bundles, freeByFolder, paused, released = {}, minFreeGiB, resumeMarginGiB }) => {
  const pauseBelow = minFreeGiB * GIB;
  const resumeAt = (minFreeGiB + resumeMarginGiB) * GIB;
  const byId = new Map(bundles.map((b) => [ String(b.id), b ]));

  const pause = [];    // { id, name, free, saved } - saved is the record to keep
  const resume = [];   // { id, name, priority }
  const forget = [];   // ids dropped from paused
  const release = [];  // ids added to released
  const unrelease = []; // ids dropped from released

  for (const [ id, saved ] of Object.entries(paused)) {
    const bundle = byId.get(id);
    if (!bundle || bundle.status.downloaded) {
      forget.push(id);
      continue;
    }

    // Recheck, download_error, validation: the core owns the bundle for now. A priority sent
    // during a recheck is dropped by the core and the old one restored afterwards, so wait.
    if (!ACTIVE_STATES.includes(bundle.status.id)) {
      continue;
    }

    const free = freeOf(freeByFolder, bundle);
    const priority = bundle.priority || {};

    if (priority.id !== PRIORITY_PAUSED_FORCE) {
      if (!priority.auto) {
        // An explicit priority set by hand: the user took over. Not paused again while the
        // drive stays low, or the guard would undo the choice within one round.
        forget.push(id);
        release.push(id);
        continue;
      }

      // Back on auto without the user picking a level: the core's own error resume sets
      // DEFAULT. Still ours: pause again while low (keeping the original record), or restore
      // the original priority once there is room.
      if (free === null) {
        continue;
      }

      if (free < resumeAt) {
        pause.push({ id, name: bundle.name, free, saved });
      } else {
        resume.push({ id, name: bundle.name, priority: restorePriority(saved) });
      }

      continue;
    }

    if (free !== null && free >= resumeAt) {
      resume.push({ id, name: bundle.name, priority: restorePriority(saved) });
    }
  }

  for (const id of Object.keys(released)) {
    const bundle = byId.get(id);
    const free = bundle ? freeOf(freeByFolder, bundle) : null;
    if (!bundle || bundle.status.downloaded || (free !== null && free >= resumeAt)) {
      unrelease.push(id);
    }
  }

  const releasedNow = new Set([ ...Object.keys(released).filter((id) => !unrelease.includes(id)), ...release ]);
  for (const bundle of bundles) {
    const id = String(bundle.id);
    if (paused[id] || releasedNow.has(id) || !isPausable(bundle)) {
      continue;
    }

    const free = freeOf(freeByFolder, bundle);
    if (free !== null && free < pauseBelow) {
      pause.push({
        id,
        name: bundle.name,
        free,
        saved: { id: bundle.priority ? bundle.priority.id : null, auto: !!(bundle.priority && bundle.priority.auto), name: bundle.name },
      });
    }
  }

  return { pause, resume, forget, release, unrelease };
};

// Folders whose free space is needed this round (one per folder, not per bundle)
const foldersToCheck = (bundles, paused, released = {}) => {
  const folders = new Set();
  for (const bundle of bundles) {
    const id = String(bundle.id);
    if (paused[id] || released[id] || isPausable(bundle)) {
      folders.add(folderOf(bundle.target));
    }
  }

  return Array.from(folders);
};

const formatGiB = (bytes) => `${(bytes / GIB).toFixed(1)} GiB`;

module.exports = {
  decide, foldersToCheck, folderOf, isPausable, restorePriority, formatGiB,
  GIB, PRIORITY_PAUSED_FORCE, PRIORITY_DEFAULT,
};
