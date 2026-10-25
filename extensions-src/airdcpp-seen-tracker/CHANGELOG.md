# Changelog

## 1.0.0-beta.2

- No longer ends when its start fails (for example a client call refused while starting): the error
  is logged in the extension's error log instead, as the newer extensions already did.

## 1.0.0-beta.1

- First release: records joins and leaves, answers /seen <nick> in hubs and private chats;
  optional, rate-limited answers to !seen in main chat (off by default).
