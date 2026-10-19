# Live test plan: airdcpp-quality-upgrader 1.0.0-beta.1

Not part of the npm package. Run one scenario at a time on the two-client download rig (client A
runs the extension, client B shares the "better" releases on the same hub).

## Rig settings

- Client A: a share root, e.g. `D:\qa\share`, holding
  - `D:\qa\share\TV\The.Show.S01E02.720p.HDTV.x264-GRP\video.mkv` (a real small video file)
  - `D:\qa\share\Movies\Some.Movie.2019.720p.BluRay.x264-GRP\movie.mkv`
  - `D:\qa\share\Holiday 2019 1080p\clip.mkv` (a personal folder; must never be touched)
- Client B shares, on the same hub:
  - `The.Show.S01E02.1080p.WEB.h264-NEW\` (bigger file than A's copy)
  - `The.Show.S01E03.1080p.WEB.h264-NEW\` (wrong episode; must never be taken)
  - `Some.Movie.2019.2160p.BluRay.x265-UHD\` (above the default maximum)
  - `Some.Movie.2019.720p.BluRay.x264-GRP.PROPER` style: `Some.Movie.2019.PROPER.720p.BluRay.x264-GRP\`
- Extension settings to speed things up: searches per hour 60, spacing 15 s. Leave the rest
  default first.
- First inventory runs 60 s after start; each tick is 15 s; results are collected 30 s per search.

## Scenarios

1. **Report only (default).** Start the extension. Within ~3 minutes the event log shows
   `upgrade found for The.Show.S01E02.720p.HDTV.x264-GRP: The.Show.S01E02.1080p.WEB.h264-NEW (720p -> 1080p)`
   and `upgrade found for Some.Movie.2019.720p.BluRay.x264-GRP: Some.Movie.2019.PROPER.720p.BluRay.x264-GRP (PROPER of the same release)`.
   Expected: nothing queued, no file moved; `upgrades.md` in the extension's settings folder lists
   both; `/upgrade list` in a hub window prints them prefixed `[upgrade] `; the S01E03 and 2160p
   releases are never reported; the personal folder is never mentioned.
2. **Budget.** Set searches per hour to 2. Check in the client's search/hub logs (or B's incoming
   search log) that no more than 2 searches from A arrive in an hour and never closer than the
   spacing. Restart A: the count carries over (state.json `searches`).
3. **Other searches.** In A, search manually for `The Show S01E02`. The result from B makes the
   title jump to the front: the extension's next search is for that title (`upgrades.md` row says
   "seen in another search").
4. **Auto replace.** Set staging `D:\qa\staging`, holding `D:\qa\holding` (outside the share),
   turn on "Replace automatically". Expected: the 1080p episode downloads into `D:\qa\staging`;
   when complete it disappears from the queue, appears in `D:\qa\share\TV\`, the 720p folder ends
   up in `D:\qa\holding\The.Show.S01E02.720p.HDTV.x264-GRP`; the event log says
   `replaced ... the old copy is in ...`; no rehash of the moved files in the hashing view.
5. **Kill mid-way.** Repeat 4 with a large file and staging on another drive than the share;
   end the client while `*.upgrader-partial` exists beside the old copy. Restart: the partial is
   removed, the copy is redone, the end state is the same as in 4. No file lost.
6. **In use.** While B downloads the OLD copy from A (upload in progress), let the upgrade
   complete. Expected: new copy placed, old copy stays (event "... trying again later"), moved to
   holding once the upload ends.
7. **Holding folder inside the share.** Set holding to `D:\qa\share\old`. Expected: finds are
   reported with "not replaced automatically: the holding folder is inside the share"; nothing
   downloads.
8. **Media server + watched state.** Media server enabled with `D:\qa\share` as library, an account
   `qa`/`qa`. Enter it in the extension. Mark the 720p episode watched in the web client. Run 4.
   Expected: `/upgrade status` says "from the media library"; after the replacement the 1080p
   episode shows as watched for `qa` (by the server's own adopt when the new file is bigger, or by
   the extension's POST /UserItems/{id}/UserData). Check a second account's tick too and note the
   result (only carried by the server's adopt).
9. **Wrong media server password.** Enter a wrong password. Expected: one warning "could not read
   the media library (media server: HTTP 401); checking the share folders instead"; the password
   never appears in any log.
10. **Purge.** Off by default: confirm nothing in the holding folder is deleted. Set 0 -> 1 day,
    put a foreign folder in the holding folder, advance the clock or wait: only the extension's
    own held copy is deleted.

11. **Foreign-language find (review B1).** B also shares `The.Show.S01E02.FRENCH.1080p.WEB.H264-FGRP\`
    and `The.Show.S01E02.1080p.HC.WEBRip.x264-HGRP\`. Expected: neither is ever reported or
    downloaded; only the `-NEW` release is.
12. **"Remove completed" (review S2).** Auto replace on; when the upgrade bundle completes, remove it
    from the queue at once (within 30 s) without deleting files. Expected: the replacement still
    happens. Repeat with client setting "Remove finished bundles on exit" on and exit the client
    right after completion: on the next start the replacement happens.
13. **Switch off mid-way (review S4).** Auto replace on; while the upgrade downloads, turn "Replace
    automatically" off. Expected: when complete it stays in staging, the old copy untouched; turn it
    on again: the replacement finishes within a tick or two.
14. **New copy deleted while waiting (review S3).** With a media server login, after "put ... in"
    and before the library lists it, delete the new folder. Expected: the job fails with "the new
    copy is no longer beside the old one"; the old copy stays in the share.

## What to look at

- Event log (prefix `airdcpp-quality-upgrader:`), extension log, `state.json`, `upgrades.md`.
- No hub warning/kick for searching too often.

## Results 2026-10-19 (extrig rig: FulDC++ 1.1123 client 1 + peer, hub 2884, media server 48197)

No TMDB key on the rig: items were identified from file names only. Client 1 owned
`Movies\Some.Film.2019.720p.WEB-DL.x264-GRP` (a real 1280x720 mp4) and four filler titles; the peer
shared the 1080p release and five decoys (2160p, FRENCH, 2021, `-GRP-sample`, HC).

| Scenario | Result |
| --- | --- |
| Settings register | FAIL, fixed (REVIEW L1), then PASS |
| Report only | PASS: one event, `/upgrade list` and `upgrades.md` name only the 1080p release; no bundle queued. A manual search returning all six folders (passive path) added no other find |
| Budget 3/hour, spacing 15 s | PASS: three searches 45-46 s apart, then none (a title raised by a passive sighting waited for the budget) |
| Auto replace (staging + holding outside the share, media login) | PASS: downloaded to staging, put beside the old copy, old copy moved to holding (not deleted); share and library list only the new copy. The new copy was hashed once more (README corrected) |
| Watched state | PASS: `qa` and a second account `gaps` both show the new copy played with the old copy's LastPlayedDate; carried by the media server's adopt (the extension logged no "Watched state carried over") |
| Kill in "placed" (both copies beside each other) | FAIL first: state.json wiped on restart, both copies left shared (REVIEW L2). After the fix PASS: the job resumed, the old copy went to holding, nothing lost, no duplicate left in the share |
| `-GRP-sample` decoy | fixed (REVIEW L3) before the run; live: never reported |
