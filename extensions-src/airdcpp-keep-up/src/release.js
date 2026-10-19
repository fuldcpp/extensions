'use strict';

// Release names: parsing, the strict show/episode match, and choosing among search results.
// Pure functions only.

const VIDEO_EXTENSIONS = [ 'mkv', 'mp4', 'avi', 'm4v', 'ts', 'wmv', 'mov' ];
const RESOLUTIONS = [ '2160p', '1080p', '720p', '576p', '480p' ];

// Words after SxxEyy that change WHAT the release is, not how good it is (the quality-upgrader
// extension's lists). A language or dub may be accepted by the user; a content tag never.
const LANGUAGE_TAG = /^(french|truefrench|vff|vfq|vfi|vostfr|subfrench|german|ger|deutsch|dl|ml|italian|ita|spanish|spa|castellano|latino|esp|dutch|flemish|swedish|swe|swesub|norwegian|nor|norsub|danish|dan|dksub|finnish|fin|finsub|nordic|polish|pl|plsub|russian|rus|ukrainian|czech|cz|hungarian|hun|portuguese|por|brazilian|turkish|tur|greek|hebrew|arabic|hindi|tamil|telugu|japanese|jap|jpn|korean|kor|korsub|chinese|chs|cht|mandarin|cantonese|thai|vietnamese|multi|dubbed|subbed|hardsub|hardsubs|hc|hcsub)$/;
const CONTENT_TAG = /^(extras|extra|bonus|featurette|featurettes|subpack|subs|subtitles|trailer|teaser|sample|proof|cam|hdcam|camrip|hdts|telesync|telecine|scr|screener|dvdscr|bdscr|r5|workprint|3d|sbs|hsbs|(disc|disk|cd|part|pt)\d{1,2})$/;

// The language and content tags among the words after the episode marker
const releaseTags = (rest) => {
  const words = rest.toLowerCase()
    .replace(/web[-.]?dl/g, 'webdl') // "WEB-DL" is a source, not the "DL" (dual language) tag
    .split(/[.\s_\-[\]()]+/)
    .filter(Boolean);
  return {
    languageTags: Array.from(new Set(words.filter((w) => LANGUAGE_TAG.test(w)))),
    contentTags: Array.from(new Set(words.filter((w) => CONTENT_TAG.test(w)))),
  };
};

const pad = (n) => String(n).padStart(2, '0');
const episodeTag = (season, episode) => `S${pad(season)}E${pad(episode)}`;

