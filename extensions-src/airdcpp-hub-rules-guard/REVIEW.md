# Independent review: airdcpp-hub-rules-guard 1.0.0-beta.1 (2026-10-18)

Checked against origin/master f163a4989 of airdcpp-windows. Not part of the npm package.

## Findings

### 1. should-fix: on NMDC an ordinary user can teach rules and fake a kick (FIXED)
`src/main.js` onHubStatus / isTrustedSender (original lines 400-416).
- `NmdcHub.cpp` (origin/master ~l.586-594) turns ANY main-chat line `<nick> ...` that contains
  "is kicking" + "because:", or "Hub-Security" + "was kicked by", into a status line of type
  `server` (Client.h:221 default type SERVER). onHubStatus trusted every `server` line, so a user
  writing `is kicking <your nick> because: min share 9000 TB` made `isExplicitKickOf` record a
  kick at once (source `kick`, which outranks hub messages) plus a 9000 TiB minimum. Warnings
  and a "this hub disconnected you" line at every connect for 30 days followed.
- `NmdcHub::applyConnection` flags any NMDC user with an empty connection field as a bot;
  isTrustedSender trusted `bot`, so a crafted MyINFO made an ordinary user a rule teacher.
- Fix: on NMDC, a `<nick>`-prefixed status line is read only from `Hub-Security` or a nick seen
  as an operator in main chat; `bot` counts only on ADC (CT set by the hub); the
  "nick equals hub name" shortcut (spoofable) is gone.
- Test: main.test.js "review: on NMDC an ordinary user cannot pose as the hub or a bot". Failed
  before the fix; sabotaging either half (bracket gate, nmdc bot check) fails it again.

### 2. should-fix: parser false positives (FIXED)
`src/rules.js` patterns. Confirmed by running parseLimits:
- "Max slots per IP: 3" -> max_slots 3 (another rule; warns everyone with 4+ slots).
- "Minimum slots for 10 hubs: 4" -> min_slots 10.
- "Our members share at least 2 TB of films" -> min share 2 TiB.
- "Your info: ... Hubs: 5/2/1" (a common welcome-script line showing your own counts) -> max hubs
  5/2/1, so joining one more hub warns.
- "I use 2 slots per hub myself" (op chat) -> slot ratio 2.
- Fix: no "per" between a rule name and its number; a count followed by hubs/users/per or
  "/<digit>" is not the value; "share at least" needs need/must/have/required before it; the
  slots-per-hub form needs "min"/"at least"/"open"; "Min slots per hub: 2" is read as a ratio; a
  bare "Hubs: x/y/z" is no longer read (README updated). Also now read: "Min slots 3 / Max hubs 10"
  (the count was dropped before).
- Checked fine already: "Users: 1234", "Users: 1234 Share: 1.5 PB", "1,5 TB" (= 1.5 TiB),
  "1.5 TB", "2 TiB", "50 GiB", "Min share: 50" (no unit -> nothing).
- Test: rules.test.js "review: numbers that are not the limit are not learned" (failed before).

### 3. should-fix: a drop or redirect before the first check is recorded as a kick (FIXED)
`src/main.js` onDisconnected/unmetRules. Our values are first measured 20 s after connect;
until then `session.values` is null and every rule in a recent "about us" line counted as unmet.
A welcome text "You need to share at least 20 GB" followed by a network drop or a hub redirect in
those 20 s recorded "disconnected you for: min share 20 GiB" for a user sharing terabytes, shown
at every connect for 30 days. Fix: measure the values at the disconnect when none are known; a
rule named without a number is compared with the limit already known for the hub.
- Test: main.test.js "review: a disconnect before the first check is not a kick for a rule we
  meet" (failed before; fails again with the measurement disabled).

### Checked, no finding
- Nothing can reach the hub: the only POSTs are `events`, `hubs/{id}/status_message` and
  `settings/get`. `ChatController.h:40` routes status_message to `chat->statusMessage` (local),
  payload `{text, severity, type, owner}` matches `Deserializer::deserializeChatStatusMessage`
  (type values system/server/...; owner optional). `/rules` stays local: `Client::sendMessageHooked`
  fires ChatCommand and returns false for any `/` text before `hubMessageHooked`.
- Routes/fields verified: `hubs/{id}/users/{cid}` (HubInfo.cpp:63, nick/tag/upload_slots/
  share_size in OnlineUserUtils.cpp), `share_profiles/{id}` -> `size`, `share/stats` ->
  `total_size`, `hublists/entries` (HublistApi.cpp:49; `getPublicHubs` never downloads),
  `settings/get` key `upload_slots` (CoreSettings.h:144), `system/system_info` -> `cid`, events
  hub_status/hub_message/hub_text_command/hub_updated (connect_state ids connected/
  disconnected/redirect), share and share_roots/share_profiles events.
- Malicious op/bot with absurd values: warnings stay at most one per hub and rule per hour (plus
  one near->below escalation), persisted across restarts; values above 10 PiB are dropped. An op
  can still set a large-but-plausible value; `/rules set` overrides it, `learn_from_chat` off
  stops it. Accepted.
- State: tmp + rename on every change, bounded at 300 hubs, excerpts 200 chars; timers unref'd;
  checks serialised; no secrets handled.

### Nits (not fixed)
- "Min share: 1.500 GB" (dot as thousands separator) reads 1.5 GiB: lenient side, no false alarm.
  "1,500 GB" reads 1500 GiB (English convention).
- Casual op chat with a clear rule phrase ("my max hubs is 5") is still learned; inherent to
  reading operators. Per-class values sent as separate messages: the last one wins.

## Live test 2026-10-19 (1.1123 rig, mini ADC hub)

### L1. should-fix: kick and /rules dates were UTC, unlabelled (FIXED)
`src/evaluate.js` formatDate used `toISOString()`. Live: kicked at 23:54 local (UTC+2), the
reconnect notice read "On 2026-10-18 21:54 this hub disconnected you". Fix: local time, as the
client's own timestamps. Test: evaluate.test "live test: dates in status lines are local time,
not UTC" (failed before: actual '2026-10-18 21:54', expected '2026-10-19 06:54' with
TZ=Asia/Tokyo); the existing /rules report test now pins TZ=UTC. Re-run live: "On 2026-10-18
23:57 ...".
