# airdcpp-season-gaps

Finds the episodes missing from the TV series in your media library, and on request searches
the hubs for exactly those episodes.

The media server built into the client can already show missing episodes on a season page,
one season at a time, for a person who turned on "Display missing episodes". This extension
looks at every series at once. It writes one report, also reports whole seasons you do not have,
and can fill the gaps from the hubs.

## What you need

- The client's **media server** switched on, with your TV folders in the library.
- A **media server account** for the extension to sign in with: its user name and password (or
  an access token) in the extension settings. A separate account just for the extension is best.
  The extension only reads the library.
- Then either or both of:
  - **"Display missing episodes"** turned on for that account (in a Jellyfin app's display
    settings, or with the extension setting that does it for you). The media server then lists
    the missing episodes of every season you have. It gets these lists from TMDB using its own
    key, in the background, so the first check after you turn this on may find fewer gaps than
    the next one.
  - A **TMDB API key** of your own (free at themoviedb.org; a v3 key or a v4 read access token).
    Needed for whole missing seasons, and used for everything when "Display missing episodes"
    is off. Extensions cannot read the media server's own TMDB key.

## How it behaves

- Checks the library once a day (you can change this), three minutes after the client starts if
  a check is due, and when you ask.
- An episode counts as missing when it has **aired** (its air date is more than one day ago) and
  it is not in your library. Episodes without an air date never count.
- A file holding two episodes (S01E01E02) counts for both.
- **Specials (season 0)** are left out unless you turn them on.
- **Whole seasons** you have none of:
  - between two seasons you have: reported (setting, on by default)
  - newer than your last season: reported (setting, on by default). Put a show you stopped
    following on the ignore list.
  - older than your first season: not reported (setting, off by default)
- A season numbered from the start of the show (common for anime: episode 137 in "season 1") is
  left out rather than reported as a hundred missing episodes. So is a show named by dates.
- A series the media server has not matched on TMDB is looked up by name, but only when exactly
  one TMDB show has that exact title.
- TMDB answers are cached in the extension's settings folder: 7 days for a show that has ended,
  1 day for one still running. At most about 4 requests a second.

## The report

- `season-gaps.md` in the extension's settings folder, rewritten after every check.
- A summary line in the event log: "N show(s) with gaps, M aired episode(s) missing".
- Chat commands, typed in any hub or private chat window. The answer appears only in your own
  window; nothing is sent to the hub or the other user.
  - `/gaps`: the summary and the shows with the most gaps
  - `/gaps <show>`: the missing episodes of one show
  - `/gaps check`: check now
  - `/gaps fill <show> [S02]`: search the hubs for the missing episodes of one show, or one season
  - `/gaps stop`: forget the episodes still waiting to be searched for
- In the Extensions window, right-click this extension: **Check for season gaps now**.

## Filling gaps from the hubs

- `/gaps fill <show>` adds the show's missing episodes to a search list. Episodes are searched for
  **one at a time**: at most **20 searches an hour**, **20 seconds apart** (both settings). The
  budget is kept across restarts.
- The search is the show's name, the episode code and your quality word, for example
  `Show Name S02E05 1080p`.
- A result is downloaded **only** if its name is exactly that show and that episode
  (`Show.Name.S02E05...`, or a double episode that includes it). A year in the release name has
  to be the show's year (`Doctor.Who.2005...` is never taken for the 1963 show), and when the
  library calls the show `The Office (US)`, a release named plain `The.Office...` is not taken
  (that is the UK show). It also has to contain the required quality
  word (default `1080p`; leave the setting empty for any) and be a folder or a video file.
  Sample and trailer files are never taken. Neither is a release tagged with another language, a
  dub, burnt-in subtitles or extras (FRENCH, GERMAN.DL, NORDiC, SWESUB, DUBBED, MULTi, HC, EXTRAS,
  SUBPACK...), unless you list that tag in "accepted language tags" (empty by default). Results that are already in your share or queue are
  skipped, and so is an episode whose folder download is still waiting for the source's file list.
  A folder download that fails (source offline) is tried again after 1 hour, then 2, 4 ... up to
  24 hours. When nothing matches, nothing is
  downloaded: there is never a fallback to the top result.
- Among the matches it picks a preferred release group first (setting), then the one with the
  most sources.
- An episode that is already in the download queue is not searched for.
- Downloads go to the client's **normal download folder**. If you use
  **airdcpp-download-sorter**, it files them into your TV folders.
- **Automatic fill is off by default.** When you turn it on, each check adds the missing episodes
  to the search list, at most 20 per check (setting). An episode that was not found is tried again
  after 3 days (setting).

## What it never does

- It never deletes, moves or renames a file.
- It never removes anything from the download queue.
- It never searches the hubs unless you ask with `/gaps fill` or turn on automatic fill, and
  never more often than the search budget allows.
- It never sends anything to a hub's main chat or to another user.
- It never changes a media server account unless you turn on the setting that turns on "Display
  missing episodes" for the extension's own account. That setting changes only that one
  preference; with it on, that account's TV and phone apps also show missing episodes.
- It never writes passwords, tokens or the TMDB key to its log or the event log. The media server
  token it receives is kept in `state.json` in its settings folder.

## Notes

- The settings (including the password, token and TMDB key) are stored in plain text in the
  extension's settings file, like every extension setting.
- The account must be allowed to see your TV folders. A restricted account sees only part of the
  library, and the report covers only that part.
- Matching a release to a show uses the show's name as the media server shows it, plus its TMDB
  name. A release whose name differs (an extra country code, a different spelling, another
  year) is not downloaded; that is deliberate. A show whose library name has no country tag is
  matched by its bare title, so name such a show `Show (US)` in the library if a same-named show
  from another country exists.
- Requires Node.js 18 or newer.

## License

MIT