// Lower case, no accents, "&" as "and", apostrophes dropped, everything else a single space
const normalizeTitle = (text) => String(text || '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/['’`]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

// "Doctor Who (2005)" -> { title: 'Doctor Who', year: 2005 }
const splitTitleYear = (text) => {
  const match = /^(.*?)[\s.(\[]+((?:19|20)\d\d)[)\]]?\s*$/.exec(String(text || '').trim());
  if (match && match[1].trim()) {
    return { title: match[1].trim(), year: Number(match[2]) };
  }

  return { title: String(text || '').trim(), year: null };
};

const stripExtension = (name) => {
  const match = /^(.*)\.([a-z0-9]{2,4})$/i.exec(name);
  if (match && VIDEO_EXTENSIONS.includes(match[2].toLowerCase())) {
    return { base: match[1], extension: match[2].toLowerCase() };
  }

  return { base: name, extension: '' };
};

// Parses "Show.Name.2019.S01E02.1080p.WEB.h264-GRP" (folder or file name). Returns null when the
// name has no season marker at all.
const parseRelease = (name) => {
  if (typeof name !== 'string' || !name.trim()) {
    return null;
  }

  const { base, extension } = stripExtension(name.trim());

  // S01E02, S01E02E03, S01E02-E03, S01E02-03; season pack S01 (not followed by E or a digit)
  const episode = /(^|[.\s_\-[(])S(\d{1,2})E(\d{1,3})((?:[-.]?E\d{1,3}|-\d{1,3})*)(?=$|[.\s_\-)\]])/i.exec(base);
  const pack = episode ? null : /(^|[.\s_\-[(])S(\d{1,2})(?=$|[.\s_\-)\]])/i.exec(base);
  const marker = episode || pack;
  if (!marker) {
    return null;
  }

  const titlePart = base.slice(0, marker.index + marker[1].length).replace(/[.\s_\-[(]+$/, '');
  const rest = base.slice(marker.index + marker[0].length);
  const split = splitTitleYear(titlePart.replace(/[._]/g, ' '));

  const groupMatch = /-([A-Za-z0-9_]+)(?:\[[^\]]*\])?$/.exec(rest);
  const lowerRest = rest.toLowerCase();

  return {
    name,
    extension,
    title: split.title,
    fullTitle: titlePart.replace(/[._]/g, ' ').trim(),
    year: split.year,
    season: Number(marker[2]),
    episode: episode ? Number(episode[3]) : null,
    multiEpisode: Boolean(episode && episode[4]),
    seasonPack: !episode,
    // A release's sample or trailer file ("...-GRP-sample.mkv", "...GRP.sample.mkv"): never the episode
    sample: /(^|[.\s_\-[(])(sample|trailer)($|[.\s_\-)\]])/i.test(rest),
    group: groupMatch ? groupMatch[1] : '',
    ...releaseTags(rest),
    resolution: RESOLUTIONS.find((r) => new RegExp(`(^|[.\\s_\\-])${r}($|[.\\s_\\-])`, 'i').test(lowerRest)) || '',
  };
};

// "the office us": the tag names which country's show this is
const COUNTRY_TAG = /\s(us|uk|gb|au|nz|ca|ie)$/;

// Every name the show is known by, normalised, and every year it is known by (a year written in
// one of its names, the library's production year, TMDB's first air date).
//   showIdentity(names, ...years)
// When a name carries a country tag ("The Office (US)"), the bare title is the other country's
// show and is not a name of this one, even when TMDB calls it that.
const showIdentity = (names, ...years) => {
  const keys = new Set();
  const excluded = new Set();
  const known = new Set();
  for (const name of (names || []).filter(Boolean)) {
    const split = splitTitleYear(name);
    for (const key of [ normalizeTitle(name), normalizeTitle(split.title) ]) {
      if (key) keys.add(key);
    }

    if (split.year) known.add(split.year);
    const base = normalizeTitle(split.title);
    const tag = COUNTRY_TAG.exec(base);
    if (tag) excluded.add(base.slice(0, tag.index).trim());
  }

  for (const key of excluded) keys.delete(key);
  for (const year of years) {
    const number = Number(year);
    if (Number.isInteger(number) && number >= 1900 && number < 2100) known.add(number);
  }

  return { names: Array.from(keys), years: Array.from(known).sort((a, b) => a - b) };
};

// The release is this show: its title is one of the show's names, and a year in the release name
// is one of the show's years ("Doctor.Who.2005" is not the 1963 show; with no year known, a
// release with a year is another show of the same name)
const matchesShow = (parsed, identity) => {
  if (!parsed || !identity || identity.names.length === 0) {
    return false;
  }

  // The whole title, year included, is a name: "Doctor Who 2005" written so, or a show named "1923"
  if (parsed.year && identity.names.includes(normalizeTitle(parsed.fullTitle))) {
    return true;
  }

  const title = normalizeTitle(parsed.title);
  if (!title || !identity.names.includes(title)) {
    return false;
  }

  return !parsed.year || (identity.years || []).includes(parsed.year);
};

// Exactly this one episode: no packs, no double episodes, no sample files
const matchesEpisode = (parsed, identity, season, episode) => Boolean(parsed)
  && !parsed.seasonPack && !parsed.multiEpisode && !parsed.sample
  && parsed.season === season && parsed.episode === episode
  && matchesShow(parsed, identity);

// "Show.Name.S01E02" (plus the quality as a second word when it is required)
const searchPattern = (showName, season, episode, quality) => {
  const words = normalizeTitle(splitTitleYear(showName).title).split(' ').filter(Boolean);
  const pattern = `${words.join('.')}.${episodeTag(season, episode)}`;
  return quality ? `${pattern} ${quality}` : pattern;
};

const lowerList = (list) => (list || []).map((g) => String(g).trim().toLowerCase()).filter(Boolean);

const isVideoResult = (result) => {
  if (!result || !result.type) {
    return false;
  }

  if (result.type.id === 'directory') {
    return true;
  }

  return result.type.id === 'file' && Boolean(stripExtension(String(result.name || '')).extension);
};

// A name that is safe to use as a folder or file name under the download folder
const isSafeName = (name) => typeof name === 'string' && name.length > 0 && name.length < 200
  && !/[\\/:*?"<>|\x00-\x1f]/.test(name) && name !== '.' && name !== '..' && !name.endsWith('.') && !name.endsWith(' ');

// The acceptable results for one episode, best first. Never anything that does not match.
//   prefs: { quality, qualityRequired, preferredGroups, blockedGroups, maxSizeBytes }
const rankResults = (results, identity, season, episode, prefs = {}) => {
  const preferred = lowerList(prefs.preferredGroups);
  const blocked = lowerList(prefs.blockedGroups);
  const acceptedTags = lowerList(prefs.acceptedTags);
  const quality = String(prefs.quality || '').trim().toLowerCase();

  const accepted = [];
  for (const result of results || []) {
    if (!result || typeof result.name !== 'string' || !isSafeName(result.name)) continue;
    if (result.dupe) continue; // already shared, queued or downloaded
    if (!isVideoResult(result)) continue;
    const size = Number(result.size) || 0;
    if (size <= 0 || (prefs.maxSizeBytes && size > prefs.maxSizeBytes)) continue;

    const parsed = parseRelease(result.name);
    if (!matchesEpisode(parsed, identity, season, episode)) continue;

    const group = parsed.group.toLowerCase();
    if (group && blocked.includes(group)) continue;
    if (quality && prefs.qualityRequired && parsed.resolution !== quality) continue;
    // Another language, a dub, burnt-in subtitles, extras, a subpack: not the episode
    if (parsed.contentTags.length > 0) continue;
    if (parsed.languageTags.some((t) => !acceptedTags.includes(t))) continue;

    const groupRank = group && preferred.includes(group) ? preferred.indexOf(group) : preferred.length;
    accepted.push({
      result,
      parsed,
      groupRank,
      qualityHit: quality && parsed.resolution === quality ? 0 : 1,
      isDirectory: result.type.id === 'directory' ? 1 : 0,
      users: Number(result.users && result.users.count) || Number(result.hits) || 0,
      freeSlots: Number(result.slots && result.slots.free) || 0,
    });
  }

  // The release folder before a loose video of the same release: it carries the .nfo/.sfv the
  // client checks a release with, and the download sorter files a folder whole
  accepted.sort((a, b) => (a.groupRank - b.groupRank)
    || (a.qualityHit - b.qualityHit)
    || (b.isDirectory - a.isDirectory)
    || (b.users - a.users)
    || (b.freeSlots - a.freeSlots)
    || (a.result.name < b.result.name ? -1 : a.result.name > b.result.name ? 1 : 0));

  return accepted;
};

// A queued bundle already brings this episode (the episode itself, or a pack of its season)
const bundleCovers = (bundleName, identity, season, episode) => {
  const parsed = parseRelease(String(bundleName || ''));
  if (!parsed || !matchesShow(parsed, identity) || parsed.season !== season) {
    return false;
  }

  return parsed.seasonPack || parsed.episode === episode
    || (parsed.multiEpisode && parsed.episode <= episode && episode <= lastEpisodeOf(parsed.name, parsed.episode));
};

const lastEpisodeOf = (name, first) => {
  const numbers = Array.from(String(name).matchAll(/(?:E|-)(\d{1,3})/gi)).map((m) => Number(m[1]));
  return Math.max(first, ...numbers.filter((n) => n >= first && n < first + 10));
};

module.exports = {
  normalizeTitle,
  splitTitleYear,
  parseRelease,
  showIdentity,
  matchesShow,
  matchesEpisode,
  searchPattern,
  rankResults,
  bundleCovers,
  isSafeName,
  episodeTag,
};
