# airdcpp-watched-cleanup

Finds films and episodes in the built-in media server that everyone has watched, tells you how
much room they take, and, when you ask, moves them to the Windows Recycle Bin.

By default it only reports. Nothing is moved until you type `/cleanup run`, unless you turn on
automatic cleaning yourself.

## Setting up

1. Turn on the media server in the client and make sure it is running.
2. In this extension's settings, enter a media server account (user name and password, or an
   access token).
3. Watched state belongs to each account. If other people use the media server with their own
   accounts, add them under **Other accounts whose watched state counts**. Something is only
   offered for cleaning once **every** listed account has watched it.

The media server only tells an account what that account itself has watched. Even an
administrator cannot read anyone else's. So the extension signs in as each listed account. If the
server has an account you have not listed (disabled accounts don't count), `/cleanup run` refuses.
`/cleanup list` still works and names the missing accounts. To clean anyway, turn on **Clean even
though the media server has accounts not listed here**.

## Commands

Type these in any hub or private chat window. The answers are shown only to you, never sent to
the hub.

- `/cleanup list` shows what could be moved and how much room it would free on each drive, and
  writes the full report.
- `/cleanup run` works out the list again and shows it, then moves it to the Recycle Bin, up to
  the per-run limits.

## What counts as done with

A film or an episode, when all of these are true:

- every counted account has watched it, and the most recent watch was more than **30 days** ago
- it was added to the library more than **14 days** ago
- no counted account has marked it, its season or its series as a favourite
- nobody is part-way through watching it again
- for an episode: nobody is part-way through any episode of that series, and it is not one of the
  **last watched episode(s)** of the series for any account (the default keeps 1)

All the numbers can be changed. Plain videos that are not recognised as a film or an episode
(home videos, music videos) are never offered.

## What gets moved

- A release folder that holds only that film or episode (plus things like a .nfo, subtitles,
  artwork or a Sample folder) goes to the Recycle Bin as a whole folder.
- Otherwise only the video goes, together with files beside it that share its name and only
  describe it (subtitles, .nfo, artwork). These go only after the video itself has gone.
- A folder is never moved whole when it also holds anything that is not part of the release:
  another video or music, another archive (.rar/.zip set), pictures that are not release artwork
  (posters, fanart, proof scans and the like are fine; your own photos are not), documents, or a
  link to somewhere else. Then only the video and its own sidecars go.
- A film whose folder also holds other videos (other parts, other versions) is left alone, and so
  is a packed (.rar) release that shares its folder with anything else, and a .strm pointer.

## What it never does

- It never deletes anything. Everything goes to the Windows Recycle Bin, so you can restore it
  from there. A file is refused, not deleted, when the Recycle Bin can't take it: on a network
  or removable drive, on a SUBST drive letter, on a path reached through a junction, link or
  mounted folder, on a drive where the Recycle Bin is switched off (or on a computer where a
  policy switches it off), or when the file is bigger than that drive's Recycle Bin. After each move it checks that the item really is in the
  Recycle Bin, and tells you if it isn't.
- It never touches:
  - anything outside the client's shared folders, or outside the media library
  - anything in your **keep forever** folders or **keep forever** collections
  - anything in the download queue
  - recordings (the client manages its own, and recognises them by their names; also set the
    recordings folder in the settings)
  - files that are open in another program
  - files that changed since the share last saw them
- It never moves a shared folder itself, or a folder that contains a keep-forever folder or a
  link to somewhere else.
- It moves at most **50 items or 200 GiB** per run (configurable).

## Reports and logs

- `watched-cleanup-report.md` in the extension's settings folder lists every candidate with its
  path, size on disk, when it was last watched, and the total per drive. It also lists the
  watched items that were left alone, and why.
- Once a day (configurable) the report is rewritten and a one-line summary goes to the event log.
- `cleanup-history.log` in the same folder records every move.
- After a move, the share is refreshed for the folders involved, so the share and the media
  library drop what was moved.

## Notes

- The extension finds each item's real file by matching the media server's ids against the
  share's own ids, one folder at a time. An item it can't match exactly (a disc folder, a
  multi-part film, a folder the share hasn't refreshed yet) is left alone.
- The access token for each account is kept in `state.json` in the extension's settings folder.
  Passwords are kept in plain text in the extension settings file, like other extension settings.
- Requires Windows (for the Recycle Bin) and Node.js 18 or newer.

## License

MIT
