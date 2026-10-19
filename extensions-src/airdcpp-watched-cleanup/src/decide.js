'use strict';

// Pure decisions: which watched items are done with, how their files map onto the disk, and what
// a clean would move. Nothing here touches the network or the disk.

const path = require('path').win32;

const DAY_MS = 24 * 3600 * 1000;
const GIB = 1024 * 1024 * 1024;

const VIDEO_EXT = new Set([ 'mkv', 'mp4', 'm4v', 'avi', 'mov', 'wmv', 'ts', 'm2ts', 'mts', 'mpg', 'mpeg', 'vob', 'webm', 'flv', 'ogv', 'divx', 'xvid', '3gp', 'iso', 'rmvb', 'asf' ]);
const AUDIO_EXT = new Set([ 'mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'wma', 'ape', 'alac', 'dsf' ]);
// What may go with a video because it only describes it
const SIDECAR_EXT = new Set([ 'srt', 'sub', 'idx', 'ass', 'ssa', 'vtt', 'sup', 'smi', 'nfo', 'jpg', 'jpeg', 'png', 'webp', 'tbn', 'bif', 'txt', 'sfv', 'md5', 'url', 'xml' ]);
// What may sit in a release folder besides the video
const RELEASE_EXTRA_EXT = new Set([ ...SIDECAR_EXT, 'diz', 'm3u', 'nzb', 'par2', 'srr', 'srs', 'rar', 'zip', 'gif', 'bmp', 'log', 'cue' ]);

const extOf = (name) => {
  const m = /\.([^.\\/]+)$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
};

const isVideoName = (name) => VIDEO_EXT.has(extOf(name));
const isAudioName = (name) => AUDIO_EXT.has(extOf(name));
// A packed release volume: .rar, .r00.., .001..
const isArchiveVolume = (name) => /\.(rar|r\d{2}|s\d{2}|\d{3})$/i.test(String(name || ''));

const isArchiveFile = (name) => isArchiveVolume(name) || /\.(zip|7z)$/i.test(String(name || ''));
// What names one archive set: "x.part01.rar", "x.rar" + "x.r00", "x.001" all give "x" (lower case)
const archiveSetBase = (rel) => path.basename(String(rel || '')).toLowerCase()
  .replace(/\.part\d+\.rar$/, '').replace(/\.(rar|r\d{2}|s\d{2}|\d{3}|zip|7z)$/, '');
const stemOf = (rel) => path.basename(String(rel || '')).toLowerCase().replace(/\.[^.]*$/, '');

const IMAGE_EXT = new Set([ 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tbn' ]);
// Folders a release keeps its subtitles, sample, proof and artwork in
const SUPPORT_DIR = /(^|\\)(subs?|subtitles?|vobsubs?|samples?|proof|extrafanart|extrathumbs|covers?|artwork|scans?)\\/i;
// Artwork as media managers and scene releases name it: "poster.jpg", "film-fanart.jpg", "grp-proof.jpg"
const ARTWORK_NAME = /(^|[._ -])(poster|folder|cover|covers|default|jacket|fanart|background|backdrop|art|banner|clearart|clearlogo|logo|disc|discart|cdart|landscape|thumb|keyart|proof|front|back|season\d*(-\w+)?)(\d*)$/;
const SAMPLE_MAX_BYTES = 300 * 1024 * 1024;

// The client's recordings are "<title> <6 hex of the timer id>.ts" (LiveTvTimers.cpp:612)
const isRecordingName = (name) => /\s[0-9a-f]{6}\.ts$/i.test(String(name || ''));

// Ids as the media server writes them: 32 lower-case hex digits, no dashes (MediaLibrary::normalizeId)
const normId = (id) => String(id || '').toLowerCase().replace(/-/g, '');

// The share API sends a path id as the base32 of a 24-byte Tiger hash; the media server's item id
// is the first 16 of the same bytes in hex (MediaLibrary.cpp:1183 idForPath, ID_BYTES 16).
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const base32ToHex16 = (text) => {
  const s = String(text || '').toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const c of s) {
    const v = B32.indexOf(c);
    if (v < 0) return '';
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }

  if (bytes.length < 16) return '';
  return bytes.slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
};

// Windows paths, compared without regard to case or a trailing separator
const normPath = (p) => path.normalize(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();
const isUnder = (child, folder) => {
  const c = normPath(child);
  const f = normPath(folder);
  if (!f || !c) return false;
  return c === f || c.startsWith(`${f}\\`);
};

const timeOf = (iso) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};

const epKey = (item) => [ Number.isInteger(item.ParentIndexNumber) ? item.ParentIndexNumber : -1, Number.isInteger(item.IndexNumber) ? item.IndexNumber : -1 ];
const compareEpisodesDesc = (a, b) => {
  const [ as, ae ] = epKey(a);
  const [ bs, be ] = epKey(b);
  if (as !== bs) return bs - as;
  if (ae !== be) return be - ae;
  return (timeOf(b.UserData && b.UserData.LastPlayedDate) || 0) - (timeOf(a.UserData && a.UserData.LastPlayedDate) || 0);
};

// The K last episodes (in series order) an account has watched, per series: kept for that account
const lastEpisodesKept = (played, keepCount) => {
  const kept = new Set();
  if (keepCount <= 0) return kept;
  const bySeries = new Map();
  for (const item of played) {
    if (item.Type !== 'Episode' || !item.SeriesId) continue;
    const list = bySeries.get(normId(item.SeriesId)) || [];
    list.push(item);
    bySeries.set(normId(item.SeriesId), list);
  }

  for (const list of bySeries.values()) {
    list.sort(compareEpisodesDesc);
    list.slice(0, keepCount).forEach((item) => kept.add(normId(item.Id)));
  }

  return kept;
};

/* Which items every counted account is done with.
 *
 * accounts: [{ name, played: [item], resumable: [item], favorites: [item] }], each list as the
 * media server answers for THAT account (an item's UserData is the asking account's own).
 * Returns the candidates (the first account's item object, plus lastPlayed = the most recent of
 * all accounts) and a count of what was left out, by reason.
 */
const selectCandidates = ({ accounts, now, watchedDays, addedDays, keepLastEpisodes }) => {
  const excluded = {};
  const skip = (reason) => { excluded[reason] = (excluded[reason] || 0) + 1; };
  if (!accounts || accounts.length === 0) return { candidates: [], excluded };

  const views = accounts.map((a) => {
    const played = new Map();
    for (const item of a.played || []) {
      if (item && item.Id) played.set(normId(item.Id), item);
    }

    const busySeries = new Set();
    const busyItems = new Set();
    for (const item of a.resumable || []) {
      if (!item || !item.Id) continue;
      busyItems.add(normId(item.Id));
      if (item.SeriesId) busySeries.add(normId(item.SeriesId));
    }

    const favorites = new Set();
    for (const item of a.favorites || []) {
      if (item && item.Id) favorites.add(normId(item.Id));
    }

    return { played, busySeries, busyItems, favorites, keptEpisodes: lastEpisodesKept(Array.from(played.values()), keepLastEpisodes) };
  });

  const candidates = [];
  for (const [ id, item ] of views[0].played) {
    // Films and episodes only: a plain video is somebody's own footage as often as a film
    if (item.Type !== 'Movie' && item.Type !== 'Episode') { skip('not a film or an episode'); continue; }

    const states = views.map((v) => v.played.get(id));
    if (states.some((s) => !s || !s.UserData || s.UserData.Played !== true)) { skip('not watched by every account'); continue; }

    const favourite = views.some((v, i) => states[i].UserData.IsFavorite === true || v.favorites.has(id)
      || (item.SeriesId && v.favorites.has(normId(item.SeriesId))) || (item.SeasonId && v.favorites.has(normId(item.SeasonId))));
    if (favourite) { skip('a favourite'); continue; }

    if (views.some((v, i) => v.busyItems.has(id) || Number(states[i].UserData.PlaybackPositionTicks) > 0)) { skip('being watched again'); continue; }
    if (item.Type === 'Episode' && item.SeriesId && views.some((v) => v.busySeries.has(normId(item.SeriesId)))) { skip('series in progress'); continue; }
    if (item.Type === 'Episode' && views.some((v) => v.keptEpisodes.has(id))) { skip('one of the last watched episodes'); continue; }

    const times = states.map((s) => timeOf(s.UserData.LastPlayedDate));
    if (times.some((t) => t === null)) { skip('no last played date'); continue; }
    const lastPlayed = Math.max(...times);
    if (now - lastPlayed < watchedDays * DAY_MS) { skip('watched recently'); continue; }

    const added = timeOf(item.DateCreated);
    if (added === null || now - added < addedDays * DAY_MS) { skip('added recently'); continue; }

    candidates.push({ ...item, Id: id, lastPlayed });
  }

  // Watched longest ago first: that is the order a capped clean takes them in
  candidates.sort((a, b) => a.lastPlayed - b.lastPlayed || (a.Id < b.Id ? -1 : 1));
  return { candidates, excluded };
};

/* What a clean of one resolved item would move.
 *
 * file: the video's real path. entries: everything in its folder, recursively, from the disk:
 * [{ rel, size, isDir }] with rel relative to that folder. guarded: the folders that must never be
 * moved themselves (share roots, library roots, keep-forever folders and anything above them).
 */
const planRemoval = ({ file, type, entries, guarded, overflow = false }) => {
  const folder = path.dirname(file);
  const name = path.basename(file);
  const ownSize = (entries.find((e) => !e.isDir && e.rel.toLowerCase() === name.toLowerCase()) || {}).size || 0;
  const packed = !isVideoName(name);
  if (packed && !isArchiveVolume(name)) {
    // A .strm or anything else that is not the video itself: which files belong with it is a guess
    return { skip: 'not a plain video file' };
  }

  const folderGuarded = guarded.some((g) => isUnder(g, folder)); // the folder is a root, or holds one
  const others = entries.filter((e) => !e.isDir && e.rel.toLowerCase() !== name.toLowerCase());
  // A sample is small; a full-size video that only has "sample" in its name is another video
  const inSample = (e) => e.size <= SAMPLE_MAX_BYTES
    && (/(^|\\)(samples?|proof)\\/i.test(e.rel) || /(^|[._ -])sample([._ -]|$)/i.test(path.basename(e.rel)));
  const otherVideos = others.filter((e) => (isVideoName(e.rel) || isAudioName(e.rel)) && !(isVideoName(e.rel) && inSample(e)));
  const ownBase = stemOf(name);
  const ownSet = archiveSetBase(name);
  // Release artwork and proof pictures belong; somebody's photographs do not
  const belongsImage = (rel) => SUPPORT_DIR.test(rel) || stemOf(rel).startsWith(ownBase) || ARTWORK_NAME.test(stemOf(rel));
  // The release's own archive set, or its Subs/Sample folder's; another archive is another thing
  const belongsArchive = (rel) => SUPPORT_DIR.test(rel)
    || (!rel.includes('\\') && (archiveSetBase(rel) === ownSet || archiveSetBase(rel).startsWith(`${ownBase}.`)));
  const strangers = others.filter((e) => {
    if (isVideoName(e.rel)) return false;
    if (isArchiveFile(e.rel)) return !belongsArchive(e.rel);
    if (IMAGE_EXT.has(extOf(e.rel))) return !belongsImage(e.rel);
    return !RELEASE_EXTRA_EXT.has(extOf(e.rel));
  });
  const otherBytes = others.reduce((sum, e) => sum + (e.size || 0), 0);

  const wholeFolder = !overflow && !folderGuarded && otherVideos.length === 0 && strangers.length === 0
    && entries.length <= 200 && (packed || otherBytes <= Math.max(500 * 1024 * 1024, ownSize * 0.1));

  if (wholeFolder) {
    return { kind: 'folder', paths: [ folder ], bytes: ownSize + otherBytes, refresh: path.dirname(folder) };
  }

  if (packed) {
    return { skip: 'packed release that shares its folder' };
  }

  if (type === 'Movie' && (otherVideos.length > 0 || overflow)) {
    // Another part, another version or another film: which belongs with this one is a guess
    return { skip: 'folder holds other videos (parts or versions)' };
  }

  // The video and what describes it: same base name, a describing extension, in the same folder
  const base = name.slice(0, name.length - extOf(name).length - 1).toLowerCase();
  const sidecars = entries.filter((e) => {
    if (e.isDir || e.rel.includes('\\')) return false;
    const lower = e.rel.toLowerCase();
    if (lower === name.toLowerCase() || !SIDECAR_EXT.has(extOf(lower))) return false;
    return lower.startsWith(`${base}.`) || lower.startsWith(`${base}-`);
  });

  return {
    kind: 'files',
    paths: [ file, ...sidecars.map((e) => path.join(folder, e.rel)) ],
    bytes: ownSize + sidecars.reduce((sum, e) => sum + (e.size || 0), 0),
    refresh: folder,
  };
};

// Take items in order until either limit would be passed
const applyCaps = (items, maxItems, maxBytes) => {
  const taken = [];
  let bytes = 0;
  for (const item of items) {
    if (taken.length >= maxItems) break;
    if (bytes + item.bytes > maxBytes) continue;
    taken.push(item);
    bytes += item.bytes;
  }

  return { taken, bytes };
};

const formatBytes = (bytes) => {
  const n = Number(bytes) || 0;
  if (n >= GIB) return `${(n / GIB).toFixed(1)} GiB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MiB`;
  return `${Math.round(n / 1024)} KiB`;
};

const driveOf = (p) => (/^[a-z]:/i.exec(String(p || '')) || [ '?' ])[0].toUpperCase();

const totalsByDrive = (planned) => {
  const totals = new Map();
  for (const p of planned) {
    const drive = driveOf(p.paths[0]);
    totals.set(drive, (totals.get(drive) || 0) + p.bytes);
  }

  return Array.from(totals.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
};

const titleOf = (item) => {
  if (item.Type === 'Episode') {
    const s = Number.isInteger(item.ParentIndexNumber) ? `S${String(item.ParentIndexNumber).padStart(2, '0')}` : '';
    const e = Number.isInteger(item.IndexNumber) ? `E${String(item.IndexNumber).padStart(2, '0')}` : '';
    return `${item.SeriesName || 'Series'} ${s}${e}${item.Name ? ` - ${item.Name}` : ''}`.trim();
  }

  return `${item.Name || 'Film'}${item.ProductionYear ? ` (${item.ProductionYear})` : ''}`;
};

const dateText = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '?');

// Markdown: | and line breaks in names would break the table
const cell = (text) => String(text).replace(/[|\r\n]/g, ' ');

const buildReport = ({ planned, skipped, excluded, accounts, uncovered, now, settingsText }) => {
  const lines = [];
  lines.push('# Watched media that could be cleaned', '');
  lines.push(`Written ${new Date(now).toISOString()} by airdcpp-watched-cleanup. Nothing has been moved by writing this report.`, '');
  lines.push(`Accounts counted: ${accounts.map(cell).join(', ') || 'none'}.`);
  if (uncovered.length > 0) {
    lines.push(`**Not counted (their watched state cannot be read): ${uncovered.map(cell).join(', ')}.** "/cleanup run" refuses until they are added under the extension's settings, or "Clean even though..." is turned on.`);
  }

  lines.push(`Rules: ${settingsText}`, '');
  const total = planned.reduce((sum, p) => sum + p.bytes, 0);
  lines.push(`## ${planned.length} item(s), ${formatBytes(total)}`, '');
  for (const [ drive, bytes ] of totalsByDrive(planned)) {
    lines.push(`- ${drive} ${formatBytes(bytes)}`);
  }

  if (planned.length > 0) {
    lines.push('', '| Item | Last played | Size | Moves |', '| --- | --- | --- | --- |');
    for (const p of planned) {
      lines.push(`| ${cell(titleOf(p.item))} | ${dateText(p.item.lastPlayed)} | ${formatBytes(p.bytes)} | ${p.paths.map((x) => `\`${cell(x)}\`${p.kind === 'folder' ? ' (folder)' : ''}`).join('<br>')} |`);
    }
  }

  if (skipped.length > 0) {
    lines.push('', `## Watched, but left alone (${skipped.length})`, '', '| Item | Why |', '| --- | --- |');
    for (const s of skipped) {
      lines.push(`| ${cell(titleOf(s.item))}${s.path ? ` \`${cell(s.path)}\`` : ''} | ${cell(s.reason)} |`);
    }
  }

  const reasons = Object.entries(excluded || {});
  if (reasons.length > 0) {
    lines.push('', '## Not candidates', '');
    for (const [ reason, count ] of reasons.sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${cell(reason)}: ${count}`);
    }
  }

  lines.push('');
  return lines.join('\n');
};

module.exports = {
  DAY_MS, GIB, extOf, isVideoName, isAudioName, isArchiveVolume, isRecordingName, normId, base32ToHex16,
  normPath, isUnder, selectCandidates, lastEpisodesKept, planRemoval, applyCaps, formatBytes, driveOf,
  totalsByDrive, titleOf, buildReport,
};
