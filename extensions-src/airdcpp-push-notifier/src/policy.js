'use strict';

// Decides whether a notification may go out now: quiet hours, a per-source cooldown and a global
// rate limit. The clock is injected so the tests can drive time.

// "HH:MM" -> minutes after midnight, or null when empty or malformed
const parseClock = (value) => {
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(value || '');
  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return null;
  }

  return hours * 60 + minutes;
};

// True when the local time falls inside [start, end). A window that crosses midnight
// (22:00-07:00) is supported; equal or unparsable ends mean "no quiet hours".
const isQuietTime = (date, start, end) => {
  const from = parseClock(start);
  const to = parseClock(end);
  if (from === null || to === null || from === to) {
    return false;
  }

  const now = date.getHours() * 60 + date.getMinutes();
  return from < to ? (now >= from && now < to) : (now >= from || now < to);
};

const createPolicy = ({ now = () => Date.now() } = {}) => {
  const lastSent = new Map(); // cooldown key -> ms
  let windowStart = 0;
  let sentInWindow = 0;
  let suppressed = 0;

  // Returns { send: boolean, reason?: string }. A permitted notification is recorded at once,
  // so two events racing for the same slot cannot both pass.
  const check = (notification, { cooldownSeconds, maxPerMinute, quietStart, quietEnd }) => {
    const t = now();

    if (isQuietTime(new Date(t), quietStart, quietEnd)) {
      return { send: false, reason: 'quiet_hours' };
    }

    if (cooldownSeconds > 0 && notification.key) {
      const previous = lastSent.get(notification.key);
      if (previous !== undefined && t - previous < cooldownSeconds * 1000) {
        return { send: false, reason: 'cooldown' };
      }
    }

    if (t - windowStart >= 60 * 1000) {
      windowStart = t;
      sentInWindow = 0;
    }

    if (maxPerMinute > 0 && sentInWindow >= maxPerMinute) {
      suppressed++;
      return { send: false, reason: 'rate_limit' };
    }

    sentInWindow++;
    if (notification.key) {
      lastSent.set(notification.key, t);
      if (lastSent.size > 2000) {
        // Bounded: drop the oldest entries (Map keeps insertion order)
        for (const key of Array.from(lastSent.keys()).slice(0, 1000)) {
          lastSent.delete(key);
        }
      }
    }

    return { send: true };
  };

  // Number of notifications dropped by the rate limit since the last call
  const takeSuppressed = () => {
    const count = suppressed;
    suppressed = 0;
    return count;
  };

  return { check, takeSuppressed };
};

module.exports = { parseClock, isQuietTime, createPolicy };
