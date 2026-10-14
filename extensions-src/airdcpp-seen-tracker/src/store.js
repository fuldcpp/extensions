'use strict';

// Who was last seen when: one record per user (CID), the latest join, leave or "still there".
// Pure apart from the clock passed in; covered by the unit tests.

const MAX_ENTRIES = 100000;

const isEntry = (e) => !!e && typeof e === 'object' && typeof e.nick === 'string' && e.nick.length > 0 &&
  typeof e.at === 'number' && Number.isFinite(e.at) && typeof e.event === 'string';

// Only well-formed records are loaded: one bad record must not break every /seen
const sanitizeEntries = (raw) => {
  const out = {};
  for (const [ cid, e ] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (cid && isEntry(e)) {
      out[cid] = { nick: e.nick, hub: String(e.hub || ''), hubUrl: String(e.hubUrl || ''), at: e.at, event: e.event, ...(e.run ? { run: String(e.run) } : {}) };
    }
  }

  return out;
};

const createStore = (initial = {}) => {
  const entries = new Map(Object.entries(sanitizeEntries(initial))); // cid -> entry
  const changes = new Map(); // cid -> entry, not yet written to the log

  const put = (cid, entry) => {
    entries.delete(cid); // re-insert: Map order then follows recency, for pruning
    entries.set(cid, entry);
    changes.set(cid, entry);
  };

  // A join or a leave seen live. Own and nickless users are ignored.
  // `run` marks joins made by this run of the extension (see markPresentAtShutdown).
  const record = (user, event, at, run) => {
    if (!user || !user.cid || !user.nick || (Array.isArray(user.flags) && user.flags.includes('self'))) {
      return;
    }

    put(user.cid, {
      nick: String(user.nick), hub: String(user.hub_name || user.hub_url || ''), hubUrl: String(user.hub_url || ''),
      at, event, ...(event === 'joined' && run ? { run } : {}),
    });
  };

  // Users still marked as joined when we stopped seeing their hub (our own disconnect or
  // shutdown): they were there until `at`. No per-user leave events exist for that case.
  const markPresent = (cids, at) => {
    for (const cid of cids) {
      const e = entries.get(cid);
      if (e && e.event === 'joined') {
        put(cid, { nick: e.nick, hub: e.hub, hubUrl: e.hubUrl, at, event: 'present' });
      }
    }
  };

  // After a restart: joins recorded by the previous run, which was last alive at `aliveAt`
  const markPresentAtShutdown = (run, aliveAt) => {
    const cids = [];
    for (const [ cid, e ] of entries) {
      if (e.event === 'joined' && e.run === run) {
        cids.push(cid);
      }
    }

    markPresent(cids, aliveAt);
    return cids.length;
  };

  // Drops records older than the retention and keeps at most MAX_ENTRIES (the most recent)
  const prune = (now, retentionDays) => {
    const limit = now - retentionDays * 24 * 60 * 60;
    let dropped = 0;
    for (const [ cid, entry ] of entries) {
      if (entry.at < limit) {
        entries.delete(cid);
        dropped++;
      }
    }

    while (entries.size > MAX_ENTRIES) {
      entries.delete(entries.keys().next().value);
      dropped++;
    }

    return dropped;
  };

  // Records whose nick matches: exact (case-insensitive) first, else nicks containing the text.
  // `hubUrl` limits the search to records from one hub.
  const find = (text, { limit = 5, hubUrl = null } = {}) => {
    const wanted = String(text || '').trim().toLowerCase();
    if (!wanted) {
      return [];
    }

    const exact = [];
    const partial = [];
    for (const e of entries.values()) {
      if (hubUrl && e.hubUrl !== hubUrl) {
        continue;
      }

      const nick = e.nick.toLowerCase();
      if (nick === wanted) {
        exact.push(e);
      } else if (nick.includes(wanted)) {
        partial.push(e);
      }
    }

    return (exact.length > 0 ? exact : partial).sort((a, b) => b.at - a.at).slice(0, limit);
  };

  // Changes since the last call, for the append-only log. Put back with restoreChanges() when
  // the write fails, so nothing is lost until the next successful write.
  const takeChanges = () => {
    const out = Array.from(changes.entries());
    changes.clear();
    return out;
  };

  const restoreChanges = (list) => {
    for (const [ cid, entry ] of list) {
      if (!changes.has(cid)) {
        changes.set(cid, entry);
      }
    }
  };

  // Replays a log line written by takeChanges()
  const apply = (cid, entry) => {
    if (cid && isEntry(entry)) {
      entries.delete(cid);
      entries.set(cid, entry);
    }
  };

  return {
    record, markPresent, markPresentAtShutdown, prune, find, takeChanges, restoreChanges, apply,
    toJSON: () => Object.fromEntries(entries), size: () => entries.size, pendingChanges: () => changes.size,
  };
};

