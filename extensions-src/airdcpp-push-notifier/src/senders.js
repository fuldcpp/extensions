'use strict';

// One entry per push service. buildRequest() is pure (tested without a network); the dispatcher
// does the sending, the timeout, the single retry and the once-per-failure-streak error report.

const TIMEOUT_MS = 10 * 1000;
const RETRY_DELAY_MS = 5 * 1000;

const trimSlash = (url) => String(url || '').trim().replace(/\/+$/, '');

const isHttpUrl = (url) => /^https?:\/\/[^\s/]+/i.test(String(url || '').trim());

// Printable ASCII only: anything else cannot travel in a header (fetch would throw with the
// value in its message) and is a pasting accident anyway
const isToken = (value) => /^[\x21-\x7e]+$/.test(String(value || '').trim());

// Discord renders markdown, masked links and headings from the body as well as the title
const escapeDiscord = (text) => text.replace(/[\\*_~`|>[\]()#-]/g, '\\$&');

const json = (url, body, headers = {}) => ({
  url,
  init: {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(body),
  },
});

// ntfy priorities: 1 min .. 5 max
const NTFY_PRIORITY = { private_message: 4, mention: 4, bundle_failed: 4, hub_disconnected: 4 };

const SENDERS = [
  {
    id: 'ntfy',
    name: 'ntfy',
    settingKeys: [ 'ntfy_server', 'ntfy_topic', 'ntfy_token' ],
    isConfigured: (s) => isHttpUrl(s.ntfy_server) && !!String(s.ntfy_topic || '').trim() &&
      (!String(s.ntfy_token || '').trim() || isToken(s.ntfy_token)),
    // JSON publishing to the server root: header publishing would need the title in a header,
    // and a non-Latin-1 nick there makes fetch throw
    buildRequest: (s, n) => json(
      trimSlash(s.ntfy_server),
      {
        topic: String(s.ntfy_topic).trim(),
        title: n.title,
        message: n.body,
        priority: NTFY_PRIORITY[n.kind] || 3,
      },
      s.ntfy_token ? { Authorization: `Bearer ${String(s.ntfy_token).trim()}` } : {},
    ),
  },
  {
    id: 'gotify',
    name: 'Gotify',
    settingKeys: [ 'gotify_url', 'gotify_token' ],
    isConfigured: (s) => isHttpUrl(s.gotify_url) && isToken(s.gotify_token),
    buildRequest: (s, n) => json(
      `${trimSlash(s.gotify_url)}/message`,
      { title: n.title, message: n.body, priority: NTFY_PRIORITY[n.kind] ? 7 : 5 },
      { 'X-Gotify-Key': String(s.gotify_token).trim() },
    ),
  },
  {
    id: 'telegram',
    name: 'Telegram',
    settingKeys: [ 'telegram_bot_token', 'telegram_chat_id' ],
    isConfigured: (s) => /^\d+:[\w-]+$/.test(String(s.telegram_bot_token || '').trim()) &&
      !!String(s.telegram_chat_id || '').trim(),
    // Plain text (no parse_mode): chat text must never be interpreted as markup
    buildRequest: (s, n) => json(
      `https://api.telegram.org/bot${String(s.telegram_bot_token).trim()}/sendMessage`,
      {
        chat_id: String(s.telegram_chat_id).trim(),
        text: `${n.title}\n${n.body}`,
        disable_web_page_preview: true,
      },
    ),
  },
  {
    id: 'discord',
    name: 'Discord',
    settingKeys: [ 'discord_webhook' ],
    isConfigured: (s) => /^https:\/\/(?:[\w-]+\.)?(?:discord\.com|discordapp\.com)\/api\/webhooks\//i
      .test(String(s.discord_webhook || '').trim()),
    // allowed_mentions with an empty parse list: "@everyone" in a chat message stays text
    buildRequest: (s, n) => json(
      String(s.discord_webhook).trim(),
      {
        content: `**${escapeDiscord(n.title)}**\n${escapeDiscord(n.body)}`.slice(0, 2000),
        allowed_mentions: { parse: [] },
      },
    ),
  },
  {
    id: 'pushover',
    name: 'Pushover',
    settingKeys: [ 'pushover_app_token', 'pushover_user_key' ],
    isConfigured: (s) => isToken(s.pushover_app_token) && isToken(s.pushover_user_key),
    buildRequest: (s, n) => json(
      'https://api.pushover.net/1/messages.json',
      {
        token: String(s.pushover_app_token).trim(),
        user: String(s.pushover_user_key).trim(),
        title: n.title,
        message: n.body,
      },
    ),
  },
  {
    id: 'webhook',
    name: 'Webhook',
    settingKeys: [ 'webhook_url' ],
    isConfigured: (s) => isHttpUrl(s.webhook_url),
    buildRequest: (s, n) => json(
      String(s.webhook_url).trim(),
      { event: n.kind, title: n.title, message: n.body, time: Math.floor(Date.now() / 1000) },
    ),
  },
];

