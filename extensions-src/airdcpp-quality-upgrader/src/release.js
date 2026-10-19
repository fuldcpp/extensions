'use strict';

// Scene release names: "Some.Movie.2019.1080p.BluRay.x264-GRP", "The_Show_S01E02E03_720p_HDTV-GRP".
// Pure functions, no I/O.

const RESOLUTIONS = [ 480, 576, 720, 1080, 2160 ];

const SOURCE_OF = {
  'web-dl': 'web-dl', webdl: 'web-dl', web: 'web-dl', 'amzn': null, 'nf': null,
  webrip: 'webrip', 'web-rip': 'webrip',
  bluray: 'bluray', 'blu-ray': 'bluray', bdrip: 'bluray', brrip: 'bluray', bd: 'bluray', bdremux: 'bluray', remux: 'bluray', 'uhd-bluray': 'bluray',
  hdtv: 'hdtv', pdtv: 'hdtv', sdtv: 'hdtv', dsr: 'hdtv', ahdtv: 'hdtv', hdtvrip: 'hdtv', tvrip: 'hdtv',
  dvdrip: 'dvd', dvd: 'dvd', dvdr: 'dvd', dvd5: 'dvd', dvd9: 'dvd',
};

// Sources that, without a resolution tag, are standard definition by scene convention
const SD_SOURCES = new Set([ 'hdtv', 'dvd' ]);

const CODEC_OF = {
  x264: 'h264', h264: 'h264', avc: 'h264',
  x265: 'hevc', h265: 'hevc', hevc: 'hevc',
  av1: 'av1',
  xvid: 'xvid', divx: 'xvid',
  'vc-1': 'vc1', vc1: 'vc1',
  mpeg2: 'mpeg2',
};

const HDR_OF = {
  dv: 'dv', dovi: 'dv', 'dolby-vision': 'dv', dolbyvision: 'dv',
  hdr: 'hdr', hdr10: 'hdr', 'hdr10+': 'hdr10+', hdr10plus: 'hdr10+', hlg: 'hdr',
};

const FLAGS = new Set([ 'proper', 'repack', 'rerip', 'real', 'internal', 'dirfix', 'nfofix', 'samplefix', 'syncfix', 'limited', 'extended', 'unrated', 'remastered', 'directors', 'dc', 'complete', 'multi', 'multisubs', 'subbed', 'dubbed', 'read', 'nfo', 'retail', 'uncut' ]);

// Words that end the title part when they appear (besides the ones above)
const AUDIO = /^(dd|ddp|dd\+|eac3|ac3|aac|dts|dts-hd|dtshd|truehd|atmos|flac|mp3|opus|lpcm|ma|hra|5|1|2|0|7|6ch|2ch|8ch)$/;

// Words after the title that change WHAT the release is, not how good it is: another language,
// a dub, burnt-in subtitles, a bonus disc, a subtitle pack, a trailer, a cam. A find carrying one
// the kept copy does not carry is never the same thing (quality.js).
const LANGUAGE_TAG = /^(french|truefrench|vff|vfq|vfi|vostfr|subfrench|german|ger|deutsch|dl|ml|italian|ita|spanish|spa|castellano|latino|esp|dutch|flemish|swedish|swe|swesub|norwegian|nor|norsub|danish|dan|dksub|finnish|fin|finsub|nordic|polish|pl|plsub|russian|rus|ukrainian|czech|cz|hungarian|hun|portuguese|por|brazilian|turkish|tur|greek|hebrew|arabic|hindi|tamil|telugu|japanese|jap|jpn|korean|kor|korsub|chinese|chs|cht|mandarin|cantonese|thai|vietnamese|multi|dubbed|subbed|hardsub|hardsubs|hc|hcsub)$/;
const CONTENT_TAG = /^(extras|extra|bonus|featurette|featurettes|subpack|subs|subtitles|trailer|teaser|sample|proof|cam|hdcam|camrip|ts|hdts|telesync|tc|telecine|scr|screener|dvdscr|bdscr|r5|workprint|3d|sbs|hsbs|ou|hou|(disc|disk|cd|part|pt)\d{1,2}|d\d)$/;

// A content word glued after the group with another "-": "-GRP-sample", "-GRP-proof"
const SUFFIX_TAG = /-(sample|proof|subs|subpack|extras|bonus|trailer|teaser|featurettes?)$/i;

