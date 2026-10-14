'use strict';

// Decides where a finished release belongs. Pure functions only: covered by the unit tests.

const path = require('path');

const SEP = '[._ -]';
// Tags that only video releases carry. Plain "WEB" is not one of them: music and software use it.
const VIDEO_TAG = new RegExp(`(^|${SEP})(2160p|1080p|720p|576p|480p|BluRay|Blu-Ray|BDRip|BRRip|WEB-?DL|WEBRip|HDTV|PDTV|DVDRip|DVDR|REMUX|x264|x265|H\\.?264|H\\.?265|HEVC|XviD|DivX|UHD)(${SEP}|$)`, 'i');
// TV markers. A bare "S01" or "1x05" is only TV next to a video tag (firmware "S10", icons "32x32").
const TV_EPISODE = new RegExp(`${SEP}S(\\d{2})E\\d{2,3}(?:-?E\\d{2,3})*(?=${SEP}|$)`, 'i');
const TV_SEASON = new RegExp(`${SEP}S(\\d{2})(?:-S\\d{2})?(?=${SEP}|$)`, 'i');
const TV_CROSS = new RegExp(`${SEP}(\\d{1,2})x\\d{2,3}(?=${SEP}|$)`, 'i');
const TV_SEASON_WORD = new RegExp(`${SEP}Season${SEP}?(\\d{1,2})(?=${SEP}|$)`, 'i');
const TV_DAILY = new RegExp(`${SEP}((?:19|20)\\d{2})${SEP}\\d{2}${SEP}\\d{2}(?=${SEP}|$)`);
const MUSIC_FORMAT = new RegExp(`(^|${SEP})(FLAC|MP3|ALAC|OGG|APE|WAV)(${SEP}|$)`, 'i');
// Scene music: Artist-Title-(tags)-YEAR-GROUP, the group in one case (not "Holiday-Photos-2019-June")
const MUSIC_SCENE = /-(?:19|20)\d{2}-(?:[A-Z0-9]{2,}|[a-z0-9]{2,})$/;
const MOVIE_YEAR = /[._ (](?:19|20)\d{2}[._ )]/;

// "pattern => directory" per line; '#' starts a comment. A bad regex or a folder that is not an
// absolute path with a drive or share is reported, not used.
const parseCustomRules = (text) => {
  const rules = [];
  const errors = [];
  String(text || '').split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      return;
    }

    const sep = line.lastIndexOf('=>');
    const pattern = sep > 0 ? line.slice(0, sep).trim() : '';
    const directory = sep > 0 ? line.slice(sep + 2).trim() : '';
    if (!pattern || !directory) {
      errors.push(`line ${index + 1}: expected "pattern => folder"`);
      return;
    }

    if (!isRootedDirectory(directory)) {
      errors.push(`line ${index + 1}: "${directory}" is not a full path (it needs a drive or a \\\\server\\share)`);
      return;
    }

    try {
      rules.push({ regex: new RegExp(pattern, 'i'), directory });
    } catch (e) {
      errors.push(`line ${index + 1}: invalid pattern (${e.message})`);
    }
  });

  return { rules, errors };
};

// The TV marker of a name with its season, or null
const tvMatchOf = (name) => {
  const episode = TV_EPISODE.exec(name);
  if (episode) {
    return { index: episode.index, season: Number(episode[1]) };
  }

  const word = TV_SEASON_WORD.exec(name);
  if (word) {
    return { index: word.index, season: Number(word[1]) };
  }

  const daily = TV_DAILY.exec(name);
  if (daily && VIDEO_TAG.test(name)) {
    return { index: daily.index, season: null };
  }

  if (VIDEO_TAG.test(name)) {
    const season = TV_SEASON.exec(name) || TV_CROSS.exec(name);
    if (season) {
      return { index: season.index, season: Number(season[1]) };
    }
  }

  return null;
};

// The show name of a TV release: the part before the marker, separators made spaces
const showNameOf = (name) => {
  const match = tvMatchOf(name);
  if (!match) {
    return null;
  }

  const show = name.slice(0, match.index).replace(/[._]+/g, ' ').replace(/[\s-]+$/, '').replace(/\s+/g, ' ').trim();
  return show || null;
};

const seasonOf = (name) => {
  const match = tvMatchOf(name);
  return match ? match.season : null;
};

// The category of a release name: 'tv' | 'movies' | 'music' | null
const categoryOf = (name) => {
  if (tvMatchOf(name)) {
    return 'tv';
  }

  // Video before music: AAC/Opus/FLAC audio tracks are common in movie names
  if (VIDEO_TAG.test(name)) {
    return MOVIE_YEAR.test(name) ? 'movies' : null;
  }

  if (MUSIC_FORMAT.test(name) || (MUSIC_SCENE.test(name) && !name.includes('.'))) {
    return 'music';
  }

  return null;
};

const RESERVED = /^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/i;

// A folder name Windows accepts: no reserved characters, no trailing dots or spaces, no device name
const safeFolder = (name) => {
  const clean = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/[. ]+$/, '').trim();
  return RESERVED.test(clean) ? `${clean}_` : clean;
};

// An absolute folder with a drive (C:\...) or a share (\\server\share); never relative or "D:x"
const isRootedDirectory = (dir) => /^[A-Za-z]:[\\/]/.test(String(dir || '')) || /^\\\\[^\\]+\\[^\\]+/.test(String(dir || '')) ||
  (process.platform !== 'win32' && path.posix.isAbsolute(String(dir || '')));

// Where a release goes, or null to leave it. `name` is the release (bundle) name.
// settings: { tvDirectory, moviesDirectory, musicDirectory, tvGroupByShow, customRules (parsed) }
// Returns { category, directory } - the folder the release is moved INTO.
const destinationOf = (name, settings) => {
  for (const rule of settings.customRules || []) {
    if (rule.regex.test(name)) {
      return { category: 'custom', directory: rule.directory };
    }
  }

  const category = categoryOf(name);
  if (category === 'tv' && settings.tvDirectory) {
    let directory = settings.tvDirectory;
    if (settings.tvGroupByShow) {
      const show = showNameOf(name);
      if (show && safeFolder(show)) {
        directory = path.join(directory, safeFolder(show));
        const season = seasonOf(name);
        if (season !== null) {
          directory = path.join(directory, `Season ${String(season).padStart(2, '0')}`);
        }
      }
    }

    return { category, directory };
  }

  if (category === 'movies' && settings.moviesDirectory) {
    return { category, directory: settings.moviesDirectory };
  }

  if (category === 'music' && settings.musicDirectory) {
    return { category, directory: settings.musicDirectory };
  }

  return null;
};

// Paths compared case-insensitively on Windows only
const normalizeDir = (p) => {
  const resolved = path.resolve(String(p || ''));
  const withSep = resolved.endsWith(path.sep) ? resolved : resolved + path.sep;
  return process.platform === 'win32' ? withSep.toLowerCase() : withSep;
};

// `child` inside or equal to `parent`
const isInside = (child, parent) => !!parent && normalizeDir(child).startsWith(normalizeDir(parent));

// `child` strictly inside `parent`
const isStrictlyInside = (child, parent) => isInside(child, parent) && normalizeDir(child) !== normalizeDir(parent);

module.exports = {
  categoryOf, showNameOf, seasonOf, destinationOf, parseCustomRules, safeFolder,
  isInside, isStrictlyInside, normalizeDir, isRootedDirectory,
};
