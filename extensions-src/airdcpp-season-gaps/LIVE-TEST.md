# Live tests for airdcpp-season-gaps

Not part of the npm package. Run against a build of origin/master (f163a4989 or later).

## Rig

- Media server enabled and running (Web API `GET media_server` -> `running: true`), bound to
  0.0.0.0 or 127.0.0.1 (both must work; `[::]` should map to `[::1]`).
- Media server **user store** with an account `gaps` (not admin is fine, but it must see the TV
  folders), password set. Note: the legacy single-credential mode (no user table) can never use
  the native missing-episode lists (withMissingEpisodes needs `store->byId`), so test it once too.
- Media server metadata (TMDB) key configured in the client, so series carry ProviderIds.Tmdb and
  the native season lists can be fetched.
- A TV library folder with at least:
  - `Show A` with S01E01, S01E03 (E02 missing), S03E01 (S02 missing entirely) -- a real, ended
    TMDB show so the answer is stable
  - a double-episode file `Show.B.S01E01E02.1080p-X.mkv` (E01 and E02 must NOT be reported)
  - an anime-style season numbered from the show start (e.g. S01E130) -- must be left out
- Extension settings: `media_server_user=gaps`, `media_server_password=...`; TMDB key for the
  scenarios marked [TMDB].
- One hub connected (mini ADC hub rig) with a second client sharing
  `Show.A.S01E02.1080p.WEB.h264-GRP` (a folder with an .mkv inside), plus decoys
  `Show.A.S01E02.720p.WEB-GRP`, `Show.A.S01E03.1080p.WEB-GRP`, `Show.A.Aftershow.S01E02.1080p-GRP`.

## Scenarios

1. **Neither source** (DisplayMissingEpisodes off, no TMDB key): `/gaps check` in a hub window.
   Expect the status line "The check failed: nothing to compare with: turn on "Display missing
   episodes"..." and an error event. Nothing is sent to the hub (watch the hub's main chat on the
   other client).
2. **Native only** (turn on "Display missing episodes" for `gaps` in jellyfin-web, no TMDB key):
   `/gaps check` twice, a minute apart (the first may be incomplete while the media server fetches
   season lists). Expect Show A: S01E02 missing; no whole-season S02 (needs TMDB); Show B: no
   gaps; the anime show: no gaps. Report `season-gaps.md` in the extension config dir lists the
   note "No TMDB key is set".
3. **[TMDB] whole seasons**: add the TMDB key. `/gaps check`: Show A also reports "S02: whole
   season" (between owned seasons). Turn off `report_seasons_between` -> S02 disappears. If the
   show has a season newer than S03, it appears (report_seasons_after on by default).
4. **[TMDB] fallback**: turn "Display missing episodes" off again. `/gaps check` still reports
   S01E02 (from TMDB) and the report says missing episodes come from TMDB.
5. **set_display_missing**: with the preference off, turn the setting on and check. Expect a note
   "Turned on "Display missing episodes"..." and jellyfin-web for `gaps` now shows missing rows on
   season pages. Verify no other account changed.
6. **Fill**: `/gaps fill show a S01`. Expect the two status lines; ~15-20 s later
   `Show.A.S01E02.1080p.WEB.h264-GRP` is queued into the default download directory and an event
   "queued Show A S01E02: ..." appears. None of the decoys is queued. The search instance
   disappears from `GET search` afterwards. With airdcpp-download-sorter installed, the finished
   download is filed.
