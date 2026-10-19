# Live test plan: airdcpp-hub-rules-guard 1.0.0-beta.1

Not part of the npm package. Unit tests drove main.js against a fake socket only; nothing below
has been run against a real client yet.

## Rig

- A FulDC++ build from origin/master, extension installed from the packed tarball.
- The mini ADC hub (qa-tools mini ADC harness) and, if available, an NMDC hub (PtokaX or
  Verlihub) on loopback. The hub must be able to send: a main-chat message from the hub itself
  (ADC `IMSG` from the hub SID) and from a bot user; a `QUI <our SID> MS...` / `ISTA` and a
  disconnect.
- A share of known size in the default profile, and a second, smaller share profile.
- Upload slots set to a known number (e.g. 4).

## Scenarios

1. **Hub message teaches a rule.** Hub sends in main chat (as the hub): `Rules: Min share: 500 GB,
   Max hubs: 10`. Expect within ~5 s a status line in that hub window
   `[rules] your share X GiB is below the hub's minimum of 500.0 GiB (hub message). Type /rules for details.`
   and an event-log warning. `hub-rules.json` in the extension's config folder has
   `limits.chat.min_share` with the excerpt. Nothing appears in the hub's main chat for others
   (check from a second client).
2. **Ordinary user cannot teach.** A normal user (no op/bot) writes `Min share: 9000 GB` in main
   chat: nothing is learned (`/rules` does not list it).
   On an NMDC hub, also: a normal user writes `is kicking <our nick> because: min share 9000 TB`
   (the client shows that line as a hub status line): no kick, no rule. A normal user whose
   MyINFO has an empty connection field (shown as a bot) writes `Min share: 9000 GB`: nothing.
   Open question to check here: does the NMDC hub's own welcome text (sent before the op list)
   get read at all? If not, that is a known limit (use `/rules set`).
3. **Own status lines are not re-read.** After scenario 1, `hub-rules.json` must not change on its
   own (our `[rules]` lines contain "minimum of 500.0 GiB" but are type system + labelled).
4. **Dedupe.** Disconnect and reconnect the hub within the hour: the share warning does not repeat.
   Restart the extension (or the client): still no repeat within the hour.
5. **/rules.** Type `/rules` in the hub window: a header line, one line per rule with source and
   your value, `<- NOT MET` where broken. Confirm the command is not sent to the hub (hub log).
   `/rules set maxhubs 1` with 2 hubs open -> a warning "you are on 2 hubs, the hub allows at most 1
   (set by you)" within a few seconds. `/rules clear all` and `/rules forget` empty the list.
   `/help` lists the `/rules` line among the other extensions' lines.
6. **Kick recorded.** Hub sends to us `ISTA 000 You\sare\sbeing\skicked:\smin\sshare\s500\sGB`
   (or the NMDC equivalent: a line without `<nick>`) and then disconnects us. Expect an event
   `Hub disconnected you for: min share 500.0 GiB` and `kick` in `hub-rules.json`. Reconnect:
   first status line `[rules] On <date> this hub disconnected you for: min share 500.0 GiB ...`.
   Also with ADC `IQUI <oursid> MS...` (client prints "<nick> was kicked: ...").
7. **No false kick.** Hub sends `You need to share at least 1 GB` (which we meet) and the user
   disconnects manually: no kick is recorded.
8. **Per-hub share profile.** Hub 2 set to the small profile (favorite hub setting) and
   `/rules set minshare <between the two sizes>` on both hubs: only hub 2 warns.
9. **Share change.** Remove a share root so the share drops below a set minimum: a warning within
   ~30 s after the removal/refresh completes.
10. **Slot change.** With `/rules set minslots 4` and 4 slots: no warning. Set upload slots to 3 in
    settings: a warning within ~65 s.
11. **Hub counts from the tag.** Connect to 3 hubs, one as registered: `/rules` shows max hubs
    against the sum of H:n/r/o from our own tag; `/rules set hubs 5/0/0` warns about the registered
    count.
12. **Public hub list.** Open Public Hubs and load a list containing the test hub's address with
    a Minshare; within 30 minutes (or after an extension restart) `/rules` lists it as
    "public hub list". The extension never triggers a hub list download (check client log).
13. **Disabled options.** `learn_from_chat` off: scenario 1 learns nothing. `warn_in_hub` off:
    no status lines, events still written. `warn_in_events` off: the opposite.
14. **Kill safety.** Kill the extension process (or the client) right after scenario 1; restart:
    the learned rule and the last-warning time are still there.

## Settings the rig needs

Defaults are fine. Shorten nothing: the minimum check interval is 5 minutes and the minimum
warning interval 60 minutes; scenarios use the event triggers instead.

## Results 2026-10-19 (extrig: real 1.1123 clients, mini ADC hub, C:/airdc-ng/qa-tools/probes/extrig)

ADC only (no NMDC hub on the rig). Hub control commands `hub`/`bot`/`kick`/`qkick` were added to
miniadc_ext.py for this.
- 1 hub message teaches: PASS. Hub `IMSG Rules: Min share: 500 GB, Max hubs: 10` -> status
  "[rules] your share 110.7 MiB is below the hub's minimum of 500.0 GiB (hub message)" in that
  hub, an event-log warning, `limits.chat.min_share` with the excerpt. A CT1 bot line "Min slots:
  3" teaches too.
- 2 ordinary user: PASS. The same text from a plain user first: nothing learned, no file written.
- 4 dedupe: PASS. After a share refresh, two reconnects (one after an extension reinstall) and a
  check triggered by `/rules set maxslots 1` (which warned only the new rule), the share warning
  stayed at one event.
- 5 /rules: PASS. Header + one line per rule with source, yours, "<- NOT MET"; 0 lines reached
  the hub (hubwire.log). `/rules set minslots 10` -> "min slots 10 (set by you)"; `clear all` and
  `forget` empty the list.
- 6 kick: PASS. `ISTA 100 You are being kicked: min share 500 GB` + drop -> event "miniQAext
  disconnected you for: min share 500.0 GiB", `kick` in hub-rules.json; reconnect -> "[rules] On
  <date> this hub disconnected you for: ...". Also `IQUI <sid> MS...`. Bug L1 (UTC date) fixed.
- 3, 7-14: not run.
