'use strict';

// The search budget and the rotation through the inventory. Pure functions over plain state
// that main.js persists.

const HOUR_MS = 60 * 60 * 1000;

// searches: timestamps (ms) of hub searches already sent
const budgetAllows = (searches, now, { perHour, spacingMs }) => {
  const recent = searches.filter((t) => t > now - HOUR_MS && t <= now);
  if (recent.length >= perHour) {
    return { allowed: false, waitMs: Math.min(...recent) + HOUR_MS - now };
  }

  const last = searches.length > 0 ? Math.max(...searches) : 0;
  if (last > now) {
    // A clock that went back: count from now rather than wait for the old future
    return { allowed: false, waitMs: spacingMs };
  }

  if (now - last < spacingMs) {
    return { allowed: false, waitMs: spacingMs - (now - last) };
  }

  return { allowed: true, waitMs: 0 };
};

const pruneSearches = (searches, now) => searches.filter((t) => t > now - HOUR_MS && t <= now + HOUR_MS);

// The next inventory key to search for: one a passive sighting asked for first, then the one
// checked longest ago (never checked = 0). Keys checked within `recheckMs` are skipped, and so
// are keys `skip` says no.
const pickNext = (keys, items, now, { recheckMs, skip = () => false }) => {
  let best = null;
  let bestScore = Infinity;
  for (const key of keys) {
    if (skip(key)) continue;
    const state = items[key] || {};
    const last = state.lastChecked || 0;
    const prioritized = state.priority && state.priority > last;
    if (!prioritized && now - last < recheckMs && last <= now) continue;
    // Prioritized first (oldest request first), then the oldest check
    const score = prioritized ? state.priority - 1e15 : last;
    if (score < bestScore || (score === bestScore && key < best)) {
      best = key;
      bestScore = score;
    }
  }

  return best;
};

module.exports = { budgetAllows, pruneSearches, pickNext, HOUR_MS };
