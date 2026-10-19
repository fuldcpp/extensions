# airdcpp-quality-upgrader

Looks for better copies of the films and episodes you already have: a higher resolution, or a
PROPER/REPACK of the very release you kept.

**It only reports by default.** Found upgrades go to the event log, to `/upgrade list` and to
`upgrades.md` in the extension's settings folder. Nothing is downloaded, moved or deleted until
you turn on **Replace automatically**.

## What it checks

- **With a media server login** (user name and password, or an access token, of an account on
  the client's own media server): the films and episodes in the media library. The real picture
  size the media server measured beats what the release name says, and the watched state of that
  account follows an upgrade.
- **Without one:** release folders in your share (names like `Some.Movie.2019.720p.BluRay.x264-GRP`
  or `The.Show.S01E02.HDTV.XviD-GRP`). Only names that carry a release group and a quality tag
  count, so personal folders such as `Holiday 2019 1080p` are never touched.

## What counts as an upgrade

A find must be the same title (and year, when the name has one) and the same episode numbers
(`S01E02`, `S01E01E02`, `S02`), exactly. Then it must be strictly better by your settings:

- a higher resolution, up to the highest you allow (1080p by default), or
- a PROPER, REPACK or REAL PROPER of the same release from the same group, or
- (off by default) your preferred codec at the same resolution.

A year or a country tag counts as part of the title: `Doctor.Who.2005` is not `Doctor.Who`, and
`The.Office.US` is not `The.Office`. A find marked with something your copy is not marked with is
never taken: another language or a dub (`FRENCH`, `GERMAN.DL`, `NORDiC`, `MULTi`, `DUBBED`...),
burnt-in subtitles (`HC`), or other content (`EXTRAS`, `Bonus`, `SUBPACK`, `Trailer`, `CAM`, `TS`,
`3D`, a disc or part number).

Sources you did not allow and groups you blocked are never taken. Of several good finds the best
one is picked. If nothing passes, nothing happens: it never takes "the top search result".

## Searching

- One search at a time, for one title, at most 10 per hour for all hubs together and at least
  20 seconds apart (both adjustable; hubs ban floods).
- It works through your collection oldest-checked first and searches the same title again only
  after 7 days. The order survives restarts.
- Results of searches you make yourself in the client are looked at too (switch:
  "Also look at the results of your own other searches"). Nothing is sent to a hub for that; a
  title seen there with a better copy is simply searched for next.

## Replacing automatically (off by default)

Needs a **staging folder** (where upgrades download) and a **holding folder** (where replaced
copies go). The holding folder must not be inside your share.

1. The upgrade is downloaded into the staging folder.
2. When the download is complete, it is taken out of the queue (its files stay) and moved into
   the folder where the old copy is, under its own name. The old copy is still there.
3. With a media server login it waits (up to 2 hours) until the media library lists the new
   copy, so the media server can move everybody's watched state to it by itself.
4. The old copy is moved to `<holding folder>\<release name>` (with `.1`, `.2` added if that
   name is taken). It is never deleted.
5. The folder is refreshed in the share. The old copy's hash data moves along with it. The new
   copy is hashed once more: the client keeps no hash data for a download that finished outside
   the share ("isn't in a shared folder"), which the staging folder usually is.
6. The watched state of your media server account (watched tick and resume point) is copied to
   the new copy if the media server did not carry it already.

It only replaces a copy when it is safe to: exactly one copy of that title, in a release-named
folder (or file) inside a share folder, not a share folder itself, not holding other folders.
Otherwise the find is reported with the reason. At most 3 upgrades download at a time.

Every step is written to `state.json` before and after it happens. If the client is closed in
the middle, the next start carries on where it stopped; a half-finished copy to another drive is
removed and done again; a copy that was complete but whose staging original was not deleted yet
is used, and the leftover in the staging folder is named in the report (not deleted). A file in
use (being uploaded or played) is retried for up to a day; until then both copies are kept.
Nothing is ever overwritten. The old copy is only moved once the new copy is in place beside it.

A finished upgrade removed from the queue by hand ("Remove completed") or by the client's "Remove
finished bundles on exit" is still put in place. One removed before it finished cancels the
upgrade.

Turning **Replace automatically** off pauses upgrades already under way: nothing more is moved
until it is turned on again (a download already in the queue keeps downloading; remove it there
if you do not want it).

The holding folder can be emptied of copies older than N days. **This is off (0) by default**,
and it only ever deletes what this extension put there.

## Chat commands (only you see the answers)

- `/upgrade list` - the latest finds and what happened to them
- `/upgrade status` - inventory size, searches used this hour, whether replacing is on

## What it never does

- never downloads anything while "Replace automatically" is off
- never deletes your files (except the opt-in holding-folder clean-up, off by default)
- never overwrites a file or folder
- never replaces a copy with a different title, year or episode, or with something worse
- never searches more often than the budget allows
- never sends anything to a hub's chat
- never writes passwords or tokens to the logs; the media server token is kept in `state.json`
  in the extension's settings folder

## Limits

- Only folder results are considered (scene releases are folders).
- With a media server login, only the account you entered gets its watched state copied. Other
  accounts keep theirs only when the media server carries it over itself, which happens when the
  new copy is the larger file of the two (it usually is for a higher resolution; a PROPER may not
  be).
- Episodes inside a season pack are checked as the season pack.
- Requires Node.js 18 or newer.

## License

MIT
