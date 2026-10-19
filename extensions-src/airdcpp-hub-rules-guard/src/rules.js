'use strict';

// Pure text handling: reading hub rules out of hub messages, hub addresses, sizes and tags.
//
// The parser is deliberately conservative. It only takes a value when a rule phrase is followed
// by a clear number (and, for share sizes, a unit). When one message names several values for the
// same rule (hubs often list one per user class), it keeps the most lenient one: the smallest
// minimum, the largest maximum. A warning based on that is never a false alarm about a stricter
// class the user is not in.
//
// Phrasings it was written against (hub software defaults and common scripts):
//   PtokaX / scripts:  "Min share: 50 GB", "Minimum share is 100 GiB", "Max hubs: 10",
//                      "Your share is too small! Minimum share is 20 GB."
//   Verlihub:          "You share 1.5 GB, but minimum allowed is 5.0 GB",
//                      "Too many open hubs, max is 10", "Too few open slots, min is 2",
//                      "Too many open slots, max is 20"
//   uhub:              "User is not sharing enough", "User have too few upload slots.",
//                      "User is on too many hubs." (rule named, no number)
//   ADCH++ / Luadch:   "You need to share at least 20 GB", "Min. slots: 3",
//                      "Max hubs: 10/5/3" (normal/registered/op)
//   FlexHub / misc:    "Slot ratio: 0.5", "open 2 slots per hub", "Min slots per hub: 2"
//   This client:       "This hub requires a minimum share of 5.00 GiB to search (...)"

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;
const TIB = GIB * 1024;
const MAX_SHARE = 10 * 1024 * TIB; // 10 PiB: anything larger is not a real rule
const MAX_TEXT = 8000;             // a long MOTD is still scanned, a flood is not

// Every rule this extension knows, its direction and its name in /rules
const RULES = {
  min_share: { kind: 'min', title: 'min share', command: 'minshare', size: true },
  min_slots: { kind: 'min', title: 'min slots', command: 'minslots' },
  max_slots: { kind: 'max', title: 'max slots', command: 'maxslots' },
  max_hubs: { kind: 'max', title: 'max hubs', command: 'maxhubs' },
  max_hubs_normal: { kind: 'max', title: 'max hubs as a normal user', command: null },
  max_hubs_registered: { kind: 'max', title: 'max hubs as registered', command: null },
  max_hubs_op: { kind: 'max', title: 'max hubs as operator', command: null },
  min_slot_ratio: { kind: 'min', title: 'min slots per hub', command: 'slotratio', ratio: true },
};

const RULE_ORDER = Object.keys(RULES);

const NUM = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:[.,]\\d+)?)';
const UNIT = '([kmgt])(i?b(?:ytes?)?)?\\b';

const parseNumber = (text) => {
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) {
    return Number(text.replace(/,/g, ''));
  }

  // "5,00 GiB": a decimal comma (the client itself writes one in some locales)
  return Number(text.replace(',', '.'));
};

const UNIT_BYTES = { k: KIB, m: MIB, g: GIB, t: TIB };

// "50 GB", "1.5TiB", "100 GiB"; null for anything without a clear unit
const sizeOf = (numberText, unitLetter, unitRest) => {
  const letter = String(unitLetter || '').toLowerCase();
  // A bare "m" or "k" is too often minutes or thousands
  if ((letter === 'm' || letter === 'k') && !unitRest) {
    return null;
  }

  const value = parseNumber(numberText);
  const bytes = Math.round(value * UNIT_BYTES[letter]);
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > MAX_SHARE) {
    return null;
  }

  return bytes;
};

// "500 GB" / "1TB" / "50G" typed by the user
const parseSizeInput = (text) => {
  const match = new RegExp(`^\\s*${NUM}\\s*${UNIT}\\s*$`, 'i').exec(String(text || ''));
  return match ? sizeOf(match[1], match[2], match[3]) : null;
};

const SHARE_PATTERNS = [
  // "Min share: 50 GB", "Minimum share is 100 GiB", "minimum share of 5.00 GiB",
  // "Min. share required: 1 TB"
  new RegExp(`\\bmin(?:imum|imal)?\\.?\\s*(?:allowed\\s+|required\\s+)?share\\b[^\\d\\n]{0,25}?${NUM}\\s*${UNIT}`, 'gi'),
  // "You need to share at least 20 GB"
  // (not "Our members share at least 2 TB": a boast, not a rule)
  new RegExp(`\\b(?:need|must|have|required)\\s+(?:to\\s+)?share\\s+at\\s+least\\s+${NUM}\\s*${UNIT}`, 'gi'),
  // "You share 1.5 GB, but minimum allowed is 5.0 GB"
  new RegExp(`\\bshare\\b[^\\n]{0,60}?\\bmin(?:imum)?\\s+(?:allowed|required)\\s*(?:is|of|:|=)?\\s*${NUM}\\s*${UNIT}`, 'gi'),
];

