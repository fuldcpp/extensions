# Changelog

Changes to the extension catalog served at https://fuldcpp.net/extensions/. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are catalog
publishing dates, since the catalog itself has no version number.

## [Unreleased]

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
