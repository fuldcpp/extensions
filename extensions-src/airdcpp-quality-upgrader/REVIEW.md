# Independent review: airdcpp-quality-upgrader 1.0.0-beta.1

Reviewed 2026-10-18 against airdcpp-windows origin/master f163a4989. Every finding below was
reproduced (probe script or a unit test that failed on the unfixed code) before it was fixed.

## Blocker

### B1. Foreign-language, dubbed, hardcoded-sub, extras and subpack releases count as "the same" (release.js, quality.js:525)
`judge()` compares title, year, episode numbers, resolution, source, group. Words outside those are
ignored, so (probe, unfixed code, default profile):

| kept | found | verdict |
| --- | --- | --- |
| `Show.S01E02.720p.HDTV.x264-GRP` | `Show.S01E02.FRENCH.1080p.WEB.H264-FGRP` | upgrade |
| same | `Show.S01E02.GERMAN.DL.1080p.WEB.h264-GGRP` / `.iTALiAN.` / `.NORDiC` / `.SWESUB.` | upgrade |
| `Movie.2019.720p.BluRay.x264-GRP` | `Movie.2019.1080p.HC.WEBRip.x264-HGRP` (Korean hardsubs) | upgrade |
| same | `Movie.2019.DUBBED.1080p.WEB-DL...` / `.MULTi.` | upgrade |
| `Show.S01.720p.BluRay.x264-GRP` (season pack) | `Show.S01.EXTRAS.1080p.BluRay...` / `.Bonus.` | upgrade |
| `Movie.2019.720p...` | `Movie.2019.1080p.BluRay.x264.SUBPACK-SGRP` / `.Trailer-` | upgrade |

With "Replace automatically" on, the user's English episode is replaced by a French dub and a
season pack by its bonus disc (the real copy goes to holding). Fixed: the parser collects
language/dub/hardsub tags and content tags (extras, bonus, subpack, trailer, sample, cam, ts,
screener, 3d, disc/part numbers) found after the title; a find that carries a tag the kept copy
does not carry is never an upgrade. Test: `quality.test.js` "a find marked with a language, dub,
hardsub or extras tag the kept copy lacks is never an upgrade" + release.test.js tag cases.

## Should-fix

### S1. The download is queued before the job is written to disk (main.js:299-330)
`startJob` POSTs `search/{id}/results/{tth}/download`, then creates the job; it reaches
`state.json` only at main.js:390. A kill (TerminateProcess) in between leaves a bundle downloading
into the staging folder that no job knows: never placed, never reported, in staging forever.
Fixed: the job is written (state `queued`) before the POST and removed again if the POST fails.
Test: "the job is on disk before the download is queued".

### S2. A finished download removed from the queue strands the new copy in staging (main.js:757-771)
`queue_bundle_removed` always cancelled the job, and a job whose bundle vanished stayed `queued`
until it "expired" after 14 days. Removing a completed bundle (queue UI "Remove completed", or the
core's "Remove finished bundles on exit": QueueManager.cpp:100 on origin/master removes them in the
destructor without any listener event) leaves the complete upgrade in the staging folder forever.
Fixed: completion is written to the job the moment it is seen; a removed bundle that was complete
(payload `status.completed`, or completion already recorded) moves the job on to "downloaded"; at
start a queued job whose completed bundle is no longer in the queue is moved on too. A bundle
removed before completion still cancels. Tests: "a completed download removed from the queue is
still put in place", "a completed bundle that vanished while the extension was not running".

### S3. The old copy is moved away without checking the new copy is still there (main.js:590-656)
`stepPlaced` waits up to 2 hours for the library, then moves the old copy to holding. If the new
copy was deleted or moved meanwhile, the title disappears from the share (and with the purge
enabled the only copy is deleted after N days). Fixed: the new copy must still exist beside it.
Test: "the old copy stays when the new copy is gone before it is replaced".

### S4. Turning "Replace automatically" off does not stop replacements already under way (main.js:701-776)
The setting reads "off = only report", but `processDue`/`onBundleCompleted` kept moving files for
jobs queued while it was on. Fixed: file steps (`downloaded`, `placed`) wait while the switch is
off and continue when it is turned on again. Test: "switching automatic replacing off pauses jobs
under way".

### S5. Library join by file name ignores same-named files outside release folders (inventory.js:287-302)
Only video files inside release folders were indexed. A library item `Home\movie.mkv` (personal
folder) joined to the one release folder that also holds a `movie.mkv`; the measured picture size
of the personal file (say 640x360 -> 480) then made any 720p/1080p find an "upgrade" of a release
that already is 1080p, and the release folder was replaced. Fixed: loose video files anywhere in
the walked share are counted too; a name found anywhere else is ambiguous and not joined (reported
only, never replaced). Test: main "library mode: a personal file sharing the release file name is
not joined, so nothing is replaced".