// A count is not the limit when it is followed by what it counts ("for 10 hubs: 4"), or is a
// ratio ("1/hub", "1:2") or a decimal. "3 / Max hubs 10" (a list separator) is still a count.
const COUNT = '(\\d{1,4})\\b(?!\\s*(?:%|:\\s*\\d|/\\s*(?:\\d|hubs?\\b)|[.,]\\d|(?:hubs?|users?|per)\\b))';

// Between a rule name and its number: anything but a digit, and never "per" ("Max slots per IP: 3"
// is another rule, "Min slots per hub: 2" a ratio)
const GAP = (n) => `(?:(?!\\bper\\b)[^\\d\\n]){0,${n}}?`;

const MIN_SLOT_PATTERNS = [
  new RegExp(`\\bmin(?:imum|imal)?\\.?\\s*(?:upload\\s+|open\\s+)?slots?\\b${GAP(20)}${COUNT}`, 'gi'),
  new RegExp(`\\btoo\\s+few\\s+(?:open\\s+|upload\\s+)?slots\\b[^\\d\\n]{0,25}?\\bmin(?:imum)?\\b[^\\d\\n]{0,10}?${COUNT}`, 'gi'),
  new RegExp(`\\b(?:open|have|use)\\s+at\\s+least\\s+${COUNT}\\s*(?:upload\\s+|open\\s+)?slots?\\b`, 'gi'),
];

const MAX_SLOT_PATTERNS = [
  new RegExp(`\\bmax(?:imum|imal)?\\.?\\s*(?:upload\\s+|open\\s+)?slots?\\b${GAP(20)}${COUNT}`, 'gi'),
  new RegExp(`\\btoo\\s+many\\s+(?:open\\s+|upload\\s+)?slots\\b[^\\d\\n]{0,25}?\\bmax(?:imum)?\\b[^\\d\\n]{0,10}?${COUNT}`, 'gi'),
];

const MAX_HUB_PATTERNS = [
  new RegExp(`\\bmax(?:imum|imal)?\\.?\\s*(?:open\\s+|allowed\\s+)?hubs?\\b${GAP(20)}${COUNT}`, 'gi'),
  new RegExp(`\\btoo\\s+many\\s+(?:open\\s+)?hubs\\b[^\\d\\n]{0,25}?\\bmax(?:imum)?\\b[^\\d\\n]{0,10}?${COUNT}`, 'gi'),
];

// "Max hubs: 10/5/3" (normal/registered/op). A bare "Hubs: 5/2/1" is more often the user's own
// counts in a welcome text than a rule, so it is not read.
const HUB_TRIPLE_PATTERN = /\bmax(?:imum)?\.?\s*hubs?\s*(?:[:=]|is)?\s*(\d{1,3})\s*\/\s*(\d{1,3})\s*\/\s*(\d{1,3})\b/gi;

const RATIO = '(\\d{1,3}(?:[.,]\\d{1,3})?)(?!\\s*[:/]\\s*\\d)';
const RATIO_PATTERNS = [
  new RegExp(`\\bslots?\\s*(?:/|per|to)\\s*hubs?\\s*ratio\\b[^\\d\\n]{0,20}?${RATIO}`, 'gi'),
  new RegExp(`\\bslot\\s+ratio\\b[^\\d\\n]{0,20}?${RATIO}`, 'gi'),
  // "Min slots per hub: 2"
  new RegExp(`\\bmin(?:imum|imal)?\\.?\\s*(?:upload\\s+|open\\s+)?slots?\\s+(?:per|for\\s+each|each)\\s+hub\\b[^\\d\\n]{0,10}?${RATIO}`, 'gi'),
  // "open 2 slots per hub", "at least 1 slot per hub" (not "I use 2 slots per hub")
  new RegExp(`\\b(?:at\\s+least|min(?:imum|imal)?\\.?:?|open)\\s+${RATIO}\\s+slots?\\s+(?:per|for\\s+each|each)\\s+hub\\b`, 'gi'),
];

