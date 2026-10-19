# Independent review: airdcpp-season-gaps 1.0.0-beta.1

Reviewed 2026-10-18 against origin/master f163a4989. Not part of the npm package.

## Findings

### 1. BLOCKER: a release of a same-named show from another year is downloaded (fixed)
`src/release.js` `titleKeys`/`matchesWanted` (before the fix, :21-33 and :95). Both sides dropped a trailing
year and then compared keys. So library "Doctor Who (1963)" (keys `doctorwho1963`, `doctorwho`)
accepted `Doctor.Who.2005.S01E01...`: the release side also produced `doctorwho`. The same went for
`Battlestar.Galactica.1978` vs the 2003 show, and for `Show.Name.2024` (a reboot) vs a plain
"Show Name" from 2010. Ranking is by sources, so the wrong show's popular release won.
Verified: a probe script against the unfixed code gave `true` for all three. The new filler test
picked `NEW` (2005, 50 hits) over `OLD` (1963) before the fix.
Fix: `showMatches`. A release whose name has a year matches only when a show name carries that
year, or when the year is one of the show's years (name, ProductionYear, TMDB first_air_date). The
years travel with the waiting items (`years`). Items saved by the old version have no years, so
the strict rule applies to them.
Tests: checker.test "show keys: ..." and filler.test "a release of a same-named show from another
year ..."; main.test "... pending items carry the show years". Sabotage: each test failed with its
part of the fix reverted.

### 2. BLOCKER: "The Office (US)" downloads the UK show's releases (fixed)
`src/checker.js` (before the fix, :137-139) added the TMDB name's keys to the library name's keys. TMDB calls the US
show plain "The Office", so key `theoffice` was added, and `The.Office.S02E05...` (the UK show's
name in scene releases) matched the US series.
Verified: the probe and the new checker test both failed on the unfixed code.
Fix: `showKeys`. When any name of the show carries a country tag (US/UK/GB/AU/NZ/CA/IE), the
bare title is not a key. This is documented in the README. A show with no tag in the library is
still matched by its bare title; that is unavoidable without more data.

### 3. Checked, not a bug: DisplayMissingEpisodes POST
`checker.js:64` sends `{DisplayMissingEpisodes: true}` only. On origin/master the handler
(JellyfinApi.cpp:15147-15215) starts from `target->preferences` and changes each field only when
the body carries it with the right type (`bodyBool` :19769 returns the old value when the key is
absent). The account's other preferences are kept, and the target is the token's own user
(`me.Id`). Caveat (nit, not fixed): if `media_server_url` points at a real Jellyfin server, that
server replaces the whole configuration. The setting is described as the built-in server.

### 4. Checked, not a bug: the search budget across restarts
The search time is pushed and saved before `POST search` (filler.js), and `loadState` reloads it.
New main.test "the search budget survives a restart" passes: after a restart, no search is sent
inside the spacing.

### 5. Checked, not a bug: the menu list hook
`extension_list_menuitems` exists (MenuApi.cpp ID_CONTEXT_MENU_HANDLER "extension", MenuApi.h:47).
The callback calls `accept` synchronously with `{menuitems}`, the shape `deserializeMenuItems`
reads. With a null payload it answers `[]`.

### 6. Checked, not a bug: TMDB key and URL in logs
Every TMDB error comes from a fixed allow-list (tmdb.js). The URL (which holds a v3 key) and the
headers are never put into a message. The cache file names hash the search text. The existing
secrets test covers logs, events, chat, the report and last-check.json.

### 7. SHOULD-FIX: trailer and "(sample)" files could be queued (fixed; from the keep-up review)
`release.js` pickBest rejected only `sample` between `[ ._-]`. `Show.Name.S02E05.Trailer...mkv`,
`...-GRP-trailer.mkv` and `...(sample).mkv` passed the exact-name check, and the pick by user count
put them first. Fix: reject `sample|trailer` between separators, brackets included.
Test: filler.test "a sample or trailer file is never queued ..." (failed on the old regex).

### 8. SHOULD-FIX: a folder download in flight was searched for and queued again (fixed)
A folder result answers `directory_download_ids` (SearchEntity.cpp:154-157). It is not a queue
bundle until the source's file list arrives, so the queue-by-name check missed it. A `/gaps fill`
(which ignores retry_days) searched for the episode and queued it again.
Fix: the attempt keeps `directoryDownloadId`/`bundleId`. Before searching, an episode whose folder
download is still `pending` in `GET filelists/directory_downloads` (FilelistApi.cpp:64) is skipped,
and no budget is spent.
Test: filler.test "a folder download still waiting for its file list ...".

