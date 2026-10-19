# Changelog

## 1.0.0-beta.1

- First release: unpacks finished RAR (RAR4/RAR5, old and new volume names), ZIP and 7z releases
  so the media server can play them; skips sets it already plays, password-protected sets, sets
  with missing volumes and sets that do not fit on the drive; verifies size and CRC before moving
  files into place; never overwrites; resumes after a restart; "Unpack release" menu item and
  `/unpack` command; optional removal of the archives to the Recycle Bin (off by default).
- Removing the archives (opt-in): the queue is read again right before; a download that went
  back to downloading (files added, a recheck) or a bigger download the release is part of that
  is still running keeps its archives and stays in the queue (removing it would have deleted the
  partial files of its queued downloads).
- A decoder that never finishes is ended after a time limit instead of holding the queue until
  the next restart; a decoder thread that dies fails only that set, not the whole release.
- A full disk while unpacking a ZIP or 7z is reported as a full disk.
- Removing the archives never deletes for good: a SUBST drive letter (Windows deleted the file
  outright there), a path through a junction or mounted folder, the "no Recycle Bin" policy, a
  bin switched off for the drive, and a file larger than the bin are all refused (archives kept).
- A set skipped without a warning (one the media server already plays, one without media, an
  excluded folder) is written to the extension log; it was logged at a level that is never written.
