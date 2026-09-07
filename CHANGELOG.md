# Changelog

Changes to the extension catalog served at https://extensions.fuldcpp.net/. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are catalog
publishing dates, since the catalog itself has no version number.

## [2026-09-07]

### Changed
- Refreshed three of the five Sopor packages against upstream
  (github.com/Sopor/airdcpp-extensions, commit `adc829c6`):
  - `airdcpp-release-fixxer` 1.2.5-beta to 1.2.7-beta: drops the "Log actions to the system
    log" and "Ignore files/directories that are excluded from share" settings (the actions are
    now always logged, excluded content is never skipped, both matching the old defaults), and
    shortens the incomplete-release setting's title so it stops being cut off in the Settings
    dialog
  - `airdcpp-sample-proof-checker` 1.2.1-beta to 1.2.4-beta: adds a queue context-menu item for
    checking a single bundle, and stops retrying a Sample/Proof redownload once the release
    folder is gone
  - `airdcpp-tiny-fileserver` 0.0.11-beta to 0.0.13-beta: waits 5 s between consecutive
    automatic installs, and raises the lowest configurable port from 1024 to 1025
- `airdcpp-sfv-folder-checker` and `airdcpp-share-backup` are unchanged: upstream still carries
  the exact bytes we mirrored on 2026-09-01

## [2026-09-01]

### Added
- `airdcpp-tiny-fileserver` 0.0.11-beta from Sopor/airdcpp-extensions: a local-only static
  server for `.tgz` tarballs, so "Install extensions from URL..." can be pointed at a folder
  on this machine. Off until a folder is set; binds 127.0.0.1 unless further addresses are
  configured, serves `.tgz` files under the chosen folder only

### Changed
- The catalog is served from `https://extensions.fuldcpp.net/` by a Cloudflare Worker (`worker/`)
  instead of the fuldcpp.net GitHub Pages site
- Refreshed the four Sopor packages, which had stood at their 2026-08-25 versions:
  release-fixxer 1.2.0-beta to 1.2.5-beta, sample-proof-checker 1.2.0-beta to 1.2.1-beta,
  sfv-folder-checker 1.2.0-beta to 1.2.3-beta, and share-backup 0.0.9-beta to 0.1.9-beta,
  which gains scheduled backups by weekday, retention, virtual-folder exclusion, a bz2 toggle
  and a nickname override

### Fixed
- Each Sopor package's `source` in `meta.json` pointed at a `master` branch that no longer
  exists, naming a tarball that had since been replaced. They are now pinned to the upstream
  commit the package was taken from, so the provenance link stays resolvable

## [2026-08-26]

### Added
- First catalog: the eight public AirDC++ extensions mirrored from npm (advanced-sharing 1.0.0,
  auto-downloader 1.0.0-beta.13, message-emailer 1.0.5, release-validator 1.4.0,
  runscript-extension 1.2.13, search-sites 1.2.0, share-monitor 1.2.0, user-commands 2.2.2)
  and the four from Sopor/airdcpp-extensions (release-fixxer 1.2.0-beta,
  sample-proof-checker 1.2.0-beta, sfv-folder-checker 1.2.0-beta, share-backup 0.0.9-beta),
  repacked only to drop their `private` flag so the client can offer updates
- `scripts/build-catalog.ps1` (packages to catalog documents), `scripts/sync-npm.ps1`
  (refresh the npm mirrors, report first), `scripts/inspect-tarball.ps1` (the checks every
  package must pass) and a Pester suite for the generator
