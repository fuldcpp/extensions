'use strict';

// The hub search budget: at most N searches in any hour, and never two closer than the spacing.
// The times are kept in the state file, so a restart does not hand out a fresh hour.

const HOUR_MS = 60 * 60 * 1000;

const recent = (times, now) => (Array.isArray(times) ? times : []).filter((t) => typeof t === 'number' && t <= now && now - t < HOUR_MS);

// { ok: true } or { ok: false, waitMs }
const canSearch = (times, now, perHour, spacingMs) => {
  const inHour = recent(times, now).sort((a, b) => a - b);
  const last = inHour.length > 0 ? inHour[inHour.length - 1] : null;
  // A time in the future (clock moved back) also blocks for the spacing, never forever
  const future = (Array.isArray(times) ? times : []).filter((t) => typeof t === 'number' && t > now);
  if (future.length > 0) {
    return { ok: false, waitMs: spacingMs };
  }

  if (last !== null && now - last < spacingMs) {
    return { ok: false, waitMs: spacingMs - (now - last) };
  }

  if (inHour.length >= Math.max(1, perHour)) {
    return { ok: false, waitMs: HOUR_MS - (now - inHour[inHour.length - Math.max(1, perHour)]) };
  }

  return { ok: true };
};

// What is worth keeping on disk
const prune = (times, now) => {
  const kept = recent(times, now);
  const future = (Array.isArray(times) ? times : []).filter((t) => typeof t === 'number' && t > now && t - now < HOUR_MS);
  return [ ...kept, ...future ];
};

module.exports = { canSearch, prune, HOUR_MS };