7. **Budget**: set `searches_per_hour=2`, `/gaps fill` a show with 5 missing episodes; over the
   next 10 minutes exactly 2 hub searches are sent (hub log / second client's incoming searches),
   at least 20 s apart. Restart the extension: still no third search within the hour.
8. **No exact match**: `/gaps fill` an episode nobody shares -> nothing queued; `state.json`
   attempts shows "no exact match among N result(s)".
8b. **Same-named show from another year / country** (review fix): share decoys
   `Show.A.2005.S01E02.1080p.WEB-YR` (wrong year; the library's Show A has ProductionYear 2020) and,
   for a library series named `Show B (US)` whose TMDB name is plain `Show B`, a decoy
   `Show.B.S01E02.1080p.WEB-UK`. `/gaps fill` either -> neither decoy is queued;
   `Show.B.US.S01E02...` and `Show.A.2020.S01E02...` would be.
9. **Already queued**: queue S01E02 by hand first, then `/gaps fill show a` -> no search is sent
   for S01E02.
10. **Menu**: Extensions window, right-click airdcpp-season-gaps -> "Check for season gaps now"
    runs a check (event appears). Right-click any other extension: the item is absent.
11. **Kill safety**: during a fill (pending list > 1), kill the extension process; restart: the
    pending list is still in `state.json` and continues; no duplicate search for the episode in
    flight beyond what the budget allows.
12. **Secrets**: grep the extension log, the event log, `season-gaps.md` and `last-check.json` for
    the password, the TMDB key and the AccessToken from `state.json`: none present.
13. **Media server off**: disable the media server, `/gaps check` -> "the media server is not
    enabled"; the next scheduled attempt is within an hour, not every 10 minutes.
14. **Token reuse**: restart the extension with the client still running: no new sign-in in the
    media server's activity log (the stored token is reused). Restart the client: exactly one new
    sign-in at the next check.

## Not verified by unit tests

- The real Web API payload shapes for search results (`type.id`, `dupe`, `hits`) and the hub text
  command events; the tests use the shapes read from the source.
- Whether jellyfin-web's display preference write reaches `POST /Users/{id}/Configuration` for a
  non-admin account in this build (it should: a person may change their own).

## Results 2026-10-19 (extrig: real 1.1123 clients, mini ADC hub, C:/airdc-ng/qa-tools/probes/extrig)

Rig limit: no TMDB key exists on this machine, and the 1.1123 media server has no built-in one
(MediaServerMetadataKey empty, metadata off by default; the catalogue root is test-only), so the
server's native missing rows never exist and the TMDB path cannot run. Library: "Fawlty Towers
(1975)/Season 01" E01, E02, E04, E06 (extrig/tvgaps/mktv.ps1); media account `gaps`.
- 1 neither source: PASS (status line + error event, nothing sent to the hub).
- 2 native only: NOT RUN as specified (no metadata -> 0 rows). Found bug L1 (a false "0 with
  gaps"), fixed; live now: "1 show(s) not identified, see the report" + a note + "Not fully
  checked".
- 3, 4 [TMDB]: NOT RUN (no key).
- 5 set_display_missing: PASS. Only `gaps` got DisplayMissingEpisodes=true; qa, keepup unchanged.
- 6 fill: PASS with a SEEDED gap list (last-check.json given E03 + E05 by hand, marked
  `seededByRig`). Two hub searches 20 s apart (`Fawlty Towers S01E03 1080p`, `... S01E05
  1080p`); queued only the exact releases (E03 as the file inside the exact folder, E05 as the
  folder); FRENCH, `-sample.mkv` and `Fawlty.Towers.2005...` never queued; search instances
  removed.
- 7 budget across a restart: PASS. searches_per_hour=2 (both used), extension restarted, `/gaps
  fill`: 0 searches in 70 s, 2 pending kept; back to 20: searched, "already in the download
  queue", nothing new queued.
- 12 secrets: PASS (password and token absent from logs, events, report, last-check.json).
- 8-11, 13, 14: not run.

## Results 2026-10-19, second run with a real TMDB key (extrig, 1.1123)

The user's own TMDB v3 key was put only into the rig: client 1's MediaServerMetadataEnabled +
MediaServerMetadataKey (DCPlusPlus.xml, client stopped; not Web API settings) and this
extension's `tmdb_key`. Both were removed again afterwards. Library: "TV/Fawlty Towers
(1975)/Season 01" E01, E02, E04, E06. Peer: exact E03 and E05 folders, FRENCH, `-sample.mkv`,
`Fawlty.Towers.2005...` decoys and the loose `Fawlty.Towers.S01E03.1080p.WEB-DL.x264-GRP.mkv`
beside its folder. Scrubbed evidence: extrig/tvgaps/evidence-tmdb.
- Media server identification: PASS. About 3 min after the start, the series had ProviderIds.Tmdb
  2207 and real episode names.
- 2 native only (`set_display_missing` on; it switched `gaps` on): PASS on the second check:
  "Fawlty Towers: 2 missing (S01: E03, E05)". The FIRST check said 0 (bug L3, fixed: now asked
  again after a pause; live: a new Season 02 was complete on its first check).
- 3 [TMDB] whole seasons: PASS. "S02: whole season, E01-E06" (report_seasons_after).
- 4 [TMDB] fallback (DisplayMissingEpisodes off): PASS. "Sources: TMDB", S01E03 and S01E05; the
  cache then held tv-2207, tv-2207-s1 and tv-2207-s2.
- 6 fill: run 1 queued the LOOSE `.mkv` for E03, because the exact folder was a dupe (stale share
  entry from an earlier run). Bug L2, fixed. On the fixed build: the same stale state led to "no
  exact match", nothing queued; with a clean share both exact FOLDERS were queued (searches 20 s
  apart). FRENCH, sample, 2005 and the loose file were never queued. PASS.
- 12 secrets: PASS. The key was absent from the extension logs, the client logs, the events, the
  hub window, season-gaps.md and last-check.json (0 hits). A wrong key gave "TMDB refused the key"
  and appeared nowhere.
