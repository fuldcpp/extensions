'use strict';

// Release names: reading "Show.Name.S02E05.1080p.WEB.h264-GROUP" back into show, season and
// episode, and choosing a search result for a wanted episode. Only a result whose name parses to
// exactly the wanted show and episode is ever chosen; there is no fallback to "the top result".

const VIDEO_EXTENSIONS = new Set([ 'mkv', 'mp4', 'avi', 'm4v', 'ts', 'wmv', 'mpg', 'mpeg', 'webm', 'mov' ]);
const MAX_RANGE = 10;

// Lowercase letters and digits only, accents folded: "Grey's Anatomy" and "Greys.Anatomy" agree
const compact = (text) => String(text || '')
  .normalize('NFKD')
  .replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/['’`]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, '');

const spacedOf = (title) => String(title || '').replace(/[._]+/g, ' ').replace(/[()[\]]/g, ' ').replace(/\s+/g, ' ').trim();
const TRAILING_YEAR = /\s+((?:19|20)\d\d)$/;
// "The Office (US)": the tag names which country's show this is
const COUNTRY_TAG = /\s+(US|UK|GB|AU|NZ|CA|IE)$/;

// The keys a title is known by: as written, and without a trailing year. "Doctor Who (2005)"
// matches "Doctor.Who.2005.S01E01" and "Doctor.Who.S01E01". A country tag is kept: "The Office
// (US)" is not "The Office".
const titleKeys = (title) => {
  const keys = new Set();
  const spaced = spacedOf(title);
  const add = (text) => {
    const key = compact(text);
    if (key) keys.add(key);
  };

  add(spaced);
  add(spaced.replace(TRAILING_YEAR, ''));
  return keys;
};

// The keys of one show from all its names (the library's, TMDB's). When one name carries a
// country tag, the bare title belongs to the other country's show and is not a key, even when
// TMDB calls this show by it (TMDB names "The Office (US)" plain "The Office").
const showKeys = (titles) => {
  const keys = new Set();
  const excluded = new Set();
  for (const title of titles) {
    for (const key of titleKeys(title)) keys.add(key);
    const noYear = spacedOf(title).replace(TRAILING_YEAR, '');
    const tag = COUNTRY_TAG.exec(noYear);
    if (tag) excluded.add(compact(noYear.slice(0, tag.index)));
  }

  for (const key of excluded) keys.delete(key);
  return keys;
};

// The years one show is known by: in its names, its production year, its first air date
const showYears = (titles, ...years) => {
  const ret = new Set();
  for (const title of titles) {
    const match = TRAILING_YEAR.exec(spacedOf(title));
    if (match) ret.add(Number(match[1]));
  }

  for (const year of years) {
    const number = Number(String(year || '').slice(0, 4));
    if (Number.isInteger(number) && number >= 1900 && number < 2100) ret.add(number);
  }

  return Array.from(ret).sort((a, b) => a - b);
};

// Whether a release's show part names the wanted show. A year in the release name has to be one
// of the show's years: "Doctor.Who.2005" is not the 1963 show, "Show.Name.2024" not the 2010
// one. With no known year, a release with a year matches only a name written with that year.
const showMatches = (releaseShow, wanted) => {
  const spaced = spacedOf(releaseShow);
  if (wanted.keys.has(compact(spaced))) {
    return true;
  }

  const year = TRAILING_YEAR.exec(spaced);
  if (!year) {
    return false;
  }

  const years = new Set(Array.isArray(wanted.years) || wanted.years instanceof Set ? wanted.years : []);
  return years.has(Number(year[1])) && wanted.keys.has(compact(spaced.slice(0, year.index)));
};

const keysOverlap = (a, b) => {
  for (const key of a) {
    if (b.has(key)) return true;
  }

  return false;
};

const extensionOf = (name) => {
  const match = /\.([A-Za-z0-9]{2,4})$/.exec(String(name || ''));
  return match ? match[1].toLowerCase() : '';
};

const SXXEYY = /^(.+?)[ ._-]+S(\d{1,3})[ ._-]?E(\d{1,4})((?:[ ._-]?-?[ ._-]?E\d{1,4})*)(?=$|[ ._\-[(])/i;

// { show, season, episode, episodeEnd, group } or null
const parseRelease = (rawName) => {
  let name = String(rawName || '').trim();
  if (VIDEO_EXTENSIONS.has(extensionOf(name))) {
    name = name.replace(/\.[A-Za-z0-9]{2,4}$/, '');
  }

  const match = SXXEYY.exec(name);
  if (!match) {
    return null;
  }

  const season = Number(match[2]);
  const episode = Number(match[3]);
  let episodeEnd = episode;
  if (match[4]) {
    const more = (match[4].match(/\d{1,4}/g) || []).map(Number);
    // E05E06E07 or E05-E07: the numbers must run upwards from the first
    for (const number of more) {
      if (number <= episodeEnd || number - episode >= MAX_RANGE) {
        return null;
      }

      episodeEnd = number;
    }
  }

  const tail = name.slice(match[0].length);
  const groupMatch = /-([A-Za-z0-9]+)$/.exec(tail);
  return {
    show: match[1].replace(/[._]+/g, ' ').trim(),
    season,
    episode,
    episodeEnd,
    group: groupMatch ? groupMatch[1] : '',
  };
};

// Words after the episode code that change WHAT the release is, not how good it is: another
// language, a dub, burnt-in subtitles (HC), extras, a subtitle pack, a trailer, a cam. Split on
// . _ space and brackets only, so "WEB-DL" stays one word and only "GERMAN.DL" gives "dl".
const LANGUAGE_TAG = /^(french|truefrench|vff|vfq|vfi|vostfr|subfrench|german|ger|deutsch|dl|ml|italian|ita|spanish|spa|castellano|latino|esp|dutch|flemish|swedish|swe|swesub|norwegian|nor|norsub|danish|dan|dksub|finnish|fin|finsub|nordic|polish|pl|plsub|russian|rus|ukrainian|czech|cz|hungarian|hun|portuguese|por|brazilian|turkish|tur|greek|hebrew|arabic|hindi|tamil|telugu|japanese|jap|jpn|korean|kor|korsub|chinese|chs|cht|mandarin|cantonese|thai|vietnamese|multi|dubbed|subbed|hardsub|hardsubs|hc|hcsub)$/;
const CONTENT_TAG = /^(extras|extra|bonus|featurette|featurettes|subpack|subs|subtitles|trailer|teaser|sample|proof|cam|hdcam|camrip|ts|hdts|telesync|tc|telecine|scr|screener|dvdscr|bdscr|r5|workprint|3d|sbs|hsbs|ou|hou)$/;

// The tags of a release name, lowercase: the words between the episode code and the group
const releaseTags = (rawName) => {
  let name = String(rawName || '').trim();
  if (VIDEO_EXTENSIONS.has(extensionOf(name))) {
    name = name.replace(/\.[A-Za-z0-9]{2,4}$/, '');
  }

  const match = SXXEYY.exec(name);
  if (!match) return [];
  const tail = name.slice(match[0].length).replace(/-[A-Za-z0-9]+$/, '');
  const tags = tail.toLowerCase().split(/[._ ()[\]]+/).filter((t) => LANGUAGE_TAG.test(t) || CONTENT_TAG.test(t));
  return Array.from(new Set(tags));
};

// Whether a name is a release of the wanted show covering the wanted episode
const matchesWanted = (name, wanted) => {
  const parsed = parseRelease(name);
  if (!parsed || parsed.season !== wanted.season || wanted.episode < parsed.episode || wanted.episode > parsed.episodeEnd) {
    return null;
  }

  return showMatches(parsed.show, wanted) ? parsed : null;
};

const hasToken = (name, token) => {
  const wanted = String(token || '').trim().toLowerCase();
  if (!wanted) return true;
  return String(name || '').toLowerCase().split(/[ ._\-[\]()]+/).includes(wanted);
};

const splitList = (text) => String(text || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

const hitsOf = (result) => {
  if (typeof result.hits === 'number') return result.hits;
  if (result.users && typeof result.users.count === 'number') return result.users.count;
  return 0;
};

// The result to download for one wanted episode, or null. Never the top result by default:
// every candidate has to pass the name check.
const pickBest = (results, wanted, prefs = {}) => {
  const groups = splitList(prefs.groups).map((g) => g.toLowerCase());
  const acceptedTags = new Set(splitList(prefs.acceptedTags).map((t) => t.toLowerCase()));
  const candidates = [];
  for (const result of Array.isArray(results) ? results : []) {
    if (!result || typeof result.name !== 'string' || result.id === undefined || result.id === null) continue;
    // Already shared or queued somewhere: the client knows a copy, never fetch a second
    if (result.dupe) continue;

    const isDirectory = !!result.type && result.type.id === 'directory';
    if (!isDirectory && !VIDEO_EXTENSIONS.has(extensionOf(result.name))) continue;
    // A release's sample or trailer ("...-GRP-sample.mkv", "sample-...", "(sample)", "Trailer"): never the episode
    if (/(^|[ ._\-[(])(sample|trailer)([ ._\-)\]]|$)/i.test(result.name)) continue;

    const parsed = matchesWanted(result.name, wanted);
    if (!parsed) continue;
    if (!hasToken(result.name, prefs.quality)) continue;
    // Another language, a dub, hardsubs, extras: only when the user accepts that tag
    if (releaseTags(result.name).some((tag) => !acceptedTags.has(tag))) continue;

    const groupRank = groups.indexOf(parsed.group.toLowerCase());
    if (prefs.requireGroup && groups.length > 0 && groupRank < 0) continue;

    candidates.push({ result, parsed, groupRank: groupRank < 0 ? groups.length : groupRank, isDirectory, hits: hitsOf(result) });
  }

  // The release folder before a loose video of the same release: it carries the .nfo/.sfv the
  // client checks a release with, and the download sorter files a folder whole
  candidates.sort((a, b) => (a.groupRank - b.groupRank) || (b.isDirectory - a.isDirectory)
    || (b.hits - a.hits) || a.result.name.localeCompare(b.result.name));
  return candidates.length > 0 ? { result: candidates[0].result, parsed: candidates[0].parsed, considered: candidates.length } : null;
};

const pad = (n) => String(n).padStart(2, '0');
const episodeCode = (season, episode) => `S${pad(season)}E${pad(episode)}`;

// What is typed into the hub search: the show's words, the episode code and the quality. Words
// rather than one dotted token, so a release named with spaces is found as well; the strict name
// check above throws out whatever else the words find.
const buildQuery = (showName, season, episode, quality) => {
  const words = String(showName || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\(\s*(19|20)\d\d\s*\)/g, ' ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12);
  const parts = [ ...words, episodeCode(season, episode) ];
  const q = String(quality || '').trim();
  if (q && /^[\p{L}\p{N}]+$/u.test(q)) {
    parts.push(q);
  }

  return parts.join(' ');
};

module.exports = {
  compact, titleKeys, showKeys, showYears, releaseTags, keysOverlap, parseRelease, matchesWanted, hasToken, pickBest, buildQuery, episodeCode, splitList, VIDEO_EXTENSIONS,
};
