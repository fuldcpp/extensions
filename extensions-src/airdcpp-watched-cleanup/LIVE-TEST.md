# Live test plan: airdcpp-watched-cleanup 1.0.0-beta.1

Not part of the npm package. Run one scenario at a time on a rig client (origin/master build).
Do NOT point it at a share holding anything you want to keep. Everything moved should land in
the Recycle Bin; empty the rig's bin afterwards.

## Rig setup

- Media server enabled and running (Settings > Media server). Check that the Web API `GET media_server`
  answers `running: true` and an `address`. Note the bind address: a LAN IP is used as it is, and
  0.0.0.0 is turned into 127.0.0.1.
- Two media server accounts: `me` (admin) and `kid`.
- A share root on a FIXED local drive, e.g. `X:\WCL\` (also a media library root), holding:
  - `Films\Old.Film.2019-GRP\Old.Film.2019.1080p-GRP.mkv` + `.nfo` + `Sample\old-sample.mkv`
  - `Films\Two.Versions\A.2018.720p.mkv` and `Films\Two.Versions\A.2018.1080p.mkv`
  - `Shows\Show.Name\Season 01\Show.Name.S01E01.mkv` (+ `Show.Name.S01E01.en.srt`), `...S01E02.mkv`, `...S01E03.mkv`
  - `Keep\Classic.1960\Classic.1960.mkv`
  - `Rec\News 20261001 1a2b3c.ts` (shaped like a recording)
  - `Films\Thesis\film.mkv` + `thesis.docx`
- Small video files are fine; the media server types films and episodes from the names.
- Extension settings: account `me` + password; Keep folders = `X:\WCL\Keep`; watched_days = 1 and
  added_days = 0 so the test does not need to wait. (Also try the defaults once: nothing should be
  offered.)
- To get "watched long ago", mark items played from a client (or jellyfin-web) as each account,
  then set watched_days to 0 for the run. LastPlayedDate must be set, so play a few seconds or
  use "mark played".

## Scenarios and expected results

1. **Report only (default).** Mark the old film, S01E01 and S01E02 played as `me`. Type
   `/cleanup list` in any hub.
   - Status lines start with `[cleanup]`, and only you see them; nothing goes to the hub.
   - Offered: Old.Film (as a whole folder), S01E01 (the .mkv plus the .en.srt). S01E02 is kept as
     the last watched episode (keep_last_episodes = 1). Classic is not offered (keep folder), and
     neither is the recording.
   - `watched-cleanup-report.md` appears in the extension's config folder, with sizes matching
     Explorer and a total per drive.
   - Nothing moved: check Explorer and the Recycle Bin.
2. **Second account not listed.** With `kid` existing but not listed, `/cleanup run` answers
   "Not cleaning: the media server also has kid" and moves nothing. `/cleanup list` reports
   "Not counted: kid".
3. **Every listed account must have watched it.** Add `kid` under "Other accounts" with its
   password. As `kid`, mark only S01E01 played. `/cleanup list` now offers S01E01 only.
4. **Run.** As `kid`, also mark the film played. `/cleanup run`:
   - It first prints the dry-run list, then "Moving to the Recycle Bin", then
     `Moved 2 item(s)`.
   - The film folder and S01E01 (+ .srt) are in the Recycle Bin (Explorer > Recycle Bin, "Original
     location" column). Restoring them works.
   - Within a minute or so the share refresh drops them: the client's share browser and the media
     server (jellyfin-web) no longer list them. **This is the step to verify:** that
     `share/refresh/paths` on the parent folders leads to a library rebuild.
   - `cleanup-history.log` has a `recycling` and a `recycled` line for each.
5. **Favourite / in progress.** Mark S01E03 played for both, then make it a favourite as `kid`:
   not offered. Unfavourite it and start playing S01E02 again as `me` (stop half way): no episode
   of Show.Name is offered.
6. **In use.** Start playing the Two.Versions film (or open the file in a player) while it is a
   candidate. (Two.Versions holds two videos, so it should be skipped as "parts or versions"
   anyway; to test "in use", use a single-file episode instead.) Expected: `not moved ...: in use`,
   and the subtitle beside it stays.
7. **Download queue.** Queue a download into `Films\Old.Film...` (or re-create the folder and
   queue a file to it): `/cleanup list` reports it as left alone, "in the download queue".
8. **Stranger in the folder.** `Films\Thesis` holds a .docx: only `film.mkv` is moved, the folder
   and the document stay.
9. **Caps.** max_items_per_run = 1: `/cleanup run` moves only the item watched longest ago.
10. **Non-fixed drive.** If the rig has a USB stick or a network share as a share root, a
    candidate there is refused with "no recycle bin on this kind of drive" and stays where it is.
10b. **Other media in a release folder** (review 2026-10-18). Put `IMG_0001.jpg` (a photo) or a
    second packed set `other.rar`+`other.r00` into a watched film's release folder: `/cleanup list`
    shows only the video (or, for a packed film, "packed release that shares its folder"), never
    the folder. Remove it again and the folder is listed whole.
10c. **SUBST letter / junction** (verified offline on this machine: before the fix a file on a
    SUBST letter was DELETED, not recycled). If the rig can share a folder through `subst S: ...`
    or a junction, a candidate there is refused with "not a volume of its own" / "reached through
    a link or a mounted folder" and stays.
11. **Periodic pass.** check_interval_hours = 1. Restart the extension: about 5 minutes later, one
    event log line `watched and done with: N item(s), ...`. With clean_automatically OFF nothing
    is moved. With it ON, the next pass moves (same gates and caps) and logs "automatic clean".
12. **Wrong password.** Set a wrong password. `/cleanup list` fails with "refused this user name
    and password", and a second `/cleanup list` does NOT try to sign in again (check the media
    server log: one failed sign-in, not one per command). Correct it and the list works.
13. **Media server off.** Disable the media server: `/cleanup list` answers "Failed: The media
    server is not running" and the extension stays up.
14. **Kill safety.** During a long `/cleanup run` (many items), kill the extension process.
    Restart it: the items already moved are in the Recycle Bin, the others are untouched, and the
    next `/cleanup list` lists the rest.

## Things only a live run can show (untested offline)

- That item ids from `/Items/{id}/Ancestors` match the share's directory ids for real paths,
  including non-ASCII names. (The core lower-cases with Text::toLower on both sides, so they
  should.)
- That `share/refresh/paths` makes the media library drop the moved items.
- That the extension settings UI accepts the struct list "Other accounts" with a password field.
- How long the Recycle Bin check takes on a full Recycle Bin (it lists the bin once per moved path).

## Results 2026-10-19 (extrig rig: FulDC++ 1.1123, media server 48197)

Accounts counted: `qa` (main) and `gaps`; the server also has `keepup` (not listed). Settings:
watched_days 1 (0 is refused by the client), added_days 0, keep_last_episodes 0. LastPlayed was
moved back 40 days in `MediaServerPlayback.xml` with the client stopped. Library under `c1lib\WC`:
Done.Film (both watched), Half.Film (only qa; its folder also holds another release's RAR5 set),
Fav.Film (both, favourite of gaps), Some.Show S01E01 (both) and S01E02 (gaps half way, 2 of 7 min).

| Scenario | Result |
| --- | --- |
| `/cleanup list` | PASS: names only Done Film (2015), 3 MiB, as its folder; no file changed (size + mtime snapshot of every file); "Not counted: keepup" |
| Run with keepup not counted | PASS: "Not cleaning: the media server also has keepup", nothing moved |
| Run with a wrong password for gaps | FAIL first: the film was moved with the token saved earlier (REVIEW L1). After the fix PASS: "Failed: Account gaps: ... 401", nothing moved |
| `/cleanup run` (Done Film) | PASS: the folder is in `C:\$Recycle.Bin` (Shell namespace 10, original location `...\WC\Films`, mp4 + nfo inside); dropped from the share, and from the library about a minute later |
| Folder with another release's RAR set (Half Film, after gaps watched it) | PASS: only the mp4 and its .nfo went to the bin; the folder and `other.release.part1-3.rar` stayed (share size 300516 = the RAR set) |
| Favourite, one account only, episode in progress | PASS: never offered (report: "a favourite", "not watched by every account", "series in progress") |