### 9. SHOULD-FIX: a folder download that failed stayed "queued" for retry_days (fixed)
When the source is offline, `filelist_directory_download_failed` (FilelistApi.cpp:275-285) fires and
nothing is queued. The attempt still said "queued", so automatic fill waited the full retry_days (3 days).
Fix: a listener marks it "could not be queued", posts a warning event and saves at once. The next
automatic try comes after a backoff of 1 h, 2 h, 4 h ... up to 24 h.
Tests: filler.test "a folder download that failed ... backoff" and main.test "a failed folder
download event is listened to and handled". Sabotage: each of the three fixes reverted, its test failed.

### 10. BLOCKER: language, dub, hardsub and extras releases were accepted (fixed; from the quality-upgrader review)
pickBest checked the show, the episode and the quality word only. `Show.Name.S02E05.1080p.FRENCH.WEB-GRP`,
`GERMAN.DL`, `NORDiC`, `SWESUB`, `DUBBED`, `MULTi`, `HC`, `EXTRAS`, `Bonus` and `SUBPACK` all passed, and the
one with the most users was queued.
Fix: `releaseTags` collects the words between the episode code and the group, using the
quality-upgrader's LANGUAGE_TAG and CONTENT_TAG lists. Words are split on . _ space and brackets,
so `WEB-DL` is not a `dl` tag. A result with any tag is refused unless the new setting
`accepted_tags` lists it (default empty).
Test: filler.test "language, dub, hardsub and extras releases are refused unless the tag is
accepted". It failed before the fix and failed again with the check sabotaged. Cost: an episode
title word such as "Bonus" after the code also refuses the release, which is the conservative side.

### Nits (not fixed)
- `/help` in any chat also prints this extension's help. This matches airdcpp-seen-tracker.
- A hub_search with no hub online that still answers 200 is recorded as "no exact match among 0",
  and the automatic retry follows after retry_days.

## Live test 2026-10-19 (1.1123 rig)

### L1. should-fix: a library the media server never identified read "0 show(s) with gaps" (FIXED)
`src/checker.js`. With "Display missing episodes" on and no TMDB key, the only source is the
server's IsMissing rows, which exist only for a series its metadata matched
(MediaServerManager's season lookup returns nothing without the series' providerId; metadata is
off and keyless by default). Live: Fawlty Towers with E03 and E05 missing, server metadata off ->
report "0 with gaps, 0 missing", no hint. Fix: such a series gets `partial` ("not identified by
the media server's metadata (TMDB) ..."), a note says how to fix it, and summaryText adds
"N show(s) not identified, see the report". Test: checker.test "live test: native only, a series
the media server has not identified is flagged, not reported clean" (failed before).

### Nit (not fixed)
- When both a release folder and the video file inside it match exactly, the pick may take the
  loose file (live: E03 came as `fawlty.towers.s01e03...mkv`, E05 as the folder). Same video; the
  folder's nfo/subs are left behind.

## Live test 2026-10-19, second run with a real TMDB key (1.1123 rig)

### L2. should-fix: a release already shared was fetched again as its loose video (FIXED)
`src/release.js` pickBest. A result the client already shares or queues (`dupe`) was skipped one
by one, so when the exact release folder was a dupe, the loose `.mkv` of the same release beside
it (not a dupe) won. Live: client 1 still shared `Fawlty.Towers.S01E03.1080p.WEB-DL.x264-GRP/`
from an earlier run (share index not refreshed, so the media library missed E03), and `/gaps fill`
queued `Fawlty.Towers.S01E03.1080p.WEB-DL.x264-GRP.mkv`, a second copy of the release.
Fix: the release names of all dupe results (folder name, or file name without the video
extension, case-insensitive) are collected first; a candidate with one of those names is skipped.
Another release of the same episode is still taken. Test: release.test "pickBest: a release
already shared or queued is not fetched again as its loose video or folder" (failed before the
fix). Live after the fix, same state: E03 "no exact match", nothing queued.

### L3. should-fix: the first check of a season said "0 with gaps" (FIXED)
`src/checker.js`. The media server builds a season's missing list in the background on the first
IsMissing question and answers that question empty (JellyfinApi withMissingEpisodes returns the
held listing while `lookup()` has nothing yet). Live: the first `/gaps check` after the show was
identified reported "0 show(s) with gaps"; the second, 30 s later, E03 and E05.
Fix: seasons of identified shows whose native list came back empty (and that TMDB did not fill)
are asked once more after one pause per check (10 s, NATIVE_RECHECK_MS in main.js). Test:
checker.test "native lists: a season that came back empty is asked once more after a pause"
(failed before the fix). Live after the fix: a newly added Season 02 (S02E01 only) reported
S02E02-E06 on its very first check. Cost: a check whose library has complete seasons waits 10 s
once.
