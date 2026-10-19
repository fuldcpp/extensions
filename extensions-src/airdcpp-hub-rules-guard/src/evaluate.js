'use strict';

// Pure decisions: which limit applies, how our values compare, and whether a warning may go out.

const { RULES, RULE_ORDER, formatBytes, formatRatio, formatValue } = require('./rules');

// Where a limit came from, strongest first: what you entered beats what a kick message said,
// which beats what the hub announced in chat, which beats the public hub list
const SOURCES = [ 'user', 'kick', 'chat', 'hublist' ];
const SOURCE_TITLES = { user: 'set by you', kick: 'kick message', chat: 'hub message', hublist: 'public hub list' };

const effectiveLimits = (record) => {
  const result = {};
  const limits = (record && record.limits) || {};
  for (const rule of RULE_ORDER) {
    for (const source of SOURCES) {
      const entry = limits[source] && limits[source][rule];
      if (entry && Number.isFinite(entry.value)) {
        result[rule] = { value: entry.value, source, at: entry.at };
        break;
      }
    }
  }

  return result;
};

const totalHubs = (hubs) => (hubs ? hubs.normal + hubs.registered + hubs.op : undefined);

// values: { share, slots, hubs: { normal, registered, op }, hubsExact }
// Returns [{ rule, level: 'below' | 'near' | 'above', mine, limit, source, text }]
const evaluate = (limits, values, { shareMarginPercent = 5 } = {}) => {
  const findings = [];
  const add = (rule, level, mine, text) => {
    findings.push({ rule, level, mine, limit: limits[rule].value, source: limits[rule].source, text });
  };

  const share = values.share;
  if (limits.min_share && Number.isFinite(share)) {
    const min = limits.min_share.value;
    if (share < min) {
      add('min_share', 'below', share, `your share ${formatBytes(share)} is below the hub's minimum of ${formatBytes(min)}`);
    } else if (shareMarginPercent > 0 && share < min * (1 + shareMarginPercent / 100)) {
      add('min_share', 'near', share, `your share ${formatBytes(share)} is close to the hub's minimum of ${formatBytes(min)}`);
    }
  }

  const slots = values.slots;
  if (limits.min_slots && Number.isFinite(slots) && slots < limits.min_slots.value) {
    add('min_slots', 'below', slots, `you have ${slots} upload slot(s), the hub wants at least ${limits.min_slots.value}`);
  }

  if (limits.max_slots && Number.isFinite(slots) && slots > limits.max_slots.value) {
    add('max_slots', 'above', slots, `you have ${slots} upload slots, the hub allows at most ${limits.max_slots.value}`);
  }

  const hubs = values.hubs;
  const total = totalHubs(hubs);
  if (limits.max_hubs && Number.isFinite(total) && total > limits.max_hubs.value) {
    add('max_hubs', 'above', total, `you are on ${total} hubs, the hub allows at most ${limits.max_hubs.value}`);
  }

  // Per class only when the counts are the ones the hub sees (from our own tag): counted from
  // the hub list here, registered hubs would be in the normal figure
  if (hubs && values.hubsExact) {
    const classes = [ [ 'max_hubs_normal', 'normal', 'as a normal user' ], [ 'max_hubs_registered', 'registered', 'as registered' ], [ 'max_hubs_op', 'op', 'as operator' ] ];
    for (const [ rule, key, words ] of classes) {
      if (limits[rule] && hubs[key] > limits[rule].value) {
        add(rule, 'above', hubs[key], `you are on ${hubs[key]} hubs ${words}, the hub allows at most ${limits[rule].value}`);
      }
    }
  }

  if (limits.min_slot_ratio && Number.isFinite(slots) && Number.isFinite(total) && total > 0) {
    const ratio = slots / total;
    if (ratio < limits.min_slot_ratio.value) {
      add('min_slot_ratio', 'below', ratio, `you have ${slots} slot(s) for ${total} hubs (${formatRatio(ratio)} per hub), the hub wants at least ${formatRatio(limits.min_slot_ratio.value)} per hub`);
    }
  }

  return findings;
};

// At most one warning per hub, rule and interval. A rule that got worse (close -> below) may
// warn again at once.
const shouldWarn = (warned, finding, now, intervalSeconds) => {
  const last = warned && warned[finding.rule];
  if (!last) {
    return true;
  }

  if (last.level === 'near' && finding.level !== 'near') {
    return true;
  }

  return now - last.at >= intervalSeconds;
};

const describeLimit = (rule, entry) => `${RULES[rule].title} ${formatValue(rule, entry.value)} (${SOURCE_TITLES[entry.source] || entry.source})`;

// Local time, like the client's own timestamps (toISOString would be UTC, unlabelled)
const pad2 = (n) => String(n).padStart(2, '0');
const formatDate = (seconds) => {
  const d = new Date(seconds * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

// The /rules answer: every known limit next to our value
const rulesReport = (hubName, record, values) => {
  const limits = effectiveLimits(record);
  const lines = [];
  const known = RULE_ORDER.filter((rule) => limits[rule]);
  const total = totalHubs(values.hubs);
  const mineOf = (rule) => {
    switch (rule) {
      case 'min_share': return Number.isFinite(values.share) ? formatBytes(values.share) : '?';
      case 'min_slots':
      case 'max_slots': return Number.isFinite(values.slots) ? String(values.slots) : '?';
      case 'max_hubs': return Number.isFinite(total) ? String(total) : '?';
      case 'max_hubs_normal': return values.hubs && values.hubsExact ? String(values.hubs.normal) : '?';
      case 'max_hubs_registered': return values.hubs && values.hubsExact ? String(values.hubs.registered) : '?';
      case 'max_hubs_op': return values.hubs && values.hubsExact ? String(values.hubs.op) : '?';
      case 'min_slot_ratio': return Number.isFinite(values.slots) && total > 0 ? formatRatio(values.slots / total) : '?';
      default: return '?';
    }
  };

  lines.push(`Rules known for ${hubName}:`);
  if (known.length === 0) {
    lines.push('  none yet. Add your own with /rules set minshare 50GB (see /rules help).');
  }

  const failing = new Set(evaluate(limits, values, { shareMarginPercent: 0 }).map((f) => f.rule));
  for (const rule of known) {
    lines.push(`  ${describeLimit(rule, limits[rule])}: yours ${mineOf(rule)}${failing.has(rule) ? '  <- NOT MET' : ''}`);
  }

  if (record && record.kick) {
    lines.push(`  Last disconnect for a rule (${formatDate(record.kick.at)}): ${kickSummary(record.kick)}`);
  }

  return lines;
};

const kickSummary = (kick) => {
  const parts = (kick.rules || []).map((rule) => {
    const value = kick.limits && kick.limits[rule];
    return value !== undefined ? `${RULES[rule].title} ${formatValue(rule, value)}` : RULES[rule].title;
  });

  return parts.length ? parts.join(', ') : 'a hub rule';
};

module.exports = { SOURCES, SOURCE_TITLES, effectiveLimits, evaluate, shouldWarn, rulesReport, kickSummary, describeLimit, formatDate, totalHubs };
