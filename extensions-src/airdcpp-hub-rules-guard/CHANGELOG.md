# Changelog

## 1.0.0-beta.1

- First release: learns each hub's minimum share, slot, hub-count and slot-ratio rules from hub
  messages, kick messages, the public hub list (when loaded) and `/rules set`, and warns in the
  hub window and the event log when your values break them or come close. `/rules` shows the
  known rules next to your values.

- Live-test fix: dates in the kick notice ("On ... this hub disconnected you") and in `/rules`
  are local time; they were UTC without saying so (2 h off on a UTC+2 machine).
