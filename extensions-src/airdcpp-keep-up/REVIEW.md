# Independent review: airdcpp-keep-up 1.0.0-beta.1

Reviewed 2026-10-18 against origin/master f163a4989. Not in the npm package.

## Findings

### 1. should-fix: a sample file is taken as the episode (exact-match hole)
- `src/release.js:132-167` (parseRelease) and `:226-240` (rankResults).
- Scenario: a search for `The.Show.S01E04` returns the release folder
  `The.Show.S01E04.1080p.WEB.H264-GRP` (5 users) and the scene sample inside it,
  `the.show.s01e04.1080p.web.h264-grp-sample.mkv` (6 users). The sample parses as title
  "the show", S01E04, group "sample", a video file, so it matches exactly and ranks FIRST on user
  count. A 50 MB sample is queued, the record says "queued", and the real episode is never
  fetched ("never again").
- Verified: ran `rankResults` on those two results; the sample came out first.

### 2. should-fix: the queue caps lose their own downloads (name-only tracking)
- `src/main.js:274-285` (activeBundles) and `:428-431` (the download POST).
- Downloads were counted only while a queue bundle carried exactly the release name.
  - A directory result is not a bundle yet: `POST search/{id}/results/{tth}/download` answers
    `directory_download_ids` (SearchEntity.cpp:155-158) and the bundle is made only after the
    source's file list arrives (DirectoryListingManager). Until then the next check counts 0
    and queues past `max_active_bundles` / `max_total_size_gb`.
  - A file result answers `bundle_info.id` (SearchEntity.cpp:160-162, Serializer.cpp:300), but
    the id was dropped. A bundle renamed in the queue (this fork has queue rename) or merged into
    another bundle was no longer counted.
- Verified against origin/master source; failing tests below.

### 3. should-fix: a directory download that fails is never retried
- `src/main.js:429` + `:482`.
- Scenario: the source goes offline while its file list is fetched.
  DirectoryListingManager::failDirectoryDownload (:474) marks it FAILED, and it is removed 120 s
  later (:33, :99-112). No bundle ever appears, but the record stays "queued", which means
  never searched again. The episode is lost for good, although the user removed nothing.
- Verified against origin/master source (events `filelist_directory_download_failed` /
  `_processed`, FilelistApi.cpp:41-44, :264-285).

### 4. should-fix: the dry run ignores the queue caps
- `src/main.js:416-420`.
- A dry run never adds what it would queue to the running count and size. With
  `max_active_bundles` 1 and two wanted episodes, it reports "would queue" for both, while the
  real run queues one. The README tells users to judge the dry run before turning it off.
- Verified by test.

### 5. blocker: a same-named show from another year is accepted
- `src/release.js:82-103` (showIdentity / matchesShow), `src/main.js:439`.
- The year written in a library name ("Doctor Who (1963)") was dropped, and only one year was
  kept. With no year known, any release year passed. So "Doctor Who (1963)" accepted
  `Doctor.Who.2005.S01E01`, and a plain "Show Name" accepted `Show.Name.2024.S01E01`.
- Verified with node on the unfixed code: both returned true. Raised by the coordinator from
  the season-gaps review.

### 6. blocker: a country-tagged show matches the bare title
- Same place. TMDB names "The Office (US)" plain "The Office", and that name became a key. So
  `The.Office.S02E05` (the UK show) was accepted.
- Verified with node on the unfixed code: it returned true.

### 7. blocker: language, dub, hardsub and extras releases are taken as the episode
- `src/release.js` rankResults. Raised by the coordinator from the quality-upgrader review.
- `The.Show.S01E02.FRENCH...`, `.GERMAN.DL.`, `.NORDiC.`, `.SWESUB.`, `.DUBBED.`, `.MULTi.`,
  `.HC.`, `.EXTRAS.`, `.Bonus.`, `.SUBPACK.` and `.Trailer.` all passed the exact match, so a
  French dub or a subpack could be queued as the episode.
