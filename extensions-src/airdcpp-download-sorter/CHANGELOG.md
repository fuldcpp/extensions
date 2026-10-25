# Changelog

## 1.0.0-beta.2

- No longer ends when its start fails (for example a client call refused while starting): the error
  is logged in the extension's error log instead, as the newer extensions already did.
- A move still pending from an earlier run whose destination cannot be looked at (permissions
  changed, a share with other credentials), or a torn entry in pending-moves.json, stopped the
  sorter from starting at all, at every start. Such an entry is now logged and skipped (a torn one
  dropped), and the other unfinished moves are still cleaned up.

## 1.0.0-beta.1

- First release: sorts finished downloads into TV (per show and season), movie and music
  folders or by own rules; dry run by default; never overwrites; keeps hash data.
