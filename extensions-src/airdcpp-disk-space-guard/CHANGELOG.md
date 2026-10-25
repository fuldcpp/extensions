# Changelog

## 1.0.0-beta.2

- No longer ends when its start fails (for example a client call refused while starting): the error
  is logged in the extension's error log instead, as the newer extensions already did.

## 1.0.0-beta.1

- First release: pauses downloads whose drive falls below a free-space limit and resumes them,
  at their earlier priority, once the drive is above the limit plus a margin.
