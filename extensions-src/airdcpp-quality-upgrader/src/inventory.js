'use strict';

// What is kept now: release folders (and single-file releases) in the share, optionally joined
// with the media library's films and episodes.
//
// The media server never sends a real disk path (JellyfinApi.cpp:6247 "The real path is never
// sent"; an item's Path is "fuldc:/<id>/<file name>", :6295 on origin/master). So the share is
// walked for the real paths, and a library item is joined to its release by its file name.

const fsp = require('fs/promises');
const path = require('path');

const { parseRelease, isSceneRelease, identityKey, resolutionFromSize, stripExtension } = require('./release');

const VIDEO = /\.(mkv|mp4|avi|m4v|ts|wmv|mov|mpg|mpeg|m2ts|webm)$/i;
const RAR = /\.(rar|r\d\d|\d\d\d)$/i;
const MAX_DIRS = 200000;
const YIELD_EVERY = 200;

const normalizeDir = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

const isInside = (child, parent) => {
  const c = normalizeDir(child);
  const p = normalizeDir(parent);
  return c === p || c.startsWith(p + path.sep);
};

const isStrictlyInside = (child, parent) => isInside(child, parent) && normalizeDir(child) !== normalizeDir(parent);

const tick = () => new Promise((resolve) => setImmediate(resolve));

// Walks the share roots, `maxDepth` folders deep, and returns every release found:
// [{ path, name, isFile, parsed, videoFiles: [lowercased file names], root }]
// A release folder is not descended into. Folders in `exclude` (staging, holding) are skipped.
const walkShare = async (roots, { exclude = [], maxDepth = 5, fsImpl = fsp } = {}) => {
  const releases = [];
  const looseVideos = new Set();
  let dirs = 0;
  let truncated = false;

  const visit = async (dir, depth, root) => {
    if (dirs >= MAX_DIRS) {
      truncated = true;
      return;
    }

    dirs++;
    if (dirs % YIELD_EVERY === 0) {
      await tick();
    }

    let entries;
    try {
      entries = await fsImpl.readdir(dir, { withFileTypes: true });
    } catch (error) {
      return; // gone, or no access
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (exclude.some((e) => e && isInside(full, e))) {
        continue;
      }

      if (entry.isDirectory()) {
        const parsed = parseRelease(entry.name);
        if (isSceneRelease(parsed)) {
          let inner = [];
          let hasArchive = false;
          try {
            inner = await fsImpl.readdir(full, { withFileTypes: true });
          } catch (error) {
            inner = [];
          }

          const videoFiles = inner.filter((e) => e.isFile() && VIDEO.test(e.name) && !/(^|[._ -])sample([._ -]|$)/i.test(e.name)).map((e) => e.name.toLowerCase());
          hasArchive = inner.some((e) => e.isFile() && RAR.test(e.name));
          const subdirs = inner.filter((e) => e.isDirectory()).map((e) => e.name);
          releases.push({ path: full, name: entry.name, isFile: false, parsed, videoFiles, hasArchive, subdirs, root });
        } else if (depth < maxDepth) {
          await visit(full, depth + 1, root);
        }
      } else if (entry.isFile() && VIDEO.test(entry.name)) {
        const parsed = parseRelease(entry.name);
        if (isSceneRelease(parsed)) {
          releases.push({ path: full, name: stripExtension(entry.name), isFile: true, parsed, videoFiles: [ entry.name.toLowerCase() ], hasArchive: false, subdirs: [], root });
        } else {
          // A video outside any release (a personal folder): its name makes a join ambiguous
          looseVideos.add(entry.name.toLowerCase());
        }
      }
    }
  };

  for (const root of roots) {
    await visit(root, 0, root);
  }

  return { releases, dirs, truncated, looseVideos };
};

// The library's films and episodes, page by page.
// GET /Users/{u}/Items?Recursive=true&IncludeItemTypes=Movie,Episode — Recursive at
// JellyfinApi.cpp:7414, IncludeItemTypes at :7518, Limit capped at MAX_LIMIT 1000 (:58), the
// recursive walk capped at 20000 (:74). Items carry Name, Path, ProductionYear (:6299),
// ParentIndexNumber (:6313), SeriesName (:6326), UserData (:8474), Width/Height from the probe
// cache (:8481 -> addMediaInfo) and ProviderIds (:5331).
const fetchLibrary = async (jellyfin, { pageSize = 500, maxItems = 20000 } = {}) => {
  const userId = await jellyfin.userId();
  const items = [];
  for (let start = 0; start < maxItems; start += pageSize) {
    const page = await jellyfin.get(`/Users/${encodeURIComponent(userId)}/Items`, {
      Recursive: 'true', IncludeItemTypes: 'Movie,Episode', StartIndex: start, Limit: pageSize, Fields: 'Path,ProviderIds',
    });
    const got = (page && Array.isArray(page.Items)) ? page.Items : [];
    items.push(...got);
    if (got.length < pageSize || (page.TotalRecordCount && items.length >= page.TotalRecordCount)) {
      break;
    }

    await tick();
  }

  return items;
};

