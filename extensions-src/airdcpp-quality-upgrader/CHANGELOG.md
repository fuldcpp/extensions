# Changelog

## Unreleased (live test 2026-10-19)

- Fixed: the settings did not register on a real client ("Failed to register settings: Field can't
  be empty"): the "No preference" codec option had an empty id. It is now `none`; the extension ran
  with no settings at all before.
- Fixed: every start wiped `state.json` (jobs, finds, the search budget and the rotation). An upgrade
  cut short by a restart was forgotten, leaving the new and the old copy both in the share.
- Fixed: a release named `...-GRP-sample` (or `-proof`, `-subs`, `-extras`, `-trailer`...) took the
  suffix for its group and could be taken as an upgrade.
- README: the new copy is hashed once more after it is put in place (the client keeps no hash data
  for a download finished outside the share).

## 1.0.0-beta.1

- First release: finds higher-resolution copies and PROPER/REPACKs of the films and episodes you
  have (media library or share), under a search budget; reports only by default; optional
  automatic replacing through a staging and a holding folder, keeping hash data and the watched
  state.
