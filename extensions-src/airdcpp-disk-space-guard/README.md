# airdcpp-disk-space-guard

Pauses downloads before a drive fills up, and resumes them once there is room again.

The client on its own only stops a download when the disk is already too full for it. This
extension lets you keep a reserve: with the default settings, every unfinished download whose
target is on a drive with less than **10 GiB** free is paused. It resumes once that drive has
**12 GiB** free again (limit + margin, so downloads do not flap around the limit).

## How it behaves

- Checks the queue every 60 seconds (configurable), and at once when you change a setting.
- Looks at the drive of each download's target folder. Unfinished parts are written next to the
  target, so that is the drive that fills up.
- Pauses with a **forced pause**, which also stops transfers that are already running.
- Remembers which downloads **it** paused, and the priority each one had, in
  `paused-bundles.json` in its settings folder. On resume each one gets its old priority back,
  including auto priority. The record survives restarts.
- Leaves alone:
  - downloads you paused yourself (with a forced pause) before the guard did
  - finished downloads
  - downloads in an error state or being rechecked. The client handles those itself; the guard
    picks them up again afterwards.
- **Taking over:** give a paused download any explicit priority (Normal, High, ...) and the guard
  stops managing it. It does not pause that download again until its drive has been back above
  the limit plus margin, so it can finish even while space is short. Switching it to *auto* does
  not count, because the client itself uses auto when it resumes a download after an error.
- Writes each pause and resume to the event log (can be turned off).

## Notes

- If you force-pause a download that the guard has already paused, nothing changes on the
  client's side, so the guard cannot tell. It will resume that download when space returns.
- Everything on a drive resumes together once the drive is above the limit plus margin. With a
  small margin and large downloads, this can pause and resume repeatedly; raise the margin if
  it does.
- If you remove the extension while it holds downloads paused, they stay paused. Resume them
  by hand.
- A drive whose free space cannot be read (an unknown or disconnected network path) is never
  acted on.
- Requires Node.js 18 or newer.

## License

MIT