// Errors are worth one retry: network failures, timeouts, 429 and 5xx. A 4xx is a configuration
// problem that a retry cannot fix.
const isRetryable = (error) => !error.status || error.status === 429 || error.status >= 500;

// From an allow-list only: fetch puts header values (tokens) and URLs into its own messages,
// and this text goes to the log and the event list
const describeError = (error) => {
  if (error.status) {
    return `HTTP ${error.status}`;
  }

  if (error.name === 'TimeoutError' || error.name === 'AbortError') {
    return 'timed out';
  }

  const cause = error.cause || {};
  if (/redirect/i.test(String(cause.message || ''))) {
    return 'redirected (enter the final https address)';
  }

  if (typeof cause.code === 'string' && /^[A-Z0-9_]+$/.test(cause.code)) {
    return cause.code;
  }

  return 'request failed';
};

const createDispatcher = ({ fetchImpl, onFailure, onRecovered, sleep, timeoutMs = TIMEOUT_MS, retryDelayMs = RETRY_DELAY_MS }) => {
  const failing = new Set(); // sender ids inside a failure streak
  const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const sendOnce = async (sender, settings, notification) => {
    const { url, init } = sender.buildRequest(settings, notification);
    // A redirect is refused: fetch would forward X-Gotify-Key to the new origin, and a 301/302
    // turns the POST into a bodiless GET that "succeeds" without delivering anything
    const response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      if (response.body && typeof response.body.cancel === 'function') {
        await response.body.cancel().catch(() => {});
      }

      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }

    // Drain the body so the connection can be reused
    if (response.body && typeof response.arrayBuffer === 'function') {
      await response.arrayBuffer().catch(() => {});
    }
  };

  const sendTo = async (sender, settings, notification) => {
    try {
      try {
        await sendOnce(sender, settings, notification);
      } catch (error) {
        if (!isRetryable(error)) {
          throw error;
        }

        await wait(retryDelayMs);
        await sendOnce(sender, settings, notification);
      }

      if (failing.delete(sender.id) && onRecovered) {
        onRecovered(sender);
      }

      return true;
    } catch (error) {
      // Reported once per streak: a dead backend must not flood the log with one line per message
      if (!failing.has(sender.id)) {
        failing.add(sender.id);
        onFailure(sender, describeError(error));
      }

      return false;
    }
  };

  // Sends to every configured backend in parallel; never throws
  const dispatch = async (settings, notification, onlySenderIds) => {
    const targets = SENDERS
      .filter((sender) => !onlySenderIds || onlySenderIds.includes(sender.id))
      .filter((sender) => sender.isConfigured(settings));
    const results = await Promise.all(targets.map((sender) => sendTo(sender, settings, notification)));
    return { attempted: targets.length, delivered: results.filter(Boolean).length };
  };

  return { dispatch };
};

module.exports = { SENDERS, createDispatcher, describeError, isHttpUrl };
