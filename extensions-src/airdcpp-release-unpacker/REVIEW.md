# Independent review: airdcpp-release-unpacker 1.0.0-beta.1 (2026-10-18)

Not part of the npm package. Core claims checked against `origin/master` of airdcpp-windows.

## Findings

### 1. BLOCKER - removing archives trusted a stale bundle status; removing a re-queued bundle deletes partial downloads (fixed)
`src/main.js` removeArchives (was :617-644). For a job with a `bundleId` (automatic, or menu on a
queue item) the bundle was removed with `queue/bundles/{id}/remove` without reading its status
again; the status was checked only when the job was queued, minutes earlier. A finished bundle
goes back to QUEUED when more files are added to its folder (or to RECHECK, which sits below
DOWNLOADED: Bundle.h:50-58 on master). `QueueManager::removeBundle` (QueueManager.cpp:4826-4870 on
master) then deletes the `.dctmp` temp files of every queued item even with
`remove_finished:false`, and drops them from the queue: the user's in-progress download is lost.
Also: a folder inside a bigger bundle (`/unpack D:\Dl\Pack\Rel`) matched no bundle by exact
target, so its volumes were recycled while the parent download was still running.
Fix: the queue is read again right before; every bundle whose target is the folder, inside it or
around it must be `downloaded` and not `recheck`, otherwise archives are kept; each such bundle is
taken out of the queue before recycling.
Tests (fail on the old code): "removing archives: a download that went back to downloading ...",
"... a recheck running on the download keeps them", "removing archives of a folder inside a
bigger download ...".

### 2. SHOULD-FIX - no time limit on decoder threads (fixed)
`src/runner.js` run(). A WASM decoder that loops on a malformed archive never posts a result; the
one-at-a-time queue stalled until the extension was restarted, and then the same release ran
first again (three restarts before it is given up). Fix: per-run timeout (list 10 min; extract
15 min + 2 MiB/s of output), thread terminated, set reported, queue continues.
Tests: "runner: a thread that never finishes is ended at its timeout ...", "a decoder that never
finishes is ended at the timeout; the queue goes on" (both hung on the old code).

### 3. SHOULD-FIX - a worker thread that died on its own aborted the whole release (fixed)
`src/runner.js` exit handler gave reason `stopped` for every exit; `unpackGroup` rethrows
`stopped`, so one crashing set (OOM, decoder abort) skipped every other set of the release.
Fix: `stopped` only after `stopAll()`, else `failed`.
Tests: "runner: a thread that dies on its own fails as \"failed\" ...", "a decoder thread that dies
on its own fails that set only ...".

### 4. NIT - disk full during a ZIP/7z unpack reported as "7-Zip failed" (fixed)
Verified by running 7z-wasm with `fs.writeSync` throwing ENOSPC: 7-Zip prints only a C++
exception pointer number. Nothing is lost (temp folder removed), but the message is wrong. Fix:
`run7z` records the fs write error code. Tests: "zip/sevenzip: a full disk while unpacking is
reported as a full disk" (rar4 variant was already right; kept as a guard).

### 5. BLOCKER - "move to the Recycle Bin" deleted for good on a SUBST drive (fixed; coordinator follow-up)
`src/recycle.js` checked only network path + DriveType Fixed. A SUBST letter reports Fixed but has
no volume of its own: the shell deleted the file outright (reproduced in airdcpp-watched-cleanup;
here the old helper answered ok:true for the SUBST file). A path through a junction / mounted
folder was judged by the wrong drive's bin, and NoRecycleFiles / NukeOnDelete were never read.
Fix (approach copied from airdcpp-watched-cleanup/src/recycle.js): refuse a letter with no
Win32_Volume, any reparse point on the path or the file itself, the NoRecycleFiles policy (HKCU,
HKLM), NukeOnDelete for the volume, and a file over 90% of the bin's MaxCapacity (default 5%).
Refused = archives kept and reported. Tests (tests/recycle.test.js, Windows, real temp SUBST
letter and junction, both removed afterwards): SUBST and junction cases fail on the old code;
a plain file still recycles; policy/NukeOnDelete/size checks asserted in the script text only
(a policy cannot be set from a test).

## Checked, no bug found (with evidence)
- **Path traversal / symlinks, 7z-wasm NODEFS scope**: ran crafted zips through the engine:
  `..\..\..\x` (FAT and unix host), `C:..\..\x`, symlink `lnk -> ../../..` + `lnk/x`, and an
  absolute symlink to `/src`. 7-Zip 24.09 strips the `..` parts; symlink and drive-letter sets fail
  as a whole; nothing appeared outside the output folder or in the release folder. Only `/src`
  (the release folder) and `/out` (a fresh subfolder of the temp folder) are mounted; `..` past a
  mount resolves in Emscripten's in-memory root, not on disk. Two of these zips are now regression
  tests (tests/fixtures/evil-*). RAR names go through `outputPathOf` (both separators split,
  checked prefix) and files open with `wx`.
- **Hard-link commit**: the temp folder is always inside the output folder, so link and rename
  stay on one volume even with a target folder on another drive. Where links fail (FAT/exFAT/some
  SMB) it falls back to exists-check + rename (a race window only, documented). New test forces
  `linkSync` to fail with EPERM: files still committed, an existing file still untouched.
- **Crash recovery**: only folders recorded in the state file before creation AND named
  `.unpacking-<this job id>-<n>` are removed; `rmSync` unlinks links without following them.
- **Bundle still downloading / rechecking unpacked**: automatic path needs `status.completed`
  (>= COMPLETED, Bundle.cpp:134) at the event and again after the settle wait; RECHECK is below it.
  `queue_bundle_status` sends the full item (QueueApi.cpp:877). Incomplete files are `.dctmp`, so a
  manual unpack of a running folder fails on the missing volume before anything is committed.
- Routes used exist on master: queue bundles get/list/remove (QueueApi.cpp:85-99),
  `filesystem/disk_info` free_space (FilesystemApi.cpp:40,130), `share/refresh/paths`,
  `share/find_dupe_paths` (ShareApi.cpp:81,94), `system/system_info` cid (SystemApi.cpp:169).

## Not verified
- A real full disk, a real hang of a decoder, symlink creation on a machine with Developer Mode
  (here `symlink()` failed with EPERM, so 7-Zip's own dangerous-link check was not exercised).

## Live test 2026-10-18 (two real 1.1123 clients, rig qa-tools\probes\extrig)

### 6. SHOULD-FIX - a quiet skip left no line anywhere (fixed)
`src/main.js` processJob `say()`: an automatic skip marked quiet (stored set, no media, excluded)
went to `socket.logger.verbose`, which the extension logger drops unless the extension runs with
`--debug`; output.log stayed empty while README promises "only the extension log". Seen live:
the automatic `Stored.Test.Film...` download produced no line at all. Fix: `logger.info` (output.log,
still no event-log line). Test "a quiet skip of an automatic unpack is still written to the
extension log ..." (fails on the old code: empty log). Re-verified live after reinstalling.

### Nit, not changed - event order with "remove archives" on
`removeArchives` runs before the report loop, so the event log shows "N archive volume(s) moved
to the Recycle Bin" before "unpacked ...". On disk the order is right (film committed, bundle out
of the queue, then the volumes recycled; measured with a 300 ms poll).
