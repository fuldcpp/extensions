# airdcpp-keep-up

Keeps the next few episodes of the shows you are watching downloaded, so the next one is there
when you want it.

**It starts in dry-run mode.** It searches the hubs and writes "dry run: would queue X" lines to
the event log, but queues nothing until you turn dry run off. Check its choices first.

## What you need

- The client's built-in media server switched on, with your TV shows in its library.
- A media-server account of this client: its user name and password (or an access token) in the
  extension settings. **Only that account's watching is followed.** The media server keeps
  watched state per signed-in account, and one account (even an administrator) cannot read
  another's, so following several people would need several accounts' passwords; that is not
  supported.
- A free TMDB API key (themoviedb.org), so the extension knows which episodes exist beyond the
  ones you have. Without one it can only use the media server's own "missing episodes" of seasons
  you already have, and only when "Display missing episodes" is switched on for your account in
  the media server's settings.

## How it decides

Every hour (you can change it):

1. Looks at the episodes your account played in the last 14 days. A show you have not watched
   for longer is left alone, so it stops by itself when you stop watching.
2. For each of those shows, takes the furthest episode you have watched (in season and episode
   order, specials left out) and the next 3 episodes after it.
3. Keeps the ones that have **already aired**, are **not in your library**, and are **not already
   in the download queue** (the episode itself, or a pack of its season).
4. Searches the hubs for `Show.Name.S01E05` (plus your quality word, `1080p` by default).
5. Takes a result **only** if its release name is that show (the same title once punctuation,
   case and accents are ignored) and **exactly** that episode. A year in the release name must
   be one of the show's years (from its name in your library, the library's year or TMDB's), so
   `Doctor.Who.2005` is never taken for the 1963 show; with no year known, a release with a year
   is not taken. When the show's name carries a country (`The Office (US)`), the bare title
   (`The.Office`, the UK show) is not taken. No other language, dub or burnt-in subtitles
   (FRENCH, GERMAN.DL, NORDiC, SWESUB, DUBBED, MULTi, HC ... unless you list the tag under
   "Accepted language tags"), no extras, bonus, subpack, sample or trailer releases, no season
   packs, no double episodes, nothing already in your share
   or queue, nothing larger than the per-episode size limit, nothing from a blocked group. The
   top search result is never taken just because it is first. If nothing matches, nothing is
   downloaded and the episode is tried again later (1 h, 2 h, 4 h ... at most once a day).
6. Among the matches it prefers your preferred groups (first is best), then the quality you
   chose, then the release most users have, then the one with the most free slots.
7. Queues it into your download folder (or the folder you set) and writes a line to the event
   log.

## Limits that keep it polite

- At most 20 hub searches an hour (setting) and at least 20 seconds between two searches. The
  count survives a restart.
- At most 10 of its own downloads in the queue at once, and at most 50 GB of them in total
  (settings). Beyond that it waits. Its downloads are recognised by their queue id, so one you
  rename in the queue still counts, and so does a folder download whose file list is still on
  its way. A dry run counts what it would queue against the same limits.
- An episode it queued once is never queued again, even if you remove the download: removing
  it is taken as your answer. The exception: a folder download that fails before it reaches the
  queue (the source went offline while its file list was fetched) is looked for again later.
- A show whose episode numbers in your library do not exist in TMDB (absolute numbering, a
  different episode order) is left alone rather than guessed at.

## What it never does

- It never deletes, moves or renames anything, and never touches the queue except to add.
- It never downloads into a folder or file that already exists in the download folder.
- It never searches for a show by an empty name (a title with no Latin letters is searched by
  its TMDB English name, or not at all).
- It never sends anything to a hub's main chat. `/keepup` answers are local status lines.
- It never writes your password, token or TMDB key to a log or the event log. The media-server
  sign-in token is kept in the extension's own state file.
- It never registers a hook: nothing in the client ever waits for it.

## Commands

Type in any hub or private chat window:

- `/keepup status`: dry run on or off, the last check, the shows being followed, searches used
  this hour, its downloads in the queue, and episodes waiting for a retry.
- `/keepup run`: check now instead of waiting for the next hour.

## Settings

| Setting | Default | |
| :--- | :--- | :--- |
| Dry run | on | Search and log only. |
| Media server user name / password, or access token | (empty) | The account whose watching is followed. |
| Media server address | automatic | Only if the automatic address does not work, e.g. `http://127.0.0.1:8096`. |
| TMDB API key | (empty) | See "What you need". |
| Check every | 60 min | 15 to 1440. |
| Follow shows watched within | 14 days | |
| Episodes ahead | 3 | |
| Preferred quality / only that quality | `1080p` / yes | A word in the release name. |
| Accepted language tags | none | e.g. `MULTi`; a release with any other language tag is skipped. |
| Preferred groups / blocked groups | none | Release group names, the part after the last `-`. |
| Download into | the client's download folder | |
| Searches per hour | 20 | |
| Downloads in the queue at once / their total size | 10 / 50 GB | |
| Largest single episode | 10 GB | |

## Files

In the extension's settings folder: `keep-up-state.json` (sign-in token, search budget, what was
searched and queued; written as it changes, so a forced stop loses nothing) and
`tmdb-cache.json` (TMDB answers, refreshed every 12 hours, pruned after 45 days).
