# airdcpp-download-sorter

Moves finished downloads into folders by kind: TV, movies, music, or your own rules.

**It starts in dry-run mode.** It only writes "would move X to Y" lines to the event log until you
turn dry run off, so you can check its choices first.

## Categories

| Kind | Recognised by | Example |
| :--- | :--- | :--- |
| TV | an episode or season marker: `S01E02`, `S01`, `1x05`, `Season 2` | `The.Show.S01E02.1080p.WEB.h264-GRP` |
| Movies | a year plus a video tag (`1080p`, `BluRay`, `WEB-DL`, `x265`, ...) | `Some.Movie.2019.1080p.BluRay.x264-GRP` |
| Music | an audio format (`FLAC`, `MP3`, ...) or the scene pattern `Artist-Title-YEAR-GROUP` | `Artist-Album-WEB-2023-GRP` |

- Set a folder for each kind you want sorted. A kind with no folder is left alone.
- TV can go into a folder per show and season: `TV\The Show\Season 01\The.Show.S01E02...`.
- **Own rules** are checked first, one per line: `pattern => folder`. The pattern is a
  case-insensitive regular expression on the release name. Example:
  `^Formula\.1\. => D:\Sport\F1`.
- Anything that matches nothing stays where it is.

## What it does with a finished download

1. Waits a little after the download completes (60 s by default), so sharing and release
   checkers finish first.
2. Only touches downloads that finished inside the client's download folder (or the folder you
   set). Downloads you sent anywhere else are never moved.
3. Never overwrites. If the destination already exists, it logs a warning and leaves everything
   in place.
4. Checks everything it can while the download is still in the queue: the destination's drive
   must be there, the destination must be a full path, and nothing may sit at the destination
   yet. It never moves a download that already sits under one of its destination folders.
5. Removes the finished download from the queue (its files stay), then moves the folder or file:
   - on the same drive, with a single rename
   - to another drive, by copying into `<name>.sorter-partial`, comparing every file size,
     renaming the copy to its real name, and only then deleting the original. An interrupted
     or failed copy never carries the real name; it is cleaned up and the original stays.
   - If the original cannot be fully deleted after a finished copy (a file still being
     uploaded), the move still counts and the event log lists the files left behind.
6. Moves the hash data of shared files along, so the share does not rehash them. Then it
   refreshes the old and the new folder in the share.
7. If a file is in use (being uploaded), the move waits and tries again, with growing pauses,
   for up to 24 hours. This survives restarts (`pending-moves.json` in the extension's settings
   folder). If it still cannot move it, the files stay where they were and the event log says so.

Downloads that finished while the extension was not running are picked up when it starts.

## Notes

- Once a move has started, the download is no longer in the queue. Its files are always in one
  of the two places, and the event log says which.
- Own-rule folders must be full paths (`D:\Sport\F1` or `\\nas\media\F1`). Relative ones are
  reported and ignored.
- Releases that contain links or junctions are not moved to another drive.
- Hash data only exists for files inside the share. Files moved from outside the share into a
  shared folder are hashed as usual.
- Requires Node.js 18 or newer.

## License

MIT