const isYear = (t) => /^(19[2-9]\d|20\d\d)$/.test(t);

const parseEpisodeToken = (token) => {
  let m = /^s(\d{1,3})((?:-?e\d{1,4})+)(?:-(\d{1,4}))?$/i.exec(token);
  if (m) {
    const episodes = m[2].split(/-?e/i).filter(Boolean).map(Number);
    if (m[3] !== undefined) {
      episodes.push(Number(m[3]));
    }

    return { season: Number(m[1]), episodes: expandRange(episodes) };
  }

  m = /^(\d{1,2})x(\d{2,3})(?:-?(?:\d{1,2}x)?(\d{2,3}))?$/i.exec(token);
  if (m) {
    const episodes = [ Number(m[2]) ];
    if (m[3] !== undefined) {
      episodes.push(Number(m[3]));
    }

    return { season: Number(m[1]), episodes: expandRange(episodes) };
  }

  m = /^s(\d{1,3})$/i.exec(token);
  if (m) {
    return { season: Number(m[1]), episodes: [] };
  }

  return null;
};

// "E01-E03" is three episodes; "E01E02" is two
const expandRange = (episodes) => {
  if (episodes.length === 2 && episodes[1] > episodes[0] + 1 && episodes[1] - episodes[0] < 50) {
    const all = [];
    for (let e = episodes[0]; e <= episodes[1]; e++) all.push(e);
    return all;
  }

  return [ ...new Set(episodes) ].sort((a, b) => a - b);
};

const resolutionOfToken = (t) => {
  const m = /^(\d{3,4})([pi])$/.exec(t);
  if (m) {
    const n = Number(m[1]);
    return RESOLUTIONS.includes(n) ? n : null;
  }

  if (t === '4k' || t === 'uhd' || t === '2160') {
    return 2160;
  }

  return null;
};

// Turns a width x height into the release-name resolution class. Width first: a 2.39:1 film is
// stored 1920x800 and is a 1080p release.
const resolutionFromSize = (width, height) => {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (w >= 3200 || h >= 1800) return 2160;
  if (w >= 1800 || h >= 1000) return 1080;
  if (w >= 1200 || h >= 700) return 720;
  if (w > 0 || h > 0) return 480;
  return null;
};