const combine = (limits, rule, value) => {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return;
  }

  const current = limits[rule];
  if (current === undefined) {
    limits[rule] = value;
  } else {
    limits[rule] = RULES[rule].kind === 'min' ? Math.min(current, value) : Math.max(current, value);
  }
};

const eachMatch = (pattern, text, fn) => {
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    fn(match);
    if (match[0].length === 0) {
      pattern.lastIndex++;
    }
  }
};

const countOf = (text, min, max) => {
  const value = Number(text);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
};

// Every limit with a clear number in one message: { min_share: bytes, max_hubs: 10, ... }
const parseLimits = (input) => {
  const text = String(input || '').slice(0, MAX_TEXT);
  const limits = {};

  for (const pattern of SHARE_PATTERNS) {
    eachMatch(pattern, text, (m) => combine(limits, 'min_share', sizeOf(m[1], m[2], m[3])));
  }

  for (const pattern of MIN_SLOT_PATTERNS) {
    eachMatch(pattern, text, (m) => combine(limits, 'min_slots', countOf(m[1], 1, 1000)));
  }

  for (const pattern of MAX_SLOT_PATTERNS) {
    eachMatch(pattern, text, (m) => combine(limits, 'max_slots', countOf(m[1], 1, 1000)));
  }

  eachMatch(HUB_TRIPLE_PATTERN, text, (m) => {
    const values = [ countOf(m[1], 0, 1000), countOf(m[2], 0, 1000), countOf(m[3], 0, 1000) ];
    if (values.some((v) => v === null)) {
      return;
    }

    combine(limits, 'max_hubs_normal', values[0]);
    combine(limits, 'max_hubs_registered', values[1]);
    combine(limits, 'max_hubs_op', values[2]);
  });

  for (const pattern of MAX_HUB_PATTERNS) {
    eachMatch(pattern, text, (m) => combine(limits, 'max_hubs', countOf(m[1], 1, 1000)));
  }

  for (const pattern of RATIO_PATTERNS) {
    eachMatch(pattern, text, (m) => {
      const value = parseNumber(m[1]);
      combine(limits, 'min_slot_ratio', value > 0 && value <= 100 ? value : null);
    });
  }

  return limits;
};

// Rules a (kick) message names even without a number: "User is on too many hubs."
const NAME_PATTERNS = [
  [ 'min_share', /\bshare(?:\s+size)?\s+(?:is\s+)?(?:too\s+(?:small|low)|below)\b|\bnot\s+sharing\s+enough\b|\bmin(?:imum|imal)?\.?\s*share\b|\bshare\s+at\s+least\b/i ],
  [ 'min_slots', /\btoo\s+(?:few|little|low)\s+(?:open\s+|upload\s+)?slots\b|\bslots?\s+(?:is|are)\s+too\s+low\b|\bmin(?:imum|imal)?\.?\s*(?:upload\s+|open\s+)?slots?\b/i ],
  [ 'max_slots', /\btoo\s+many\s+(?:open\s+|upload\s+)?slots\b|\bmax(?:imum|imal)?\.?\s*(?:upload\s+|open\s+)?slots?\b/i ],
  [ 'max_hubs', /\btoo\s+many\s+(?:open\s+)?hubs\b|\bmax(?:imum|imal)?\.?\s*(?:open\s+|allowed\s+)?hubs?\b/i ],
  [ 'min_slot_ratio', /\bslots?\s*(?:\/|per|to)\s*hubs?\s*ratio\b|\bhubs?\s*\/\s*slots?\s+ratio\b|\bslot\s+ratio\b/i ],
];

