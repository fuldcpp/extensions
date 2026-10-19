# airdcpp-keep-up: live test plan (for the coordinator; not in the npm package)

Nothing here has been run live. Every scenario below is untested against a real client.

## Rig needs

- A FulDC++ build of origin/master (f163a4989 or later) with the media server ENABLED and
  RUNNING (`GET /api/v1/media_server` -> `running: true`; note its `address`).
- A share holding a TV show the library places under a "TV shows" library, e.g.
  `The.Show.S01E01...`, `S01E02`, `S01E03` (real files the scanner accepts as episodes).
- A media-server account (user + password) in the media server's user list.
- A TMDB key for the show's real TMDB entry (or test the no-key path, scenario 7).
- Two clients on a hub (qa-two-client-download-rig): client B shares `The.Show.S01E04.1080p.WEB-GRP`
  (and a decoy `Another.Show.S01E04.1080p-AAA`, a pack `The.Show.S01.1080p-PACK`, a double
  `The.Show.S01E04E05.1080p-X`).
- Install the tarball on client A; set user/password and TMDB key in the extension settings.

## Scenarios

1. **Watched state is read.** On client A's media server, as the account, mark S01E01 and S01E02
   played (web client "mark played", or play them). Type `/keepup run` in a hub, wait ~1 min,
   `/keepup status`.
   Expect: "following: The Show"; event log "dry run: would queue The.Show.S01E04.1080p.WEB-GRP"
   (S01E03 is held, so not searched). Nothing in the queue. Decoy, pack and double are never named.
2. **Real queue.** Turn dry run off. `/keepup run`.
   Expect: bundle `The.Show.S01E04.1080p.WEB-GRP` in client A's queue, event "queued ...". State
   file `keep-up-state.json` shows `show1...:S01E04` status `queued` immediately (kill FulDC with
   Task Manager right after and check the file).
3. **Never again.** Remove the bundle from the queue. `/keepup run`.
   Expect: no new search for S01E04 (`/keepup status`: searches unchanged).
4. **Stops by itself.** Set "Follow shows watched within" to 1 day while the last play is older
   (or set the PC clock forward), `/keepup run`. Expect: "nothing watched in the last 1 day(s)",
   no search.
5. **Budget and spacing.** Set searches per hour to 2, episodes ahead 5 with 5 missing aired
   episodes. `/keepup run`. Expect: exactly 2 hub searches (client B's search log / hub), at least
   20 s apart, then status "stopped early: the hourly search budget is used up". Restart the
   extension and `/keepup run`: still no search within the hour.
6. **Existing folder.** Create `<download folder>\The.Show.S01E05.1080p.WEB-GRP` by hand (B shares
   that release too). Expect: warning "not queuing ... already exists"; the folder untouched.
7. **No TMDB key.** Clear the key; turn on "Display missing episodes" for the account in the web
   client's settings (the server's metadata/catalogue must be configured so missing rows exist).
   Expect: the next aired episodes of held seasons are searched; nothing of an unheld season.
8. **Wrong password.** Set a wrong password, `/keepup run`. Expect: status "failed: the media
   server refused the user name or password"; the client log/event log contains no password;
   a second `/keepup run` within 10 minutes makes no sign-in attempt (media-server log shows one
   failed sign-in, not two).
9. **Media server off.** Disable the media server, `/keepup run`. Expect: "failed: the media server
   is not running", nothing else.
10. **Bind address.** If MediaServerBindAddress is a LAN IP (not 0.0.0.0), check the extension
    reaches the server at that address (it uses the `address` the Web API reports; 0.0.0.0/:: are
    replaced by 127.0.0.1). If it cannot, set "Media server address" explicitly.

11. **Renamed bundle still counts.** Set the count cap to 1, dry run off, `/keepup run` (one
    queued). Rename that bundle in the queue, wait for the next check (or `/keepup run` after its
    retry time). Expect: "1 download(s) of this extension are already in the queue", no new
    download.
12. **Failed folder download is retried.** Client B shares the release folder and goes offline
    right after A's `/keepup run` queues it (before the file list arrives). Expect: warning event
    "... could not be queued (the source's file list did not arrive)"; `/keepup status` lists the
    episode as "download failed"; it is searched again after 1 h.
13. **Strict names.** B also shares `The.Show.2024.S01E04.1080p.WEB-GRP` (another year) and
    `the.show.s01e04.1080p.web.h264-grp-sample.mkv`, `The.Show.S01E04.FRENCH.1080p.WEB-GRP` and
    `The.Show.S01E04.SUBPACK-GRP`. Expect: none is ever named or queued (the FRENCH one only after
    adding `french` to "Accepted language tags").

## Things to watch

- Event log lines must never contain the TMDB key, the password or the access token.
- `search` instances created by the extension disappear after each search (Web API
  `GET /api/v1/search` list).
- CPU stays flat between checks (the extension only wakes on its interval and on `/keepup`).

## Results 2026-10-19 (extrig: real 1.1123 clients, mini ADC hub, C:/airdc-ng/qa-tools/probes/extrig)

Rig limit: no TMDB key on this machine; the media server's metadata is off and keyless, so its
"missing" rows never exist. Library E01, E02, E04, E06 of Fawlty Towers (1975); media account
`keepup` marked E01, E02 played with `POST /Users/{id}/PlayedItems/{itemId}` (route checked on
origin/master, JellyfinApi.cpp:15349).
- 1 watched state read: PASS ("following: Fawlty Towers").
- 7 no TMDB key (native fallback): ran; nothing can be found without server metadata. Found bug
  L1 (a silent "0 not found"), fixed; live now "next episodes unknown for: Fawlty Towers (...)".
- The TMDB path ran OFFLINE with a SEEDED cache (extrig/tvgaps/seed-keepup-tmdb.ps1: Fawlty
  Towers 2207, both seasons, fresh entries, a dummy key; no TMDB request was made):
  - dry run ON, max_active_bundles 1: one search `fawlty.towers.S01E03 1080p`, event "dry run:
    would queue Fawlty.Towers.S01E03.1080p.WEB-DL.x264-GRP", stopped "1 download(s) would be in
    the queue (the cap)", queue unchanged. PASS.
  - dry run OFF, cap 1: queued only Fawlty.Towers.S01E03.1080p.WEB-DL.x264-GRP, stopped "1
    download(s) of this extension are already in the queue"; E05 not searched. Cap 10: queued
    only Fawlty.Towers.S01E05.1080p.WEB-DL.x264-GRP. FRENCH, sample and 2005 decoys never
    named. State written at once (bundleId + directoryDownloadId). PASS.
- Bug L2 (error.log line at every start) found and fixed; error.log stayed empty after reinstall.
- 3-6, 8-13: not run.
