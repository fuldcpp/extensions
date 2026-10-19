'use strict';

// Finds the archive sets in one folder from its file names alone. No I/O: the caller lists the
// folder and passes the names in.
//
// Recognised:
//   RAR, new volume names:  name.part1.rar, name.part2.rar, ...  (any digit width)
//   RAR, old volume names:  name.rar, name.r00 ... name.r99, name.s00 ... (up to y99)
//   RAR, single file:       name.rar
//   ZIP:                    name.zip (split: name.z01, name.z02, ... + name.zip)
//   7z:                     name.7z, or name.7z.001, name.7z.002, ...

// The same lists as the media server's (airdcpp/modules/StreamSource.cpp:30 and :44 on master)
const VIDEO_EXTENSIONS = [ 'avi', 'divx', 'flv', 'm2ts', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'ogm', 'ts', 'vob', 'webm', 'wmv' ];
const AUDIO_EXTENSIONS = [ 'aac', 'aif', 'aiff', 'ape', 'flac', 'm4a', 'm4b', 'mp3', 'oga', 'ogg', 'opus', 'wav', 'wma', 'wv' ];
const SUBTITLE_EXTENSIONS = [ 'srt', 'ass', 'ssa', 'sub', 'idx', 'sup', 'vtt' ];

const extensionOf = (name) => {
  const base = String(name).split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};

const isVideoName = (name) => VIDEO_EXTENSIONS.includes(extensionOf(name));
const isAudioName = (name) => AUDIO_EXTENSIONS.includes(extensionOf(name));
const isSubtitleName = (name) => SUBTITLE_EXTENSIONS.includes(extensionOf(name));
const isMediaName = (name) => isVideoName(name) || isAudioName(name) || isSubtitleName(name);

const PART_RAR = /^(.*)\.part(\d+)\.rar$/i;
// r00..y99: 800 volumes. .z01 and up are the pieces of a split zip.
const OLD_VOLUME = /^(.*)\.([r-y])(\d\d)$/i;
const PLAIN_RAR = /^(.*)\.rar$/i;
const ZIP = /^(.*)\.zip$/i;
const ZIP_SPLIT = /^(.*)\.z(\d\d)$/i;
const SEVEN = /^(.*)\.7z$/i;
const SEVEN_SPLIT = /^(.*)\.7z\.(\d{3})$/i;

// Old-style volume order: .rar first, then r00..r99, s00..s99, ...
const oldVolumeIndex = (letter, digits) => (letter.toLowerCase().charCodeAt(0) - 'r'.charCodeAt(0)) * 100 + Number(digits);
const oldVolumeName = (base, index, sample) => {
  // Keep the case of the extension the set already uses
  const upper = /\.[R-Y]\d\d$/.test(sample);
  const letter = String.fromCharCode('r'.charCodeAt(0) + Math.floor(index / 100));
  return `${base}.${upper ? letter.toUpperCase() : letter}${String(index % 100).padStart(2, '0')}`;
};

const key = (kind, base) => `${kind}:${base.toLowerCase()}`;

