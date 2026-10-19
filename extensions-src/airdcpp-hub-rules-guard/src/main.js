'use strict';

// Learns each hub's rules and warns, locally, before the hub kicks. Listeners and polling only:
// no hooks, nothing is ever sent to a hub, no setting of the client is changed.

const SettingsManager = require('airdcpp-extension-settings');

const { SettingDefinitions } = require('./settings');
const { RULES, parseLimits, ruleNamesIn, isAboutUs, isExplicitKickOf, normalizeHubUrl, parseTag, formatValue } = require('./rules');
const { SOURCE_TITLES, effectiveLimits, evaluate, shouldWarn, rulesReport, kickSummary, formatDate } = require('./evaluate');
const { createStore } = require('./store');
const { HELP, parseRulesCommand } = require('./commands');

const CONFIG_VERSION = 1;
const TAG = '[rules] ';
const CONNECT_SETTLE_MS = 20 * 1000;   // our INF / MyINFO echo and the MOTD arrive first
const LEARNED_CHECK_MS = 5 * 1000;
const SHARE_CHANGE_MS = 30 * 1000;     // a refresh fires several events; one check after them
const SLOT_POLL_MS = 60 * 1000;
const HUBLIST_MAX_AGE_S = 30 * 60;
const KICK_WINDOW_S = 60;              // a rule message this close before a disconnect explains it
const KICK_SHOW_DAYS = 30;
const MAX_RECENT = 5;
const MAX_TRUSTED_NICKS = 200;

const isNmdc = (session) => !/^adcs?:\/\//i.test(session.url || '');

const isNotFound = (error) => !!error && (error.code === 404 || /not found|invalid module/i.test(String(error.message || '')));

