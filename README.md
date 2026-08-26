# FulDC++ extensions

The extension catalog shown in FulDC++ (Extensions window, web UI, and the auto-updater) is
served from `https://fuldcpp.net/extensions/`. This repository is where it comes from: the
packages under `packages/` are the exact tarballs published as release assets here, and the
scripts turn them into the documents the clients read.

The catalog keeps npm's document shapes (search result, `/latest`, packument) because that is
what the clients already parse; only the address changed. `catalog.json` is signed with the
release key, and every entry pins the tarball's URL and SHA-1, so a client that verified the
catalog knows exactly which bytes it is installing.

## Layout

```
packages/<name>/<name>-<version>.tgz   the package, byte-for-byte the release asset
packages/<name>/meta.json              publisher, homepage, date, where it came from
npm-mirror.txt                         packages mirrored from the npm registry
scripts/build-catalog.ps1              packages/ -> out/ (catalog.json, <name>/latest, <name>/index.json)
scripts/sync-npm.ps1                   refresh the npm mirrors (reports first; -Apply to store)
scripts/inspect-tarball.ps1            the checks every package must pass
tests/                                 Pester tests for the generator (Invoke-Pester .\tests)
```

Only presentation data lives in `meta.json`. Anything that decides what gets installed
(version, tarball URL, hash, size) is read from the package file itself.

## Adding or updating a package

1. Put the tarball in `packages/<name>/` as `<name>-<version>.tgz` and remove the previous one
   (one tarball per package). For an npm package, `.\scripts\sync-npm.ps1 -Name <name>` shows
   what changed and `-Apply` stores it together with a fresh `meta.json`.
2. `.\scripts\build-catalog.ps1` - refuses anything the client would refuse at install time:
   more than one top-level directory, a missing required field, `apiVersion` other than 1,
   `private: true`, a version outside `X.Y.Z[-alpha|beta|rc[.N]]`.
3. Publish the tarball **before** the catalog that points at it:
   `gh release create <name>-v<version> packages/<name>/<name>-<version>.tgz --title "<name> <version>" --notes "source: <meta.source>"`
4. Copy `out\*` into the website repository's `extensions/` directory and sign the catalog
   there with the release key: `FulDC.exe /sign extensions\catalog.json <path-to-air_rsa>`
   (the release build; the debug build silently does nothing). Commit the catalog and its
   `.sign` together. The key never enters any repository.

`build-catalog.ps1` derives every timestamp from the packages, so re-running it on unchanged
input reproduces the signed bytes exactly - **on Windows PowerShell 5.1** (`powershell.exe`).
PowerShell 7 lays JSON out differently, which would change the bytes under an existing
signature; run the scripts with 5.1 only.

### Packages marked private

A `"private": true` in `package.json` makes the client skip every update check for that
package - sensible for something that is not published anywhere, self-defeating once it is
hosted here. Such a package is repacked with the flag removed and nothing else touched, and
`meta.json` records that in `repacked`. The original is linked from `source`.

### Prerelease versions

`1.2.0-beta` installs normally. Automatic updates only move between prereleases of the same
major version, or from a prerelease to its release; the client never updates a release to a
prerelease.

## Running the tests

Windows PowerShell 5.1 ships Pester 3.4, which is what the tests target:

```powershell
Invoke-Pester .\tests
```

## Licences

Each package carries its own licence inside the tarball (`license` in `package.json`, shown
in the catalog). The packages mirrored from npm are MIT; the ones from
[Sopor/airdcpp-extensions](https://github.com/Sopor/airdcpp-extensions) are MIT as well.
The scripts in this repository are GPL-3.0-or-later, like FulDC++ itself.