### S6. Kill after a cross-drive copy is committed: job fails, upgrade left in staging and beside the old copy (main.js:517-519)
`moveInto` renames `<name>.upgrader-partial` to the final name, then deletes the staging copy. A
kill between those two leaves both; the next start sees the destination exists and fails the job
("already exists"), so the replacement never finishes. Fixed: when the move had started and the
destination holds exactly the staging copy's files and sizes, the job carries on as placed and
the note says a leftover copy remains in staging (nothing is deleted). Leftovers from a normal
cross-drive move are noted the same way. Test: "killed after a cross-drive copy was committed".

## Nits (fixed)
- inventory.js:300 `byFile.get(stripExtension(fileName))` can never match (keys carry the
  extension); removed.

## Checked, no finding
- Coordinator's season-gaps findings (year / country tag): not present here. The identity is the
  exact key `title (year)` / `title:SxxEyy` of both parsed names, so a missing year on one side
  never equals a year on the other, and `The.Office.US` keys as "the office us". Locked in by
  quality.test.js "another year or another country of the same title is never the same thing"
  (Doctor.Who 1963/2005/none, Dune 1984/2021/none, The.Office US/UK/bare), which passes on the
  unfixed code too: no fix was needed. Limit: two yearless names of different shows are the same
  key; a name cannot tell them apart.
- Report only: the only download POST is in `startJob`, reached only from `searchOnce` behind
  `value('auto_queue')`. The passive `search_result_added` listener (module-level, entity id =
  instance id, payload `{search_id, result}`: SearchEntity.cpp:236-240) only records a find and
  raises the title's priority; the next search still goes through the budget.
- "Strictly better": 2160p over a 1080p maximum is rejected (`above the maximum resolution`); a
  PROPER from another group is `not better` (sameRelease needs the same group, source, codec).
- Routes verified: search, hub_search (`queued_count`, `queue_time`), results range, download
  (`target_directory`, `target_name`, Deserializer.cpp:144/156), queue bundles/remove
  (`remove_finished`), bundle `status.completed` (= STATUS_COMPLETED or later, Bundle.cpp:134),
  media_server `{running, address, port}`, `/UserItems/{id}/UserData` (JellyfinApi.cpp:17974),
  item Path `fuldc:/<id>/<file name>` (:6295).
- Search budget persisted before the search; spacing min 15 s; one search at a time.

## Not verified
- Live behaviour (no client run, per the brief). Whether the media server lists packed (RAR)
  releases under the inner file name: MediaLibrary.cpp:1984 says yes, so a packed new copy is
  never found by file name and the watched-state carry over gives up after its wait.

## Live test 2026-10-19 (FulDC++ 1.1123, two clients on a private hub)

Three bugs found live; each has a test that failed on the unfixed code and passes now.

| # | Severity | Where | What happened | Test |
| --- | --- | --- | --- | --- |
| L1 | blocker | src/settings.js `preferred_codec` | The client refused the definitions ("Failed to register settings: Field can't be empty", field `id`): SettingUtils.cpp reads an option id with allowEmpty = false. The extension ran with no settings, and the load callback then threw "Cannot use 'in' operator ... undefined". Fixed: the option id is `none` (= no preference); the handler tolerates an undefined payload. | settings.test.js "every option id is a non-empty string..." |
| L2 | blocker | src/main.js onStart | airdcpp-extension-settings' `load()` ends by calling onValuesUpdated with EVERY value. The handler was set before `load()` and `loadState()` ran after it, so the handler saw `media_username` and saved the still-empty default state over `state.json` on every start. Live: the client was killed while an upgrade waited in "placed"; after the restart the job was gone and both copies stayed in the share for good. The search budget and the rotation were reset by every restart too. Fixed: `loadState()` first, the handler set after `load()`. | main.test.js "a start keeps state.json..." (the fake settings manager now calls the handler like the real one) |
| L3 | should-fix | src/release.js group parsing | `Some.Film.2019.1080p.WEB-DL.x264-GRP-sample` took `sample` for the group, so no tag was seen and it judged as a 720p -> 1080p upgrade (found with an offline probe over the live test's decoy names, before the live run). With the real release present the ranking picked the real one, but on its own the sample folder would have been downloaded. Fixed: `-sample/-proof/-subs/-subpack/-extras/-bonus/-trailer/-teaser/-featurette(s)` after the group is a content tag. | quality.test.js "a \"-sample\" / \"-proof\" / \"-subs\" suffix..." |

Also found: the README said the new copy is not hashed again. The core adds a finished bundle's
files to the hash database only when the bundle is in a shared folder (QueueManager.cpp, "isn't in
a shared folder"), so `hash/rename_path` fails for the staging files and the new copy is hashed
once after the move (seen live: 2 files, 6.22 MiB). The old copy's hash data does move. README
corrected; no code change (there is no API to add a hash entry).
