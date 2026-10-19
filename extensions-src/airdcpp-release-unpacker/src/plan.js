'use strict';

// Decides, from an archive's listing, whether to unpack it and what. No I/O.

const path = require('path');

const { isVideoName, isMediaName, detectSets } = require('./sets');

const GIB = 1024 * 1024 * 1024;

// Windows-reserved device names: a file called "con.txt" cannot be created
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

// An entry name from inside an archive, made safe to create under the output folder: both
// separators split, no drive, no "..", no empty or reserved parts, no characters Windows refuses.
// Returns a relative path with the platform separator, or null when nothing safe is left.
const safeRelativePath = (name) => {
  const parts = String(name).split(/[\\/]+/);
  const clean = [];
  for (let part of parts) {
    part = part.replace(/^[a-zA-Z]:$/, '');
    if (!part || part === '.' || part === '..') {
      continue;
    }

    // eslint-disable-next-line no-control-regex
    if (/[<>:"|?*\x00-\x1f]/.test(part) || RESERVED.test(part) || /[. ]$/.test(part)) {
      return null;
    }

    clean.push(part);
  }

  return clean.length ? clean.join(path.sep) : null;
};

// The media server plays a RAR set without unpacking when its video entry is stored: it picks
// the largest STORED video entry (MediaLibrary.cpp probeArchive, :1360-1372 on master). When the
// largest video of all is stored, unpacking would only duplicate it.
const isPlayableAsStored = (kind, entries) => {
  if (kind !== 'rar') {
    return false; // the media server reads no zip or 7z
  }

  const videos = entries.filter((e) => !e.directory && isVideoName(e.name));
  if (videos.length === 0) {
    return false;
  }

  const largest = videos.reduce((a, b) => (b.size > a.size ? b : a));
  return largest.stored === true;
};

const containsArchiveSet = (entries) => detectSets(entries.filter((e) => !e.directory).map((e) => e.name.split(/[\\/]/).pop())).length > 0;

// listing: { encrypted, entries: [{ name, size, crc, stored, encrypted, directory }] }
// options: { unpackStored, mediaOnly, nested }
// Returns { action: 'unpack', files, bytes } or { action: 'skip', reason, quiet }
//   quiet: an automatic run says nothing to the event log for it (nothing went wrong)
const planSet = (kind, listing, options) => {
  const entries = listing.entries || [];
  if (listing.encrypted || entries.some((e) => e.encrypted)) {
    return { action: 'skip', reason: 'it is password protected', quiet: false };
  }

  const files = entries.filter((e) => !e.directory);
  if (files.length === 0) {
    return { action: 'skip', reason: 'it holds no files', quiet: true };
  }

  const unsafe = files.filter((e) => safeRelativePath(e.name) === null);
  if (unsafe.length > 0) {
    return { action: 'skip', reason: `it holds file names that cannot be created safely (${unsafe.slice(0, 3).map((e) => e.name).join(', ')})`, quiet: false };
  }

  if (options.mediaOnly && !files.some((e) => isMediaName(e.name)) && !(options.nested && containsArchiveSet(files))) {
    return { action: 'skip', reason: 'it holds no video, audio or subtitles', quiet: true };
  }

  if (!options.unpackStored && isPlayableAsStored(kind, files)) {
    return { action: 'skip', reason: 'the media server already plays it as it is (stored)', quiet: true };
  }

  return { action: 'unpack', files, bytes: files.reduce((sum, e) => sum + (e.size > 0 ? e.size : 0), 0) };
};

// Enough room for everything plus the margin?
const hasRoom = (freeBytes, neededBytes, marginGiB) => typeof freeBytes === 'number' && freeBytes >= 0
  && freeBytes >= neededBytes + marginGiB * GIB;

const formatBytes = (bytes) => {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
};

module.exports = { planSet, safeRelativePath, isPlayableAsStored, hasRoom, formatBytes, containsArchiveSet, GIB };
