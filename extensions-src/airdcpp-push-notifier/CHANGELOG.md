# Changelog

## 1.0.0-beta.2

- No longer ends when its start fails (for example a client call refused while starting): the error
  is logged in the extension's error log instead, as the newer extensions already did.

## 1.0.0-beta.1

- First release: ntfy, Gotify, Telegram, Discord, Pushover and generic webhook notifications for
  private messages, mentions, finished and failed downloads, and hubs that stay disconnected.
- Away-only chat notifications, per-source cooldown, per-minute rate limit, quiet hours.
- Test notification from the settings.
