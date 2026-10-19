# Live test plan: airdcpp-release-unpacker 1.0.0-beta.1

Not part of the npm package. For the coordinator, one scenario at a time.

## Rig

- A FulDC++ build from origin/master with the media server enabled and one library folder that
  is inside a share root (the release folders below go there).
- The two-client download rig (qa-two-client-download-rig) for the automatic path: client B
  shares the release folders, client A downloads them as folder bundles.
- Test sets: make them from a real, short, playable video (`clip.mkv`, a few MB) with WinRAR's
  `Rar.exe` (6.x for RAR4: `-ma4`; 7.x writes RAR5 only). It was downloaded to
  `%TEMP%\claude\...\scratchpad\winrar-dl\x\Rar.exe` (7.13) and `x624\Rar.exe` (6.24),
  extracted from the signed rarlab installers without running them.

```
Rar.exe a -ep -ma5 -m3 -v2m  Compressed.Rel-GRP\rel.rar        clip.mkv      (RAR5, partN, compressed)
Rar.exe a -ep -ma4 -m3 -v2m -vn Old.Names.Rel-GRP\rel.rar      clip.mkv      (RAR4, .r00, compressed; Rar 6.x)
Rar.exe a -ep -ma5 -m0 -v2m  Stored.Rel-GRP\rel.rar            clip.mkv      (stored: media server plays it)
Rar.exe a -ep -ma5 -m3 -psecret Locked.Rel-GRP\rel.rar         clip.mkv      (password)
7z a Zip.Rel-GRP\rel.zip clip.mkv
```

Install the tarball (`npm pack` in the extension folder) through the client's extension page.
Default settings unless a scenario says otherwise.

## Scenarios

1. **Automatic, compressed RAR5** (two-client rig). A downloads `Compressed.Rel-GRP`.
   Expected: about 30 s after the bundle shows completed/shared, the event log has
   `airdcpp-release-unpacker: unpacked Compressed.Rel-GRP: rel.part1.rar, 1 file(s), ...`;
   `clip.mkv` is in the folder, byte-identical to the original (compare a hash); all
   `rel.partN.rar` still there; no `.unpacking-*` folder left; the share refresh ran
   (event log / share refresh task). Within a library rebuild the film shows up in a Jellyfin
   client and plays.
2. **RAR4 old names**, same as 1 with `Old.Names.Rel-GRP`. Expected the same.
3. **Stored set**: `Stored.Rel-GRP` downloads; nothing is unpacked and NO event-log line
   (extension log only). Then right-click the bundle in the queue -> **Unpack release**:
   event log says "the media server already plays it as it is (stored)".
4. **Password**: `Locked.Rel-GRP` -> warning "not unpacked, it is password protected"; nothing
   written.
5. **ZIP**: `Zip.Rel-GRP` -> unpacked.
6. **Menu in own share**: Browse own share, right-click a folder holding a compressed set that is
   not in the queue -> **Unpack release** -> unpacked; the item must NOT appear on another user's
   file list. Check the menu opens instantly (no delay from the hook).
7. **Chat**: in a hub window type `/unpack <full path of a release folder>` -> status line
   `[unpack] queued ...` only in your window (nothing sent to the hub); `/unpack` -> status.
   `/unpack relative` -> `[unpack] give the full path ...`.
8. **Never overwrite**: put a file named `clip.mkv` with different content into a compressed
   release folder first, then `/unpack` it -> warning "1 file(s) existed already and were left
   alone: clip.mkv"; your file unchanged. (When EVERY file of the set exists, as with a one-file
   set, it is "rel.part1.rar not unpacked, every file exists already (clip.mkv)" instead; seen live.)
9. **Kill in the middle** (needs a big set, e.g. a 2-4 GB clip packed with -m3): start an unpack,
   watch `.unpacking-<n>-1` appear (hidden), then disable/enable the extension (the client kills
   it). Expected: on the restart the `.unpacking-*` folder disappears and the release is
   unpacked again from the start; the event log has one "unpacked" line; the state file
   `unpack-state.json` in the extension's settings folder ends with `"active": null`.
10. **Free space**: set "keep at least this much free space" to a value larger than the drive's
    free space -> warning "not enough free space"; nothing created.
11. **Delete archives ON** (fixed local drive): unpack a compressed release that is a finished
    queue bundle -> the bundle disappears from the queue (files stay), the `rel.*` volumes are in
    the Recycle Bin, `.nfo`/`.sfv` stay, event "N archive volume(s) moved to the Recycle Bin".
    Check no window flashed or stayed open (PowerShell runs hidden). Then the same on a network
    drive or USB stick: archives kept, warning "no Recycle Bin on this drive" / "network path".
11b. **Delete archives ON, download back in the queue**: start an unpack of a big compressed
    finished bundle, and while it runs download one more file into the same folder from client B
    (the bundle goes back to queued). Expected: unpacked, then warning "archives kept, it is still
    downloading"; the bundle stays in the queue and its new file keeps downloading (its .dctmp is
    not deleted).
12. **Catch-up**: disable the extension, let a compressed release finish downloading, enable it
    -> it is unpacked. On a FIRST install (fresh settings folder) old finished bundles in the
    queue are not touched.
13. **Memory**: during a big unpack (scenario 9 set) the extension's node process stays under
    ~150 MB working set (measured offline: 5 GiB entry, ~100 MB RSS peak).

## Verified offline (no client)

- All decoders on real fixture archives in worker threads (tests/engine.test.js).
- The bundled `dist/main.js` used as the worker with `dist/vendor` (RAR4, RAR5, ZIP, 7z,
  encrypted, header-encrypted, missing volume).
- 5 GiB single entries: RAR5 compressed (fastest), RAR5 stored single-volume archive with a file
  after the 5 GiB entry (offsets past 4 GiB), 7z LZMA2 and ZIP64 deflate: all unpacked
  correctly, peak RSS 48-100 MB.
- Recycle Bin helper on a fixed drive (file went to the bin) and refusal of a UNC path.

## Not verified offline

- The client's real menu hook payloads (`selected_ids`, `entity_id`) and the hook timeout.
- `share/refresh/paths` and `share/find_dupe_paths` answers from a real client.
- That the media server lists the unpacked film after the refresh.
- Real ENOSPC during an unpack (disk filled by something else meanwhile).