- Verified: the new test failed on that code.
- Fix: words after SxxEyy are checked against the quality-upgrader lists. A content tag is
  always rejected. A language tag is rejected unless it is listed in the new setting
  `accepted_language_tags` (default empty). "WEB-DL" is not read as the DL tag.
- Test: release.test "a language, dub, hardsub or extras release is never the episode, unless
  its language tag is accepted".

## Fixes and their fail-first tests
Each test below was written first and failed on the unfixed code for the stated reason. The
fixes were applied after that.

| # | Fix | Test |
| :- | :- | :- |
| 1 | `parsed.sample` (sample/trailer token after the SxxEyy) rejects the result | release.test: "a sample file of the release is never taken" |
| 2 | records keep `bundleId` (file) or `directoryDownloadId` (folder); a pending directory download counts; the processed event adopts the bundle id; a name match adopts the id | main.test: "queue caps count a directory download that is not a bundle yet", "queue caps count a file bundle by its id after the user renamed it" |
| 3 | `filelist_directory_download_failed` sets the record to `download_failed` with a backoff | main.test: "a directory download that fails before it is a bundle is searched again later" |
| 4 | the dry run adds its pick to the running count and size | main.test: "the dry run keeps to the queue caps" |
| 5 | `showIdentity(names, ...years)`: years from the names, the library and TMDB; a release year must be one of them | release.test: "a year in the release name must be one of the show's years" |
| 6 | a country-tagged name removes the bare title from the keys | release.test: "a show with a country tag in a name is never matched by the bare title" |

Also added: a plan test pinning rewatch and out-of-order behaviour (it passes before and after),
and a main.test year guard for the main.js wiring (it is not fail-first).

### Checked and found sound (no change)
- **Dry run queues nothing.** The only queueing call is the download POST, behind the
  `dry_run` check. Tests assert zero download POSTs.
- **The budget holds across a restart.** Each search is persisted right after the hub_search
  POST is accepted. Dry-run searches go through the same budget and spacing.
- **Furthest played.** The maximum (season, episode) among played, held episodes. A rewatched
  early episode does not move it back, and the server's NextUp does the same
  (JellyfinApi.cpp:16703-16716). Out-of-order viewing moves it forward to the furthest one, by
  design. Pinned with a plan test.
- **Search result shapes.** `dupe` is null when there is no dupe (Serializer.cpp:215-229), so
  the `if (result.dupe)` skip is correct. The `type.id` values are directory/file, and
  `users.count` and `slots.free` exist (SearchUtils.cpp).

### Nits (not fixed)
- `pruneRecords` drops "queued" records after 90 days. A download the user removed could then be
  queued again if it is still among the next episodes.
- The exists-check uses the raw core download directory. A `%[...]` parameter in it is not
  expanded, so that check misses.
- When the series has no TMDB id in the library, TMDB is searched by the library name. For
  "The Office (US)" that search finds no exact name, so the show is skipped. That is safe (it
  downloads nothing) but quiet.

## Live test 2026-10-19 (1.1123 rig)

### L1. should-fix: no TMDB key + server metadata off = silent "nothing needed" (FIXED)
`src/main.js` wantedFor, fallback branch. The server lists missing rows only for a series its
metadata identified. Live: "0 queued, 0 would be queued, 0 not found" for a show with E03/E05
missing. Fix: such a show is collected in `lastRun.unknown`, and `/keepup status` says "next
episodes unknown for: <show> (no TMDB key, and the media server's metadata has not identified
it)". Test: main.test "live test: without a TMDB key, a show the media server has not identified
is named ..." (failed before).

### L2. should-fix: the settings load was handled as a change before the state existed (FIXED)
`src/main.js` onValuesUpdated. airdcpp-extension-settings ends `load()` with
`onValuesUpdated(allValues)`; that ran before `loadState()`, so every start logged
"Settings update failed: Cannot set properties of null (setting 'token')" (error.log, live).
Handled as a change it would also drop the stored sign-in and the dry-run records at each start.
Fix: ignore calls before the state is loaded. Test: main.test "live test: the settings load at
start is not taken for a change" (the settings mock now fires the load-time call like the real
library; failed before with the error logged).