// names: file names (not paths) in one folder. Returns
// [{ kind: 'rar'|'zip'|'7z', base, first, volumes: [names, in order], missing: [names] }]
const detectSets = (names) => {
  const sets = new Map();
  const get = (kind, base) => {
    const k = key(kind, base);
    if (!sets.has(k)) sets.set(k, { kind, base, style: null, parts: [] });
    return sets.get(k);
  };

  // A name that ends ".partN.rar" belongs to a new-style set even when its base also has a
  // plain ".rar" sibling
  for (const name of names) {
    let m;
    if ((m = PART_RAR.exec(name))) {
      const s = get('rar', m[1]);
      s.style = 'part';
      s.parts.push({ name, index: Number(m[2]), width: m[2].length });
    }
  }

  for (const name of names) {
    let m;
    if (PART_RAR.test(name)) {
      continue;
    }

    if ((m = PLAIN_RAR.exec(name))) {
      const s = get('rar', m[1]);
      if (s.style === 'part') continue; // a stray name.rar beside name.part1.rar: not a volume of that set
      s.style = s.style || 'old';
      s.parts.push({ name, index: -1 });
    } else if ((m = OLD_VOLUME.exec(name))) {
      const s = get('rar', m[1]);
      if (s.style === 'part') continue;
      s.style = 'old';
      s.parts.push({ name, index: oldVolumeIndex(m[2], m[3]) });
    } else if ((m = ZIP.exec(name))) {
      get('zip', m[1]).parts.push({ name, index: 1e6 }); // the .zip is the LAST piece of a split zip
    } else if ((m = ZIP_SPLIT.exec(name))) {
      get('zip', m[1]).parts.push({ name, index: Number(m[2]) });
    } else if ((m = SEVEN.exec(name))) {
      get('7z', m[1]).parts.push({ name, index: 0 });
    } else if ((m = SEVEN_SPLIT.exec(name))) {
      const s = get('7z', m[1]);
      s.style = 'split';
      s.parts.push({ name, index: Number(m[2]) });
    }
  }

  const result = [];
  for (const s of sets.values()) {
    const parts = s.parts.slice().sort((a, b) => a.index - b.index);
    const missing = [];
    let first = null;

    if (s.kind === 'rar' && s.style === 'part') {
      const width = parts[0].width;
      const max = parts[parts.length - 1].index;
      const have = new Set(parts.map((p) => p.index));
      for (let i = 1; i <= max; i++) {
        if (!have.has(i)) missing.push(`${s.base}.part${String(i).padStart(width, '0')}.rar`);
      }

      const p1 = parts.find((p) => p.index === 1);
      first = p1 ? p1.name : null;
    } else if (s.kind === 'rar') {
      const head = parts.find((p) => p.index === -1);
      if (!head) {
        // Volumes without the .rar: this is no set the decoder can open
        missing.push(`${s.base}.rar`);
      }

      first = head ? head.name : null;
      const numbered = parts.filter((p) => p.index >= 0);
      if (numbered.length > 0) {
        const max = numbered[numbered.length - 1].index;
        const have = new Set(numbered.map((p) => p.index));
        for (let i = 0; i <= max; i++) {
          if (!have.has(i)) missing.push(oldVolumeName(s.base, i, numbered[0].name));
        }
      }
    } else if (s.kind === 'zip') {
      const last = parts.find((p) => p.index === 1e6);
      if (!last) missing.push(`${s.base}.zip`);
      const numbered = parts.filter((p) => p.index !== 1e6);
      if (numbered.length > 0) {
        const max = numbered[numbered.length - 1].index;
        const have = new Set(numbered.map((p) => p.index));
        for (let i = 1; i <= max; i++) {
          if (!have.has(i)) missing.push(`${s.base}.z${String(i).padStart(2, '0')}`);
        }
      }

      // 7-Zip opens a split zip from its .zip (the last piece)
      first = last ? last.name : null;
    } else if (s.kind === '7z') {
      if (s.style === 'split') {
        const numbered = parts.filter((p) => p.index > 0);
        const max = numbered.length ? numbered[numbered.length - 1].index : 0;
        const have = new Set(numbered.map((p) => p.index));
        for (let i = 1; i <= max; i++) {
          if (!have.has(i)) missing.push(`${s.base}.7z.${String(i).padStart(3, '0')}`);
        }

        const one = numbered.find((p) => p.index === 1);
        first = one ? one.name : null;
      } else {
        first = parts[0].name;
      }
    }

    result.push({ kind: s.kind, base: s.base, first, volumes: parts.map((p) => p.name), missing });
  }

  return result.sort((a, b) => a.base.localeCompare(b.base) || a.kind.localeCompare(b.kind));
};

// The file names an SFV lists (comments start with ';'). The CRC is not needed here: the core
// checks it when a download finishes; this only learns which volumes should exist.
const parseSfv = (text) => {
  const names = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    const m = /^(.+?)\s+([0-9a-f]{8})$/i.exec(line);
    if (m) names.push(m[1].trim());
  }

  return names;
};

// SFV-listed volumes of this set that are not on disk. A set without an SFV has only the gaps
// detectSets found.
const missingFromSfv = (set, sfvNames, presentNames) => {
  const present = new Set(presentNames.map((n) => n.toLowerCase()));
  const own = new Set();
  for (const s of detectSets(sfvNames)) {
    if (s.kind === set.kind && s.base.toLowerCase() === set.base.toLowerCase()) {
      s.volumes.forEach((v) => own.add(v));
    }
  }

  return Array.from(own).filter((n) => !present.has(n.toLowerCase()));
};

// Wildcards (* and ?) matched against the folder's name and its full path, case-insensitively.
// One pattern per line or separated by ';'.
const parsePatterns = (text) => String(text || '')
  .split(/[\r\n;]+/)
  .map((p) => p.trim())
  .filter(Boolean);

const wildcardToRegExp = (pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');

const isExcluded = (folderPath, patterns) => {
  const clean = String(folderPath).replace(/[\\/]+$/, '');
  const name = clean.split(/[\\/]/).pop();
  return patterns.some((p) => {
    const re = wildcardToRegExp(p);
    return re.test(name) || re.test(clean);
  });
};

// Sub folders of a release that are not unpacked by default
const SAMPLE_FOLDER = /^(sample|samples)$/i;
const SKIPPED_FOLDER = /^(proof|proofs)$/i;

module.exports = {
  detectSets, parseSfv, missingFromSfv, parsePatterns, isExcluded,
  isVideoName, isAudioName, isSubtitleName, isMediaName, extensionOf,
  SAMPLE_FOLDER, SKIPPED_FOLDER, VIDEO_EXTENSIONS,
};
