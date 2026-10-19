'use strict';

// The learned rules, per hub address, with where each came from. Written to disk at every change
// (temporary file + rename): the client ends extensions without warning on Windows.

const fs = require('fs');
const path = require('path');

const { RULES } = require('./rules');

const STATE_FILE = 'hub-rules.json';
const MAX_HUBS = 300;
const MAX_EXCERPT = 200;

const excerpt = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_EXCERPT);

const createStore = (dirOf, logger, now) => {
  let hubs = {};

  const fileOf = () => path.join(dirOf() || '.', STATE_FILE);

  const load = () => {
    try {
      const data = JSON.parse(fs.readFileSync(fileOf(), 'utf8'));
      hubs = (data && typeof data.hubs === 'object' && data.hubs) || {};
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error(`Could not read ${STATE_FILE}, starting empty: ${error.message}`);
      }

      hubs = {};
    }
  };

  const save = () => {
    const file = fileOf();
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, hubs }, null, 1));
      fs.renameSync(tmp, file);
    } catch (error) {
      logger.error(`Could not save ${STATE_FILE}: ${error.message}`);
    }
  };

  // The oldest hubs go first once there are too many: a hub list scan must not grow this forever
  const prune = () => {
    const keys = Object.keys(hubs);
    if (keys.length <= MAX_HUBS) {
      return;
    }

    keys.sort((a, b) => (hubs[a].updated || 0) - (hubs[b].updated || 0));
    for (const key of keys.slice(0, keys.length - MAX_HUBS)) {
      delete hubs[key];
    }
  };

  const get = (key) => hubs[key] || null;

  const ensure = (key, url, name) => {
    if (!hubs[key]) {
      hubs[key] = { url: url || key, name: name || '', limits: {}, kick: null, warned: {}, updated: now() };
    }

    const record = hubs[key];
    if (url) record.url = url;
    if (name) record.name = name;
    return record;
  };

  // Replaces what one source says about a hub. Saves only when a value changed, so a MOTD that
  // repeats on every connect writes nothing.
  const setLimits = (key, url, name, source, limits, text, { replace = false } = {}) => {
    const record = ensure(key, url, name);
    const current = record.limits[source] || {};
    const next = replace ? {} : { ...current };
    let changed = replace && Object.keys(current).some((rule) => !(rule in limits));
    for (const [ rule, value ] of Object.entries(limits)) {
      if (!RULES[rule] || !Number.isFinite(value)) continue;
      if (!current[rule] || current[rule].value !== value) {
        next[rule] = { value, at: now(), ...(text ? { text: excerpt(text) } : {}) };
        changed = true;
      } else {
        next[rule] = current[rule];
      }
    }

    if (changed) {
      record.limits[source] = next;
      record.updated = now();
      prune();
      save();
    }

    return changed;
  };

  const clearLimits = (key, source, rule) => {
    const record = hubs[key];
    if (!record || !record.limits[source]) {
      return false;
    }

    if (rule) {
      if (!(rule in record.limits[source])) return false;
      delete record.limits[source][rule];
    } else {
      delete record.limits[source];
    }

    record.updated = now();
    save();
    return true;
  };

  const forgetLearned = (key) => {
    const record = hubs[key];
    if (!record) {
      return false;
    }

    const user = record.limits.user;
    record.limits = user ? { user } : {};
    record.kick = null;
    record.warned = {};
    record.updated = now();
    save();
    return true;
  };

  const recordKick = (key, url, name, kick) => {
    const record = ensure(key, url, name);
    record.kick = { at: now(), text: excerpt(kick.text), rules: kick.rules, limits: kick.limits || {} };
    record.updated = now();
    const numeric = Object.fromEntries(Object.entries(kick.limits || {}).filter(([ rule ]) => RULES[rule]));
    if (Object.keys(numeric).length) {
      // setLimits saves; otherwise save here
      if (setLimits(key, url, name, 'kick', numeric, kick.text)) return;
    }

    prune();
    save();
  };

  const markWarned = (key, rule, level) => {
    const record = hubs[key];
    if (!record) return;
    record.warned[rule] = { at: now(), level };
    save();
  };

  return { load, save, get, ensure, setLimits, clearLimits, forgetLearned, recordKick, markWarned, all: () => hubs, STATE_FILE };
};

module.exports = { createStore, STATE_FILE, MAX_HUBS };
