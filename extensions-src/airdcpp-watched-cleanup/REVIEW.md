# Independent review, 2026-10-18

Checked against airdcpp-windows origin/master f163a4989. Every finding below was proven fail-first:
the new test failed on the unfixed code, then passed after the fix. For the Recycle Bin fixes the
fix was also sabotaged afterwards to confirm the test catches it.

## Findings

| # | Severity | Where | Failure scenario | Verified | Status |
|---|---|---|---|---|---|
| 1 | blocker | src/recycle.js (SCRIPT, volume lookup) | A share on a SUBST drive letter: `DriveInfo` says Fixed, but no `Win32_Volume` has that letter, so the script fell back to the default 5% cap and called SendToRecycleBin. Run for real on this machine: the file was **permanently deleted** (`ok:true, in_bin:false`, not in the bin). | Live, with a scratch file on a temporary `subst` letter | Fixed: no volume -> refused. Test `a file on a SUBST drive is refused, not deleted` (win32, real PowerShell) |
| 2 | blocker | src/decide.js planRemoval (strangers) | A packed film `grp-film.rar/.r00` sharing a folder with another release `other.rar/.r00`: every archive volume was allowed, so the whole folder (and the OTHER, unwatched release) went to the bin. The same happened to an unpacked film beside `holiday.part1.rar` or `photos.zip` (`.rar`/`.zip` were "release extras"). | Unit test (fails on old code) | Fixed: an archive belongs only if it is the item's own set (`archiveSetBase`) or sits in a Subs/Sample/Proof folder. Tests `a packed release sharing its folder with ANOTHER packed release...`, `an unpacked film folder holding someone else's archive...` |
| 3 | should-fix | src/decide.js planRemoval | Personal photos (`IMG_0001.jpg`, `family.png`) beside a film counted as release extras: under 500 MiB, the whole folder (photos included) was recycled. | Unit test | Fixed: an image belongs only if it is in a support folder, starts with the video's name, or has an artwork name (poster, fanart, proof...). Test `personal pictures beside a film keep the folder...` |
| 4 | should-fix | src/decide.js inSample | `The.Sample.1999.mkv` (450 MiB) beside another film was taken for a sample and went with the folder. | Unit test | Fixed: a sample must be <= 300 MiB. Test `a full-size video that merely has "sample" in its name...` |
| 5 | should-fix | src/recycle.js | A path reached through a junction/link/mounted folder: the bin checked is the drive letter's, the item lives on the target volume. | Live: a junction test file was recycled before, refused after (the cross-volume permanent delete itself was NOT reproduced) | Fixed: any reparse point on the path refuses. Test `a file reached through a junction is refused, not moved` |
| 6 | should-fix (hardening) | src/recycle.js | Group policy `NoRecycleFiles` makes every recycle a permanent delete, and nothing checked it. | Not live-tested (would need a policy change); documented Windows behaviour | Fixed: checked in HKCU and HKLM. No test |
| 7 | nit | src/decide.js | A `.strm` item was treated as "packed" (size gate skipped) and could take its folder. | Unit test | Fixed: skipped as "not a plain video file". Test `a .strm ... is never moved as a folder` |

## Checked and found sound (no change)

- Ancestors and share ids: the media server's folder ids come from `idForPath(getRealPathUnsafe())`
  (MediaLibrary.cpp:1183, 1209, 2262) and the share API's ids from
  `generatePathId(getRealPathUnsafe())` (ShareApi.cpp:187/206). Both keep the trailing separator
  and both lower-case with `Text::toLower`, so non-ASCII names match. Library roots are the share
  roots (`buildFromShare`, MediaLibrary.cpp:2883). The chain ends at the root folder (its parentId
  is empty, JellyfinApi.cpp:18287). Local episodes keep their folder parentId (MediaCatalog.cpp:1996).
  Ids are compared as 128 bits, so a collision is not a practical risk.
- The "every account has watched it" gate: any account whose sign-in or listing fails makes
  `survey()` throw, so nothing is planned. New regression test: `a counted account whose sign-in or
  listing fails mid-pass stops the run`. Sabotage (skip a failing account) is caught.
  `GET /Users` lists every account to any signed-in account (JellyfinApi.cpp:14544 -> usersArray).
- `/cleanup list` only reads. The only writes are the report and the token in state.json.
- PowerShell script: the paths travel only as JSON in an environment variable, so they cannot inject
  code. A hang is ended by the 10-minute execFile timeout.

## Not verified

- The behaviour of a series/season favourite when the tvshows library holds more than 20000 items.
  Recursive browsing caps its scan at MAX_RECURSIVE_SCAN (JellyfinApi.cpp:74), so a series
  favourite could fall outside the favourites list. A favourite episode is still caught through
  its own UserData.
- Error dialogs: `OnlyErrorDialogs` can still show a shell error box on the desktop. The
  extension then waits up to the 10-minute timeout.

## Live test 2026-10-19 (FulDC++ 1.1123, extrig rig)

| # | Severity | Where | What happened | Status |
|---|---|---|---|---|
| L1 | should-fix | src/main.js clientFor (saved tokens) | Tokens were saved per user name only. After a correct sign-in, the second account's password was changed to a wrong one in the settings; `/cleanup run` still signed in with the saved token and moved the film to the Recycle Bin. A password change never took effect while the old token lived, and a refused sign-in never stopped a run. The watched state read was still that account's own, so no unwatched film was at risk, but the settings were not obeyed. | Fixed: a saved token is kept with a fingerprint (sha256, 16 hex) of the user name, password and pasted token it was obtained with; different credentials sign in again. Test main.test.js "a password changed to a wrong one is tried, not bypassed by the token saved before; run refuses" (failed before the fix). Live re-run: `Failed: Account gaps: Media server answered 401 ...`, nothing moved. |

Checked live and sound: the ancestor-id resolver against the real share ids; the mixed folder
(film + another release's RAR5 set) moved only the video and its .nfo; the share refresh made the
media library drop both moved films within about a minute.

Rig limit: `watched_days` cannot be 0 (the client refuses: "Value 0 is not in range 1 - 3650"), so
"watched long ago" was made by moving LastPlayed back 40 days in `MediaServerPlayback.xml` while
the client was stopped.