const fileNameOfItem = (item) => {
  const p = String(item.Path || '');
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return (slash >= 0 ? p.slice(slash + 1) : p).toLowerCase();
};

const userDataOf = (item) => {
  const d = item && item.UserData;
  if (!d) return null;
  const state = { Played: Boolean(d.Played), PlaybackPositionTicks: Number(d.PlaybackPositionTicks) || 0 };
  return state.Played || state.PlaybackPositionTicks > 0 ? state : null;
};

// Builds the inventory: identity key -> { key, copies: [copy], best: copy }
// copy = { name, parsed, path|null, isFile, jellyfinId|null, providerIds, userData, source }
// mode 'library': only what the media library holds (joined to the share by file name);
// mode 'share': every release in the share.
// looseVideos: names of video files in the share outside any release folder. A library item
// whose file name is also one of those may be that file, so it is not joined to a release.
const buildInventory = ({ releases, libraryItems = null, looseVideos = new Set() }) => {
  const copies = [];

  if (libraryItems) {
    const byFile = new Map();
    for (const r of releases) {
      for (const f of r.videoFiles) {
        const list = byFile.get(f) || [];
        list.push(r);
        byFile.set(f, list);
      }
    }

    const used = new Set();
    for (const item of libraryItems) {
      const fileName = fileNameOfItem(item);
      const matches = fileName ? (byFile.get(fileName) || []) : [];
      // A name found in two releases, or also outside any release, cannot say which one this is
      const release = matches.length === 1 && !looseVideos.has(fileName) ? matches[0] : null;
      const fromName = parseRelease(release ? release.name : (fileName || item.Name || ''));
      const parsed = fromName ? { ...fromName } : null;
      if (!parsed || !parsed.kind) continue;

      const measured = resolutionFromSize(item.Width, item.Height);
      if (measured) {
        parsed.resolution = measured;
      }

      if (release) {
        // One library item per release: a season pack's episodes all point at the pack
        if (used.has(release.path) && release.parsed.kind === 'season') continue;
        used.add(release.path);
      }

      copies.push({
        name: release ? release.name : parsed.name,
        parsed,
        path: release ? release.path : null,
        isFile: release ? release.isFile : true,
        release,
        jellyfinId: item.Id || null,
        providerIds: item.ProviderIds || null,
        userData: userDataOf(item),
        source: 'library',
      });
    }
  } else {
    for (const r of releases) {
      copies.push({ name: r.name, parsed: r.parsed, path: r.path, isFile: r.isFile, release: r, jellyfinId: null, providerIds: null, userData: null, source: 'share' });
    }
  }

  const inventory = new Map();
  for (const copy of copies) {
    const key = identityKey(copy.parsed);
    if (!key) continue;
    const entry = inventory.get(key) || { key, copies: [] };
    if (!entry.copies.some((c) => c.path && c.path === copy.path && c.jellyfinId === copy.jellyfinId)) {
      entry.copies.push(copy);
    }

    inventory.set(key, entry);
  }

  for (const entry of inventory.values()) {
    entry.best = entry.copies.slice().sort((a, b) => ((b.parsed.resolution || 0) - (a.parsed.resolution || 0)) || (b.parsed.properLevel - a.parsed.properLevel))[0];
  }

  return inventory;
};

// Whether the kept copy may be replaced automatically: a single release folder or file in the
// share, shaped like a scene release, not a share root, not a folder holding other releases
const replaceableReason = (entry, shareRoots) => {
  if (!entry || entry.copies.length !== 1) return 'several copies are kept';
  const copy = entry.best;
  if (!copy.path || !copy.release) return 'its folder in the share is not known';
  if (!isSceneRelease(copy.release.parsed)) return 'the folder name is not a release name';
  if (!shareRoots.some((root) => isStrictlyInside(copy.path, root))) return 'not inside a share folder';
  if (copy.release.subdirs && copy.release.subdirs.some((d) => isSceneRelease(parseRelease(d)))) return 'the folder holds other releases';
  if (copy.release.subdirs && copy.release.subdirs.filter((d) => !/^(sample|samples|subs|subtitles|proof|extras|featurettes)$/i.test(d)).length > 0) return 'the folder holds other folders';
  return null;
};

module.exports = { walkShare, fetchLibrary, buildInventory, replaceableReason, isInside, isStrictlyInside, normalizeDir, fileNameOfItem };
