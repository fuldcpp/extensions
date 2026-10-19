# Changelog

## Unreleased (live test 2026-10-19)

- Fixed: a password changed in the settings (for the main or another counted account) was not
  used while the token saved by the earlier sign-in still worked; a wrong password therefore did
  not stop "/cleanup run". A saved token now belongs to the credentials it was signed in with.

## 1.0.0-beta.1

- First release: reports films and episodes that every counted media server account has watched
  (daily report and event log summary, `/cleanup list`), and on `/cleanup run` moves them to the
  Windows Recycle Bin with their sidecar files or their release folder. Report-only by default.
- A release folder is not moved whole when it also holds another archive set, personal pictures,
  or a full-size video with "sample" in its name; .strm items are left alone.
- Refused instead of moved: files on a SUBST drive letter (Windows deleted those outright), paths
  reached through a junction, link or mounted folder, and computers where a policy switches the
  Recycle Bin off.
