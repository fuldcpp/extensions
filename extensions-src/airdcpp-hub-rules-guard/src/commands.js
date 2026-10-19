'use strict';

// "/rules" typed in a hub window. Pure parsing: returns what to do, main.js does it.

const { RULES, parseSizeInput } = require('./rules');

const HELP = [
  '/rules: the rules known for this hub next to your own values (airdcpp-hub-rules-guard)',
  '/rules set minshare 50GB | minslots 3 | maxslots 20 | maxhubs 10 | hubs 10/5/3 | slotratio 0.5',
  '/rules clear <name> | /rules clear all: remove what you set for this hub',
  '/rules forget: drop what was learned from this hub (messages, kicks, hub list); keeps what you set',
];

const BY_COMMAND = Object.fromEntries(Object.entries(RULES).filter(([ , def ]) => def.command).map(([ rule, def ]) => [ def.command, rule ]));

const parseCount = (text, min, max) => {
  if (!/^\d{1,4}$/.test(String(text || '').trim())) return null;
  const value = Number(text);
  return value >= min && value <= max ? value : null;
};

const parseValue = (name, valueText) => {
  if (name === 'hubs') {
    const m = /^\s*(\d{1,3})\s*\/\s*(\d{1,3})\s*\/\s*(\d{1,3})\s*$/.exec(valueText);
    if (!m) return { error: 'Use hubs <normal>/<registered>/<op>, e.g. hubs 10/5/3' };
    return { limits: { max_hubs_normal: Number(m[1]), max_hubs_registered: Number(m[2]), max_hubs_op: Number(m[3]) } };
  }

  const rule = BY_COMMAND[name];
  if (!rule) {
    return { error: `Unknown rule "${name}". Known: ${Object.keys(BY_COMMAND).join(', ')}, hubs` };
  }

  if (RULES[rule].size) {
    const bytes = parseSizeInput(valueText);
    return bytes ? { limits: { [rule]: bytes } } : { error: 'Give a size with a unit, e.g. 50GB or 1.5TB' };
  }

  if (RULES[rule].ratio) {
    const value = Number(String(valueText).replace(',', '.'));
    return value > 0 && value <= 100 ? { limits: { [rule]: value } } : { error: 'Give slots per hub as a number, e.g. 0.5' };
  }

  const count = parseCount(valueText, 1, 1000);
  return count ? { limits: { [rule]: count } } : { error: 'Give a whole number between 1 and 1000' };
};

// args: tokens after "/rules"
const parseRulesCommand = (args) => {
  const tokens = (args || []).map(String);
  const verb = (tokens[0] || '').toLowerCase();
  if (!verb) return { action: 'show' };
  if (verb === 'help') return { action: 'help' };
  if (verb === 'forget') return { action: 'forget' };

  if (verb === 'set') {
    const name = (tokens[1] || '').toLowerCase();
    const valueText = tokens.slice(2).join('');
    if (!name || !valueText) return { action: 'error', text: 'Usage: /rules set <name> <value>, e.g. /rules set minshare 50GB' };
    const parsed = parseValue(name, valueText);
    return parsed.error ? { action: 'error', text: parsed.error } : { action: 'set', limits: parsed.limits };
  }

  if (verb === 'clear') {
    const name = (tokens[1] || '').toLowerCase();
    if (!name) return { action: 'error', text: 'Usage: /rules clear <name> or /rules clear all' };
    if (name === 'all') return { action: 'clear', rules: null };
    if (name === 'hubs') return { action: 'clear', rules: [ 'max_hubs_normal', 'max_hubs_registered', 'max_hubs_op' ] };
    const rule = BY_COMMAND[name];
    return rule ? { action: 'clear', rules: [ rule ] } : { action: 'error', text: `Unknown rule "${name}"` };
  }

  return { action: 'error', text: `Unknown /rules option "${verb}". Try /rules help` };
};

module.exports = { HELP, parseRulesCommand };