const ruleNamesIn = (input) => {
  const text = String(input || '').slice(0, MAX_TEXT);
  const names = new Set(Object.keys(parseLimits(text)).map((rule) => (rule.startsWith('max_hubs_') ? 'max_hubs' : rule)));
  for (const [ rule, pattern ] of NAME_PATTERNS) {
    if (pattern.test(text)) {
      names.add(rule);
    }
  }

  return RULE_ORDER.filter((rule) => names.has(rule));
};

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Is this message about us being thrown out (or told to fix something) rather than a general
// notice? "<nick> was kicked", "is kicking <nick> because", "You are being disconnected",
// "Your share is too small", "You need to share at least ..."
const isAboutUs = (input, nick) => {
  const text = String(input || '').slice(0, MAX_TEXT);
  if (nick) {
    const n = escapeRegExp(String(nick));
    if (new RegExp(`(?:^|[\\s<*])${n}\\s+(?:was|is\\s+being|has\\s+been)\\s+(?:kicked|disconnected|banned|redirected|dropped)`, 'i').test(text)
      || new RegExp(`\\b(?:kicking|kicked|disconnecting|redirecting)\\s+${n}(?:$|[\\s:,.!])`, 'i').test(text)) {
      return true;
    }
  }

  return /\byou(?:'re|\s+are|\s+were|\s+have\s+been|\s+will\s+be)?\s+(?:being\s+)?(?:kicked|disconnected|banned|redirected|removed|dropped)\b/i.test(text)
    || /\byour\s+(?:share|slots?|hubs?|tag|hub\s+count)\b/i.test(text)
    || /\byou\s+(?:need|must|have)\s+to\b/i.test(text)
    || /\byou\s+(?:share|have|are\s+on|are\s+in)\b[^\n]{0,40}\b(?:but|too|only|less|more)\b/i.test(text);
};

// "<nick> was kicked" naming us explicitly: a kick even before the hub drops the connection
const isExplicitKickOf = (input, nick) => {
  if (!nick) {
    return false;
  }

  const n = escapeRegExp(String(nick));
  const text = String(input || '').slice(0, MAX_TEXT);
  return new RegExp(`(?:^|[\\s<*])${n}\\s+(?:was|has\\s+been)\\s+kicked\\b`, 'i').test(text)
    || new RegExp(`\\bis\\s+kicking\\s+${n}\\s+because\\b`, 'i').test(text);
};

// One key per hub, whatever way the address was written: "host:port", lowercase. NMDC addresses
// without a port use 411. "adc://" and "adcs://" of the same host and port are the same hub.
const normalizeHubUrl = (input) => {
  let text = String(input || '').trim().toLowerCase();
  if (!text) {
    return '';
  }

  let scheme = 'dchub';
  const schemeMatch = /^([a-z0-9+.-]+):\/\/(.*)$/.exec(text);
  if (schemeMatch) {
    scheme = schemeMatch[1];
    text = schemeMatch[2];
  }

  text = text.split(/[/?#]/)[0];
  let host = text;
  let port = '';
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    host = end > 0 ? text.slice(0, end + 1) : text;
    port = end > 0 && text[end + 1] === ':' ? text.slice(end + 2) : '';
  } else {
    const colon = text.lastIndexOf(':');
    if (colon > 0) {
      host = text.slice(0, colon);
      port = text.slice(colon + 1);
    }
  }

  if (!host) {
    return '';
  }

  if (!/^\d{1,5}$/.test(port)) {
    port = (scheme === 'adc' || scheme === 'adcs') ? '' : '411';
  }

  return port ? `${host}:${port}` : host;
};

// "<FulDC++ 1.11,M:A,H:5/2/1,S:3>" -> { hubs: { normal, registered, op }, slots }
const parseTag = (tag) => {
  const text = String(tag || '');
  const result = {};
  const hubs = /\bH:(\d{1,4})\/(\d{1,4})\/(\d{1,4})\b/.exec(text);
  if (hubs) {
    result.hubs = { normal: Number(hubs[1]), registered: Number(hubs[2]), op: Number(hubs[3]) };
  }

  const slots = /\bS:(\d{1,4})\b/.exec(text);
  if (slots) {
    result.slots = Number(slots[1]);
  }

  return result;
};

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes)) {
    return '?';
  }

  if (bytes >= TIB) {
    return `${(bytes / TIB).toFixed(2)} TiB`;
  }

  if (bytes >= GIB) {
    return `${(bytes / GIB).toFixed(1)} GiB`;
  }

  return `${(bytes / MIB).toFixed(1)} MiB`;
};

const formatRatio = (value) => String(Math.round(value * 100) / 100);

const formatValue = (rule, value) => {
  if (value === undefined || value === null) {
    return '?';
  }

  if (RULES[rule] && RULES[rule].size) {
    return formatBytes(value);
  }

  if (RULES[rule] && RULES[rule].ratio) {
    return formatRatio(value);
  }

  return String(value);
};

module.exports = {
  GIB, TIB, MIB, RULES, RULE_ORDER,
  parseLimits, ruleNamesIn, isAboutUs, isExplicitKickOf, normalizeHubUrl, parseTag, parseSizeInput,
  formatBytes, formatRatio, formatValue,
};