const normalizeTitle = (title) => String(title || '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/['`’]/g, '')
  .replace(/[^a-z0-9À-ɏ]+/g, ' ')
  .trim();

const stripExtension = (name) => {
  const m = /^(.*)\.([a-z0-9]{2,4})$/i.exec(name);
  return m && /^(mkv|mp4|avi|m4v|ts|wmv|mov|mpg|mpeg|m2ts|webm|iso)$/i.test(m[2]) ? m[1] : name;
};

// Parses a release name. Never throws. Returns null for an empty string.
// { name, title, titleKey, year, season, episodes, kind, resolution, resolutionTagged, source,
//   codec, hdr, proper, repack, real, properLevel, internal, group }
const parseRelease = (rawName) => {
  if (typeof rawName !== 'string' || !rawName.trim()) {
    return null;
  }

  const name = stripExtension(rawName.trim());
  // "H.264" / "H 265" / "DD5.1" / "AAC2.0" / "DTS-HD.MA" would otherwise split into misleading tokens
  let work = name
    .replace(/(?<![a-z0-9])([hx])[._ ]?(26[45])(?![a-z0-9])/gi, '$1$2')
    .replace(/(?<![a-z0-9])(ddp?|eac3|ac3|aac|dts|truehd|atmos|flac)[._ ]?(\d)[._ ](\d)(?![a-z0-9])/gi, '$1$2$3')
    .replace(/(?<![a-z0-9])web[._ ]dl(?![a-z0-9])/gi, 'WEB-DL')
    .replace(/(?<![a-z0-9])blu[._ ]ray(?![a-z0-9])/gi, 'BluRay')
    .replace(/(?<![a-z0-9])dolby[._ ]vision(?![a-z0-9])/gi, 'DV')
    .replace(/(?<![a-z0-9])hdr10[._ ]?(\+|plus)/gi, 'HDR10+');

  // "...x264-GRP-sample": a content word after the group is not the group (live test 2026-10-19:
  // "sample" was taken for the group and the sample folder judged an upgrade)
  const suffixTags = [];
  for (let m = SUFFIX_TAG.exec(work); m && suffixTags.length < 3; m = SUFFIX_TAG.exec(work)) {
    suffixTags.push(m[1].toLowerCase());
    work = work.slice(0, m.index);
  }

  // Group: after the last "-", when that part has no separators and is not a known token
  let group = null;
  const dash = work.lastIndexOf('-');
  if (dash > 0 && dash < work.length - 1) {
    const tail = work.slice(dash + 1);
    const lowerTail = tail.toLowerCase();
    if (/^[A-Za-z0-9][A-Za-z0-9_]{0,30}$/.test(tail) && !/[. ]/.test(tail)
      && !SOURCE_OF[`${work.slice(0, dash).split(/[._ ]/).pop().toLowerCase()}-${lowerTail}`]
      && !(lowerTail in SOURCE_OF) && !(lowerTail in CODEC_OF) && !resolutionOfToken(lowerTail)
      && !parseEpisodeToken(tail) && !/^e\d{1,4}$/i.test(tail) && !/^\d{1,4}$/.test(tail)) {
      group = tail;
      work = work.slice(0, dash);
    }
  }

  const tokens = work.split(/[._ ]+/).filter(Boolean);
  const out = {
    name: rawName, title: '', titleKey: '', year: null, season: null, episodes: [], kind: null,
    resolution: null, resolutionTagged: false, source: null, codec: null, hdr: null,
    proper: false, repack: false, real: false, properLevel: 0, internal: false, group, tags: [ ...suffixTags ],
  };

  let titleEnd = -1; // index of the first token that is not part of the title
  const markEnd = (i) => {
    if (titleEnd < 0) titleEnd = i;
  };

  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    const t = raw.toLowerCase();

    // Only once the title has ended (or for the flag words that may sit before the resolution,
    // "Movie.2019.MULTi.1080p"), so a title word such as "Bonus" is not a tag
    if (i > 0 && (titleEnd >= 0 || FLAGS.has(t)) && (LANGUAGE_TAG.test(t) || CONTENT_TAG.test(t)) && !out.tags.includes(t)) {
      out.tags.push(t);
    }

    const episode = i > 0 ? parseEpisodeToken(t) : null;
    if (episode && out.season === null) {
      out.season = episode.season;
      out.episodes = episode.episodes;
      markEnd(i);
      continue;
    }

    // "S01E01-E02" split by a separator: "S01E01", "E02"
    if (out.season !== null && /^e\d{1,4}$/.test(t)) {
      out.episodes = expandRange([ ...out.episodes, Number(t.slice(1)) ]);
      continue;
    }

    const resolution = resolutionOfToken(t);
    if (resolution && i > 0) {
      out.resolution = resolution;
      out.resolutionTagged = true;
      markEnd(i);
      continue;
    }

    // "UHD.BluRay" is a 2160p disc source
    if (t in SOURCE_OF && i > 0) {
      if (SOURCE_OF[t]) out.source = out.source || SOURCE_OF[t];
      markEnd(i);
      continue;
    }

    if (t in CODEC_OF && i > 0) {
      out.codec = out.codec || CODEC_OF[t];
      markEnd(i);
      continue;
    }

    if (t in HDR_OF && i > 0) {
      out.hdr = out.hdr === 'dv' ? 'dv' : HDR_OF[t];
      markEnd(i);
      continue;
    }

    const repackN = /^repack(\d)$/.exec(t) || /^rerip(\d)?$/.exec(t);
    if (repackN || FLAGS.has(t)) {
      if (i === 0) continue;
      if (t === 'proper') out.proper = true;
      if (t === 'real') out.real = true;
      if (t === 'internal') out.internal = true;
      if (t.startsWith('repack') || t.startsWith('rerip')) {
        out.repack = true;
        out.repackCount = Math.max(out.repackCount || 1, repackN && repackN[1] ? Number(repackN[1]) : 1);
      }

      // "Limited", "Complete" and the like can be title words; they only end a title when
      // something release-like follows them
      if ([ 'proper', 'repack', 'rerip', 'real', 'internal', 'dirfix', 'nfofix', 'samplefix', 'syncfix' ].includes(t) || repackN) {
        markEnd(i);
      } else if (titleEnd < 0 && tokens.slice(i + 1).some((n) => resolutionOfToken(n.toLowerCase()) || n.toLowerCase() in SOURCE_OF || n.toLowerCase() in CODEC_OF)) {
        // Only when nothing title-like remains before the next marker
        const nextMarker = tokens.slice(i + 1).findIndex((n) => resolutionOfToken(n.toLowerCase()) || n.toLowerCase() in SOURCE_OF || n.toLowerCase() in CODEC_OF || parseEpisodeToken(n.toLowerCase()) || isYear(n));
        if (nextMarker === 0 || tokens.slice(i + 1, i + 1 + nextMarker).every((n) => FLAGS.has(n.toLowerCase()) || isYear(n))) {
          markEnd(i);
        }
      }

      continue;
    }

    if (titleEnd >= 0 && AUDIO.test(t)) {
      continue;
    }
  }

  // The year: the last year-shaped token before the first marker, never the first token
  // ("2001.A.Space.Odyssey.1968.1080p" is the film from 1968)
  const end = titleEnd < 0 ? tokens.length : titleEnd;
  let yearAt = -1;
  for (let i = end - 1; i > 0; i--) {
    if (isYear(tokens[i])) {
      yearAt = i;
      break;
    }
  }

  // Only a year directly before the marker (or before other years) counts: "1917.2019.1080p"
  if (yearAt > 0 && tokens.slice(yearAt + 1, end).every((t) => isYear(t) || FLAGS.has(t.toLowerCase()))) {
    out.year = Number(tokens[yearAt]);
  } else {
    yearAt = -1;
  }

  const titleTokens = tokens.slice(0, yearAt > 0 ? yearAt : end);
  out.title = titleTokens.join(' ');
  out.titleKey = normalizeTitle(out.title);

  out.properLevel = (out.proper || out.repack ? 1 : 0) + (out.real ? 1 : 0) + (out.repackCount > 1 ? out.repackCount - 1 : 0);
  delete out.repackCount;

  // An untagged SD release: "Show.S01E02.HDTV.XviD-GRP"
  if (!out.resolution && (SD_SOURCES.has(out.source) || out.codec === 'xvid')) {
    out.resolution = 480;
  }

  if (out.season !== null) {
    out.kind = out.episodes.length > 0 ? 'episode' : 'season';
  } else if (out.year && (out.resolutionTagged || out.source || out.codec)) {
    out.kind = 'movie';
  }

  return out;
};

// Release-shaped: something a scene group made, not a personal folder that happens to contain a year
const isSceneRelease = (parsed) => Boolean(parsed && parsed.kind && parsed.group && parsed.titleKey
  && (parsed.resolutionTagged || parsed.source || parsed.codec));

// The identity an upgrade has to match exactly: title (+year), and the episode/season numbers
const identityKey = (parsed) => {
  if (!parsed || !parsed.kind || !parsed.titleKey) {
    return null;
  }

  const year = parsed.year ? ` (${parsed.year})` : '';
  if (parsed.kind === 'movie') {
    return `movie:${parsed.titleKey}${year}`;
  }

  const s = `S${String(parsed.season).padStart(2, '0')}`;
  if (parsed.kind === 'season') {
    return `season:${parsed.titleKey}${year}:${s}`;
  }

  return `episode:${parsed.titleKey}${year}:${s}${parsed.episodes.map((e) => `E${String(e).padStart(2, '0')}`).join('')}`;
};

// What to type into a hub search to find other copies of the same thing
const searchPatternOf = (parsed) => {
  if (!parsed || !parsed.kind) return null;
  const words = [ parsed.titleKey ];
  if (parsed.year) words.push(String(parsed.year));
  if (parsed.kind !== 'movie') {
    let s = `S${String(parsed.season).padStart(2, '0')}`;
    if (parsed.kind === 'episode') s += `E${String(parsed.episodes[0]).padStart(2, '0')}`;
    words.push(s);
  }

  return words.join(' ');
};

// Same release apart from the PROPER/REPACK markers (the release a PROPER replaces)
const releaseBaseKey = (parsed) => {
  if (!parsed) return null;
  return [ identityKey(parsed), parsed.resolution, parsed.source, parsed.codec, (parsed.group || '').toLowerCase() ].join('|');
};

module.exports = {
  parseRelease, isSceneRelease, identityKey, searchPatternOf, releaseBaseKey,
  normalizeTitle, resolutionFromSize, stripExtension, RESOLUTIONS,
};
