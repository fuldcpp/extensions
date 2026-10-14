# airdcpp-release-fixxer 1.3.5 (FulDC++ build of upstream 1.3.4)

The FulDC++ catalog carries `airdcpp-release-fixxer` (by ShareFixxers, MIT). Upstream 1.3.4
can download unrelated content into a user's share and delete files with no user action. This
folder holds the fix we ship as 1.3.5:

- `airdcpp-release-fixxer-1.3.4-to-1.3.5.patch`: the full diff against upstream commit
  `bb8b6a4` ("Release 1.3.4"), including the tests
- `commits.txt`: the commits in our work clone

Building upstream 1.3.4 from its repository reproduces the shipped `dist/main.js` byte for byte,
so the package differs from upstream only by this patch.

**Version 1.3.5** is a stable number on purpose: the client never updates a stable install to a
prerelease, so a `-rc` would not reach anyone on 1.3.4. `scripts/sync-npm.ps1` knows the package
is patched (`"patched"` in its `meta.json`):
- an upstream release with the same number is reported as a conflict
- a newer upstream release replaces ours only with `-ReplacePatched`, after checking that it
  fixes the problems below

## Problems in 1.3.4, verified in its source and live

Live: two real FulDC++ clients on a test hub, upstream 1.3.4 first, then this build, on the same
content.

1. **Unrelated content downloaded into the share.**
   - The new-share-folder check (on by default) started a hub search for any folder it flagged as
     "SFV possibly missing", for example any personal mp3 folder.
   - It then downloaded the first search result into that folder under its name when no result
     matched exactly.
   - Live: a personal "Holiday 2019" folder received another user's "Holiday 2019 Mix" files.
2. **Files deleted by default.**
   - Every file the client hashes against an SFV (the whole share, not only downloads) was
     deleted on a CRC mismatch, for example a retagged mp3 or a stale SFV.
   - This happened even in releases accepted with `/rvalidator accept` (live: deleted).
3. **Every `.sfv` in a folder deleted** when the extension's parser could not read one.
4. **Subfolders and share roots searched by their bare name** ("CD1", "Sample"), which matches
   anyone's folder of that name.
5. **Partial downloads (`.dctmp`) deleted** once older than 2 minutes, so paused downloads lost
   their progress (live: deleted).
6. **"Accept" did not protect** subfolders, CRC handling or pending retries. Start-up cleanup
   wiped acceptances on drives that were not mounted yet.
7. **No limit on automatic hub searches.** Clients also ignore a user's searches that come too
   close together, so bursts are wasted.
8. **Unguarded async code.**
   - A hook that throws sends no answer, so the client waits 60-120 s and then lets the item
     through anyway.
   - Start-up and command errors were uncaught.
   - Hook settings needed a restart.
9. **The queue right-click menu made one API request per selected download** while the native
   GUI waits for it on its UI thread. Live with 300 selected: about 190 ms; this build about
   20 ms.

## What 1.3.5 does instead

- **Redownloads need proof and an exact name.**
  - Only an SFV that lists a missing file or failed a CRC, or an SFV that is unreadable, starts
    one, and only in a real release folder.
  - Only a search result with exactly the folder's name is downloaded.
  - At most 30 searches per hour.
- **Nothing is deleted.**
  - Failed files and unreadable SFVs move into a quarantine folder in the extension's settings
    folder (outside the share), with a note of where they came from, kept 30 days.
  - At most 20 per hour; accepted releases are left alone.
- **`.dctmp` partial files are never touched** and not reported as extra files.
- **Accept** covers subfolders and cancels pending searches; the list is saved atomically.
- **Errors are caught:** hooks always answer, and start-up and command errors are caught.
- **Hook settings apply live;** the menu filter answers from memory.
- **SFV reading:** UTF-16 and ANSI (Windows-1252), `;` inside names, hexadecimal CRCs.
- **Scanning:**
  - junctions are not followed
  - symlinked files count as present
  - Thumbs.db/desktop.ini are not extra files
  - lower-case scene names count as releases
- **Setting and menu texts** say what actually happens.

Live with 1.3.5, on the same content as the 1.3.4 run:
- the personal folder was left alone (no search at all)
- the accepted release and the partial download were kept
- the corrupted file was quarantined, the release was re-queued from an exact-name source, the
  missing file downloaded and the folder shared, with the file byte-identical to the good copy

Tests: 45 jest tests (in the patch, under `tests/`), and the behaviour tests fail on unpatched
1.3.4. A symlinked-file test could not create symlinks on the test machine and was not exercised.
