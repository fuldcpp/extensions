# airdcpp-release-unpacker

Unpacks finished RAR, ZIP and 7z releases so the media server can play them.

The built-in media server plays a RAR set only when the film inside is **stored** (packed without
compression). A compressed release downloads fine but never shows up in Jellyfin clients. This
extension unpacks it next to the archives (or into a folder you choose) and then asks the client
to refresh that folder in the share, so the media server picks the film up.

## When it unpacks

- **Automatically**, when a folder download finishes: after the client has completed it and its
  checks are done (status completed or shared; a download that failed its checks is left alone).
  It waits 30 seconds first, so sharing and release checkers finish.
- **By hand**:
  - right-click a download in the queue: **Unpack release**
  - right-click a folder in your own share's file list (Browse own share): **Unpack release**
  - type `/unpack D:\Downloads\Some.Release` in any hub or private chat. `/unpack` alone shows
    what is unpacking and what is waiting. Answers appear only in your own window.

Downloads that finished while the extension was not running are picked up when it starts again,
but **not** on the first start after installing: it does not unpack every finished download still
in your queue.

## What it unpacks

- RAR sets: `name.rar` + `name.r00`, `name.r01`, ... (old names), `name.part1.rar`,
  `name.part2.rar`, ... (new names), single `.rar` files, RAR4 and RAR5.
- ZIP (also split `.z01` + `.zip`) and 7z (also split `.7z.001`).
- The release folder and the folders directly in it (`CD1`, `CD2`, `Subs`).
- Not, by default: `Sample` folders (setting). Never: `Proof` folders.
- Archives inside archives, one level deep (old releases are often zips each holding one RAR
  volume): the inner archives are unpacked in the temporary folder; only their contents reach
  the release (setting, on by default).

It **skips, and says so in the event log**:

- **password-protected** archives,
- sets with **volumes missing** (gaps in the numbering, or a volume the `.sfv` lists that is not
  there),
- sets that need **more free space** than the drive has (the size of everything inside plus a
  margin, 2 GiB by default),
- archives with file names that cannot be created safely.

It skips **quietly** (only the extension log; said in the event log when you asked by hand):

- sets the media server **already plays** (the largest video inside is stored). Turn on
  "also unpack sets the media server already plays" if you want them anyway; the film then exists
  twice and takes twice the space.
- sets without video, audio or subtitles inside (programs, games, ebooks), unless you turn
  "only unpack sets that hold video, audio or subtitles" off,
- folders matching your exclude patterns (`*` and `?`, matched against the folder name and the
  full path).

## How it writes

1. One release at a time. The queue is kept in `unpack-state.json` in the extension's settings
   folder, so a restart continues where it stopped.
2. Files are unpacked into a hidden temporary folder `.unpacking-<number>` beside where they go.
3. Every file is checked: its size, and its CRC-32 against the archive (for RAR volume sets the
   unRAR library checks the CRC of every file itself and refuses a damaged one).
4. Only then is each file moved to its real name. **An existing file is never replaced**: it is
   left alone and the event log lists it.
5. The temporary folder is removed. If the client stops the extension in the middle (it simply
   ends it), the next start removes the temporary folders of that run (only folders it recorded
   itself, before creating them) and unpacks that release again. A release that was interrupted
   three times is given up and reported, so one bad archive cannot block the queue.
6. The client is asked to refresh the folder in the share.

One line per unpacked set goes to the event log (and every skip or failure that needs your
attention).

## Removing the archives (off by default)

With "move the archive volumes to the Recycle Bin after a complete, verified unpack" on:

- only the volumes of a set **every** file of which was unpacked, verified and moved into place
  (a set with one file left alone keeps all its archives),
- only those volumes: never the `.nfo`, `.sfv`, samples or anything else,
- to the **Recycle Bin**, only where Windows really has one for that file. Wherever "move to
  the Recycle Bin" would delete for good instead, the archives are kept and the event log says
  why: a network or removable drive, a SUBST drive letter, a folder reached through a junction,
  a link or a mounted folder, the Recycle Bin switched off (for that drive, or by a policy on
  the computer), or a volume larger than that drive's Recycle Bin.
- the download is taken out of the queue first (its files stay), because the client cannot load
  a finished download whose files are gone. The queue is read again at that moment: if the
  download is not finished any more (files were added to its folder, or it is being rechecked),
  or the release is part of a bigger download that is still running, the archives are kept and
  nothing is taken out of the queue.

## What it never does

- It never overwrites or deletes a file it did not create, except the archive volumes above when
  you turn that on (and then only to the Recycle Bin).
- It never unpacks a download that failed its checks, a single-file download, or a whole drive.
- It never sends anything to hubs or other users.
- It never waits inside the client: it listens to events. The two menu items are offered through
  the client's menu hook, answered at once from memory.

## Notes

- Unpacking uses one CPU core and reads and writes the whole release once; a big release takes a
  few minutes. It runs in a separate thread, so the extension stays responsive. A thread that
  does not finish in time (10 minutes to read an archive's list; 15 minutes plus about 2 MiB/s
  of output to unpack it) is ended, the set is reported as not unpacked and the queue goes on.
- The decoders are WebAssembly builds shipped inside the extension (no program is installed or
  started for unpacking): the unRAR library (node-unrar-js) for RAR, 7-Zip (7z-wasm) for ZIP and
  7z. Memory stays flat whatever the size of the release (tested with a 5 GiB file).
- If "share hidden files" is on in the client, the temporary folder may be seen by a share
  refresh while it fills.
- If another extension moves the release while it is being unpacked, that unpack fails and is
  reported; nothing is lost.
- Requires Node.js 18 or newer.

## Licence

MIT for this extension. It includes the unRAR library: **its code may not be used to develop a
RAR (WinRAR) compatible archiver** (unRAR licence). 7-Zip is under the GNU LGPL. See LICENSE.
