# Changelog

Changes to the extension catalog served at https://extensions.fuldcpp.net/. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are catalog
publishing dates, since the catalog itself has no version number.

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