const UNITS = [ [ 'year', 365 * 86400 ], [ 'week', 7 * 86400 ], [ 'day', 86400 ], [ 'hour', 3600 ], [ 'minute', 60 ] ];

// "3 days 4 hours", "2 weeks", "12 minutes", "less than a minute": the largest unit and the next
// one only when it is not zero
const formatAgo = (seconds) => {
  let rest = Math.max(0, Math.floor(seconds));
  for (let i = 0; i < UNITS.length; i++) {
    const [ name, size ] = UNITS[i];
    const count = Math.floor(rest / size);
    if (count > 0) {
      const parts = [ `${count} ${name}${count === 1 ? '' : 's'}` ];
      rest -= count * size;
      if (i + 1 < UNITS.length) {
        const [ nextName, nextSize ] = UNITS[i + 1];
        const next = Math.floor(rest / nextSize);
        if (next > 0) {
          parts.push(`${next} ${nextName}${next === 1 ? '' : 's'}`);
        }
      }

      return parts.join(' ');
    }
  }

  return 'less than a minute';
};

const EVENT_TEXT = { left: 'leaving', joined: 'joining', present: 'still online when we last saw the hub' };

const describe = (e, now) => `${e.nick} was last seen ${formatAgo(now - e.at)} ago on ${e.hub} (${EVENT_TEXT[e.event] || e.event})`;

// The answer for the local "/seen <text>". `online`: users online now (users/search_nicks).
const answer = (text, store, online, now) => {
  const wanted = String(text || '').trim();
  if (!wanted) {
    return 'Usage: /seen <nick>';
  }

  const lower = wanted.toLowerCase();
  const onlineExact = (online || []).filter((u) => u.nick && u.nick.toLowerCase() === lower);
  if (onlineExact.length > 0) {
    const hubs = [ ...new Set(onlineExact.map((u) => u.hub_name || u.hub_url)) ].join(', ');
    return `${onlineExact[0].nick} is online now (${hubs})`;
  }

  const found = store.find(wanted);
  if (found.length === 0) {
    return `No record of ${wanted}. Users are recorded from the moment this extension runs.`;
  }

  return found.map((e) => describe(e, now)).join('\n');
};

// The answer posted to MAIN CHAT for someone else's "!seen <nick>": one line, a fixed prefix (so
// it can never start with "/" and run a command, or "!"/"+" and trigger a hub bot), never the
// asker's text when nothing matched, and nothing from other hubs.
const PUBLIC_PREFIX = '[seen] ';
const NICK_TOKEN = /^!seen\s+(\S{1,64})$/i;

const publicQueryOf = (text) => {
  const match = NICK_TOKEN.exec(String(text || '').trim());
  return match ? match[1] : null;
};

const publicAnswer = (nick, store, onlineHere, hubUrl, now) => {
  const lower = nick.toLowerCase();
  const here = (onlineHere || []).find((u) => u.nick && u.nick.toLowerCase() === lower);
  if (here) {
    return `${PUBLIC_PREFIX}${here.nick} is online now`;
  }

  const exact = store.find(nick, { hubUrl, limit: 1 }).filter((e) => e.nick.toLowerCase() === lower);
  if (exact.length === 0) {
    return `${PUBLIC_PREFIX}No record of that nick on this hub.`;
  }

  const e = exact[0];
  return `${PUBLIC_PREFIX}${e.nick} was last seen ${formatAgo(now - e.at)} ago`;
};

module.exports = { createStore, sanitizeEntries, formatAgo, answer, publicQueryOf, publicAnswer, MAX_ENTRIES, PUBLIC_PREFIX };