module.exports = function (socket, extension, { now = () => Math.floor(Date.now() / 1000) } = {}) {
  const settings = SettingsManager(socket, {
    extensionName: extension.name,
    configFile: extension.configPath + 'config.json',
    configVersion: CONFIG_VERSION,
    definitions: SettingDefinitions,
  });

  const store = createStore(() => extension.configPath, socket.logger, now);
  const sessions = new Map(); // hub session id -> { id, url, key, name, state, nick, recent, values, showKick }
  const hubTimers = new Map();
  let fullTimer = null;
  let intervalTimer = null;
  let slotTimer = null;
  let lastSlots = null;
  let myCid = null;
  let hublist = { at: 0, byKey: new Map(), missing: false };
  let chain = Promise.resolve();
  let stopped = false;

  const errorText = (error) => (error && (error.message || error.code)) || String(error);

  const guarded = (name, handler) => async (...args) => {
    try {
      await handler(...args);
    } catch (error) {
      socket.logger.error(`${name} failed: ${errorText(error)}`);
    }
  };

  const unref = (timer) => {
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  };

  // One check at a time; a failing one does not stop the next
  const serial = (name, fn) => {
    chain = chain.then(fn).catch((error) => socket.logger.error(`${name} failed: ${errorText(error)}`));
    return chain;
  };

  const postEvent = (text, severity) => {
    if (!settings.getValue('warn_in_events')) return Promise.resolve();
    return socket.post('events', { text: `${extension.name}: ${text}`, severity })
      .catch((error) => socket.logger.error(`Could not post an event message: ${errorText(error)}`));
  };

  // Local status line in the hub window. Never a chat message: nothing reaches the hub.
  const postStatus = (sessionId, text, severity = 'info', owner) => socket.post(`hubs/${sessionId}/status_message`, {
    text: TAG + text, severity, type: 'system', ...(owner ? { owner } : {}),
  });

  const hubNameOf = (session) => session.name || session.url || `hub ${session.id}`;

  // ---- sessions ----

  const upsertSession = (hub, id = hub && hub.id) => {
    if (id === undefined || id === null) return null;
    let session = sessions.get(id);
    if (!session) {
      session = { id, url: '', key: '', name: '', state: '', nick: '', recent: [], values: null, showKick: true, trustedNicks: new Set() };
      sessions.set(id, session);
    }

    if (hub) {
      if (hub.hub_url) {
        session.url = hub.hub_url;
        session.key = normalizeHubUrl(hub.hub_url);
      }

      if (hub.identity && hub.identity.name) session.name = hub.identity.name;
      if (hub.settings && typeof hub.settings.nick === 'string' && hub.settings.nick) session.nick = hub.settings.nick;
      if (hub.share_profile !== undefined) session.shareProfile = hub.share_profile;
      if (hub.connect_state && hub.connect_state.id) session.state = hub.connect_state.id;
    }

    return session;
  };

  const refreshSessions = async () => {
    const hubs = await socket.get('hubs');
    const seen = new Set();
    for (const hub of Array.isArray(hubs) ? hubs : []) {
      upsertSession(hub);
      seen.add(hub.id);
    }

    for (const id of Array.from(sessions.keys())) {
      if (!seen.has(id)) sessions.delete(id);
    }
  };

  // ---- public hub list (read only what the client already has; never download it) ----

  const loadHublist = async () => {
    if (!settings.getValue('use_hublist') || hublist.missing || now() - hublist.at < HUBLIST_MAX_AGE_S) {
      return;
    }

    hublist.at = now();
    let entries;
    try {
      entries = await socket.get('hublists/entries');
    } catch (error) {
      if (isNotFound(error)) {
        hublist.missing = true; // a build without the hub list module
        return;
      }

      throw error;
    }

    const byKey = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      const key = normalizeHubUrl(entry && entry.server);
      if (!key) continue;
      const limits = {};
      if (entry.min_share > 0) limits.min_share = entry.min_share;
      if (entry.min_slots > 0) limits.min_slots = entry.min_slots;
      if (entry.max_hubs > 0) limits.max_hubs = entry.max_hubs;
      byKey.set(key, limits);
    }

    hublist.byKey = byKey;
  };

  const applyHublist = (session) => {
    const limits = hublist.byKey.get(session.key);
    if (limits && Object.keys(limits).length) {
      store.setLimits(session.key, session.url, session.name, 'hublist', limits, null, { replace: true });
    }
  };

  // ---- our own values, as the hub sees them ----

  const newContext = () => ({ profileSizes: new Map(), slotSetting: undefined, shareTotal: undefined });

  const profileSize = async (ctx, profile) => {
    const id = profile && profile.id !== undefined && profile.id !== null ? profile.id : 'default';
    if (!ctx.profileSizes.has(id)) {
      try {
        const data = await socket.get(`share_profiles/${id}`);
        ctx.profileSizes.set(id, data && Number.isFinite(data.size) ? data.size : undefined);
      } catch (error) {
        socket.logger.error(`Could not read share profile ${id}: ${errorText(error)}`);
        ctx.profileSizes.set(id, undefined);
      }
    }

    return ctx.profileSizes.get(id);
  };

  const slotSetting = async (ctx) => {
    if (ctx.slotSetting === undefined) {
      try {
        const values = await socket.post('settings/get', { keys: [ 'upload_slots' ] });
        ctx.slotSetting = values && Number.isFinite(values.upload_slots) ? values.upload_slots : null;
      } catch (error) {
        ctx.slotSetting = null;
      }
    }

    return ctx.slotSetting === null ? undefined : ctx.slotSetting;
  };

  const shareTotal = async (ctx) => {
    if (ctx.shareTotal === undefined) {
      try {
        const stats = await socket.get('share/stats');
        ctx.shareTotal = stats && Number.isFinite(stats.total_size) ? stats.total_size : null;
      } catch (error) {
        ctx.shareTotal = null;
      }
    }

    return ctx.shareTotal === null ? undefined : ctx.shareTotal;
  };

  const ownUser = async (session) => {
    if (!myCid) return null;
    try {
      return await socket.get(`hubs/${session.id}/users/${myCid}`);
    } catch (error) {
      if (!isNotFound(error)) socket.logger.error(`Could not read our own user on ${hubNameOf(session)}: ${errorText(error)}`);
      return null;
    }
  };

  const valuesFor = async (session, ctx) => {
    const own = await ownUser(session);
    const tag = parseTag(own && own.tag);
    if (own && own.nick) session.nick = own.nick;

    let slots;
    if (own && Number.isFinite(own.upload_slots) && own.upload_slots > 0) slots = own.upload_slots;
    else if (Number.isFinite(tag.slots)) slots = tag.slots;
    else slots = await slotSetting(ctx);

    let hubs;
    let hubsExact = false;
    if (tag.hubs) {
      hubs = tag.hubs;
      hubsExact = true;
    } else {
      // Counted here: registered hubs cannot be told apart, so they count as normal
      const connected = Array.from(sessions.values()).filter((s) => s.state === 'connected').length;
      hubs = { normal: Math.max(connected, 1), registered: 0, op: 0 };
    }

    let share = await profileSize(ctx, session.shareProfile);
    if (!Number.isFinite(share) && own && Number.isFinite(own.share_size)) share = own.share_size;
    if (!Number.isFinite(share)) share = await shareTotal(ctx);

    return { share, slots, hubs, hubsExact };
  };

  // ---- checking ----

  const warn = async (session, finding) => {
    const severity = finding.level === 'near' ? 'info' : 'warning';
    const text = `${finding.text} (${SOURCE_TITLES[finding.source] || finding.source})`;
    store.markWarned(session.key, finding.rule, finding.level);
    if (settings.getValue('warn_in_hub')) {
      await postStatus(session.id, `${text}. Type /rules for details.`, severity)
        .catch((error) => socket.logger.error(`Could not post to ${hubNameOf(session)}: ${errorText(error)}`));
    }

    await postEvent(`${hubNameOf(session)}: ${text}`, severity);
  };

  const showLastKick = async (session) => {
    const record = store.get(session.key);
    session.showKick = false;
    if (!record || !record.kick || now() - record.kick.at > KICK_SHOW_DAYS * 86400 || !settings.getValue('warn_in_hub')) {
      return;
    }

    await postStatus(session.id, `On ${formatDate(record.kick.at)} this hub disconnected you for: ${kickSummary(record.kick)}. Type /rules to compare with your values now.`, 'warning')
      .catch((error) => socket.logger.error(`Could not post to ${hubNameOf(session)}: ${errorText(error)}`));
  };

  const checkHub = async (session, ctx) => {
    if (!session.key || session.state !== 'connected') return;
    applyHublist(session);
    store.ensure(session.key, session.url, session.name);
    const values = await valuesFor(session, ctx);
    session.values = values;

    if (session.showKick) {
      await showLastKick(session);
    }

    const record = store.get(session.key);
    const findings = evaluate(effectiveLimits(record), values, { shareMarginPercent: settings.getValue('share_margin_percent') });
    const intervalSeconds = settings.getValue('warn_interval_minutes') * 60;
    for (const finding of findings) {
      if (shouldWarn(record.warned, finding, now(), intervalSeconds)) {
        await warn(session, finding);
      }
    }
  };

  const checkAll = async () => {
    await refreshSessions();
    try {
      await loadHublist();
    } catch (error) {
      socket.logger.error(`Could not read the public hub list: ${errorText(error)}`);
    }

    const ctx = newContext();
    for (const session of sessions.values()) {
      try {
        await checkHub(session, ctx);
      } catch (error) {
        socket.logger.error(`Check of ${hubNameOf(session)} failed: ${errorText(error)}`);
      }
    }
  };

  const checkOne = async (id) => {
    const session = sessions.get(id);
    if (!session) return;
    try {
      await loadHublist();
    } catch (error) {
      socket.logger.error(`Could not read the public hub list: ${errorText(error)}`);
    }

    await checkHub(session, newContext());
  };

  const scheduleFull = (delayMs) => {
    if (stopped || fullTimer) return;
    fullTimer = unref(setTimeout(() => {
      fullTimer = null;
      serial('Check', checkAll);
    }, delayMs));
  };

  const scheduleHub = (id, delayMs) => {
    if (stopped) return;
    clearTimeout(hubTimers.get(id));
    hubTimers.set(id, unref(setTimeout(() => {
      hubTimers.delete(id);
      serial('Hub check', () => checkOne(id));
    }, delayMs)));
  };

  const startInterval = () => {
    clearInterval(intervalTimer);
    intervalTimer = unref(setInterval(() => serial('Check', checkAll), settings.getValue('check_interval_minutes') * 60 * 1000));
  };

  // There is no settings event in the Web API: a cheap local poll notices a slot change
  const pollSlots = async () => {
    const values = await socket.post('settings/get', { keys: [ 'upload_slots' ] });
    const slots = values ? values.upload_slots : undefined;
    if (lastSlots !== null && slots !== lastSlots) {
      scheduleFull(LEARNED_CHECK_MS);
    }

    lastSlots = slots;
  };

  // ---- reading hub messages ----

  const recordKick = (session, entry) => {
    store.recordKick(session.key, session.url, session.name, entry);
    session.recent = [];
    const summary = kickSummary({ rules: entry.rules, limits: entry.limits });
    return postEvent(`${hubNameOf(session)} disconnected you for: ${summary}`, 'warning');
  };

  // Rules our last known values met cannot be why we were thrown out. A rule named without a
  // number is compared with the limit already known for this hub, if any.
  const unmetRules = (session, entry) => entry.rules.filter((rule) => {
    if (!session.values) return true;
    let limit = entry.limits[rule] !== undefined ? { value: entry.limits[rule], source: 'kick' } : undefined;
    if (!limit) limit = effectiveLimits(store.get(session.key))[rule];
    if (!limit) return true;
    return evaluate({ [rule]: limit }, session.values, { shareMarginPercent: 0 }).length > 0;
  });

  const onHubText = async (session, text) => {
    if (!settings.getValue('learn_from_chat') || !session.key || !text) return;
    const rules = ruleNamesIn(text);
    if (rules.length === 0) return;

    const limits = parseLimits(text);
    if (Object.keys(limits).length && store.setLimits(session.key, session.url, session.name, 'chat', limits, text)) {
      if (session.state === 'connected') scheduleHub(session.id, LEARNED_CHECK_MS);
    }

    const entry = { at: now(), text, rules, limits };
    if (isExplicitKickOf(text, session.nick)) {
      await recordKick(session, entry);
    } else if (isAboutUs(text, session.nick)) {
      session.recent.push(entry);
      session.recent = session.recent.slice(-MAX_RECENT);
    }
  };

  const onDisconnected = async (session) => {
    const recent = session.recent.filter((e) => now() - e.at <= KICK_WINDOW_S);
    session.recent = [];
    session.showKick = true;
    const entry = recent[recent.length - 1];
    if (!entry) return;
    if (!session.values) {
      // Dropped (or redirected) before the first check ran: measure now, so a welcome text naming
      // a minimum we meet is not taken for the reason
      try {
        session.values = await valuesFor(session, newContext());
      } catch (error) {
        socket.logger.error(`Could not read our values for ${hubNameOf(session)}: ${errorText(error)}`);
      }
    }

    const rules = unmetRules(session, entry);
    if (rules.length) {
      await recordKick(session, { ...entry, rules });
    }
  };

  const onHubStatus = async (message, id) => {
    // Only lines from the hub itself: our own status lines (and other extensions') are "system"
    // and carry a label
    if (!message || message.type !== 'server' || message.label || String(message.text || '').startsWith(TAG)) return;
    const session = sessions.get(id);
    if (!session) return;

    // NMDC: the client also shows a main chat line from ANY user as a server line when it contains
    // "is kicking ... because:" or "Hub-Security" + "was kicked by" (NmdcHub.cpp). Such a line
    // keeps its "<nick>" prefix: read it only from the hub's security bot or a nick seen as an
    // operator in main chat.
    const bracket = isNmdc(session) && /^<([^>]{1,64})>/.exec(String(message.text || ''));
    if (bracket && bracket[1] !== 'Hub-Security' && !session.trustedNicks.has(bracket[1])) return;
    await onHubText(session, message.text);
  };

  const isTrustedSender = (from, session) => {
    if (!from) return false;
    const flags = from.flags || [];
    if (flags.includes('self')) return false;
    if (flags.includes('op')) return true;
    // A bot only on ADC, where the hub sets it. On NMDC the client guesses "bot" from an empty
    // connection field in MyINFO, which any user can send (NmdcHub::applyConnection).
    if (flags.includes('bot') && !flags.includes('nmdc') && !isNmdc(session)) return true;
    // The hub itself on ADC has no CID (all zero bits)
    return typeof from.cid === 'string' && /^A+$/.test(from.cid);
  };

  const onHubMessage = async (message, id) => {
    const session = sessions.get(id);
    if (!session || !message || message.to || !isTrustedSender(message.from, session)) return;
    if (message.from.nick && session.trustedNicks.size < MAX_TRUSTED_NICKS) session.trustedNicks.add(message.from.nick);
    await onHubText(session, message.text);
  };

  const onHubUpdated = async (data, id) => {
    const session = sessions.get(id) || upsertSession(null, id);
    const before = session.state;
    upsertSession(data, id);
    if (!data || !data.connect_state || before === session.state) return;
    if (session.state === 'connected') {
      // A redirect keeps the session id but changes the address: read it again
      await refreshSessions();
      scheduleHub(id, CONNECT_SETTLE_MS);
    } else if (session.state === 'disconnected' || session.state === 'redirect') {
      await onDisconnected(session);
    }
  };

  // ---- /rules ----

  const reply = async (sessionId, lines, owner) => {
    for (const line of [].concat(lines)) {
      await socket.post(`hubs/${sessionId}/status_message`, { text: line, severity: 'info', type: 'system', ...(owner ? { owner } : {}) });
    }
  };

  const onTextCommand = async (data, id) => {
    if (!data || !data.command) return;
    const command = String(data.command).toLowerCase();
    if (command === 'help') {
      await reply(id, HELP[0], data.owner);
      return;
    }

    if (command !== 'rules') return;

    let session = sessions.get(id);
    if (!session || !session.key) {
      await refreshSessions();
      session = sessions.get(id);
    }

    if (!session || !session.key) {
      await reply(id, 'This hub is not known yet; try again in a moment.', data.owner);
      return;
    }

    const parsed = parseRulesCommand(data.args);
    switch (parsed.action) {
      case 'help':
        await reply(id, HELP, data.owner);
        return;
      case 'error':
        await reply(id, parsed.text, data.owner);
        return;
      case 'set': {
        store.setLimits(session.key, session.url, session.name, 'user', parsed.limits, null);
        const text = Object.entries(parsed.limits).map(([ rule, value ]) => `${RULES[rule].title} ${formatValue(rule, value)}`).join(', ');
        await reply(id, `Saved for this hub: ${text}.`, data.owner);
        scheduleHub(id, 1000);
        return;
      }
      case 'clear': {
        if (parsed.rules === null) store.clearLimits(session.key, 'user');
        else parsed.rules.forEach((rule) => store.clearLimits(session.key, 'user', rule));
        await reply(id, parsed.rules === null ? 'Removed everything you set for this hub.' : 'Removed.', data.owner);
        return;
      }
      case 'forget':
        store.forgetLearned(session.key);
        await reply(id, 'Forgot what was learned from this hub. What you set yourself stays.', data.owner);
        return;
      default: {
        const values = await valuesFor(session, newContext());
        await reply(id, rulesReport(hubNameOf(session), store.get(session.key), values), data.owner);
      }
    }
  };

  extension.onStart = async () => {
    await settings.load();
    store.load();
    settings.onValuesUpdated = (updated) => {
      if ('check_interval_minutes' in updated) startInterval();
      if ('use_hublist' in updated) hublist = { at: 0, byKey: new Map(), missing: false };
      scheduleFull(1000);
    };

    try {
      const info = await socket.get('system/system_info');
      myCid = info && info.cid;
    } catch (error) {
      socket.logger.error(`Could not read our CID: ${errorText(error)}`);
    }

    await socket.addListener('hubs', 'hub_created', guarded('hub_created', (hub) => upsertSession(hub)));
    await socket.addListener('hubs', 'hub_removed', guarded('hub_removed', (hub, id) => {
      const key = id !== undefined ? id : hub && hub.id;
      sessions.delete(key);
      clearTimeout(hubTimers.get(key));
      hubTimers.delete(key);
    }));
    await socket.addListener('hubs', 'hub_updated', guarded('hub_updated', onHubUpdated));
    await socket.addListener('hubs', 'hub_status', guarded('hub_status', onHubStatus));
    await socket.addListener('hubs', 'hub_message', guarded('hub_message', onHubMessage));
    await socket.addListener('hubs', 'hub_text_command', guarded('hub_text_command', onTextCommand));

    const onShareChange = guarded('share change', () => scheduleFull(SHARE_CHANGE_MS));
    await socket.addListener('share', 'share_refresh_completed', onShareChange);
    await socket.addListener('share_roots', 'share_root_created', onShareChange);
    await socket.addListener('share_roots', 'share_root_updated', onShareChange);
    await socket.addListener('share_roots', 'share_root_removed', onShareChange);
    await socket.addListener('share_profiles', 'share_profile_updated', onShareChange);

    startInterval();
    slotTimer = unref(setInterval(() => pollSlots().catch((error) => socket.logger.error(`Slot poll failed: ${errorText(error)}`)), SLOT_POLL_MS));
    await serial('Check', async () => {
      await pollSlots().catch(() => {});
      await checkAll();
    });
  };

  extension.onStop = () => {
    stopped = true;
    clearInterval(intervalTimer);
    clearInterval(slotTimer);
    clearTimeout(fullTimer);
    hubTimers.forEach((timer) => clearTimeout(timer));
  };

  // For the tests
  return { checkAll, onTextCommand, onHubStatus, onHubMessage, onHubUpdated, sessions, store, idle: () => chain };
};
