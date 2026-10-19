# airdcpp-hub-rules-guard

Tells you when you break a hub's rules, before the hub kicks you for it.

Hubs set limits: a minimum share, a minimum (or maximum) number of upload slots, a maximum number
of hubs you may be on, sometimes a minimum number of slots per hub. The client on its own only
mentions one of them (the minimum share an NMDC hub sends for searching). Most of the time you
learn the rules when the hub throws you out. This extension collects each hub's limits, compares
them with your own values, and warns you in that hub's window.

## Where the limits come from

For every hub you are connected to, strongest first:

1. **You.** Type `/rules set minshare 50GB` in the hub window (see the commands below).
2. **A kick message.** When a hub disconnects you with a message that names a rule ("min share
   100 GB", "too many hubs"), that is remembered and shown to you the next time you connect.
3. **Hub messages.** The welcome text and messages from the hub itself, its bots and its
   operators are read for clear rules such as "Min share: 50 GB", "Max hubs: 10",
   "Max hubs: 10/5/3", "Min slots: 3", "Slot ratio: 0.5". Only a rule followed by a clear number
   (and a unit, for sizes) is taken. Messages from ordinary users are never read, so nobody in
   main chat can set a rule for you. On NMDC hubs only operators count (the client marks any user
   without a connection type as a bot there), and a kick line in main chat counts only from
   `Hub-Security` or an operator who has written in main chat. When a message lists several
   values for one rule (one per user class), the most lenient one is kept. A bare "Hubs: 5/2/1"
   is not read: in welcome texts it is usually your own hub counts, not a rule.
4. **The public hub list**, if the client already has it loaded (open Public Hubs once). This
   extension never downloads the list itself.

Everything learned is kept per hub address, with where it came from, in `hub-rules.json` in the
extension's settings folder.

## Your values

- **Share:** the size of the share profile that hub uses (a hub may use a different profile than
  your default one).
- **Upload slots** and **hub counts** (normal / registered / operator): as the hub sees them, from
  your own entry in that hub's user list. If that is not available yet, your slot setting and the
  number of connected hubs are used.

## When it checks

When you connect to a hub (after 20 seconds, so the hub's welcome text has arrived), every
15 minutes (configurable), shortly after a share refresh, a share folder is added, changed or
removed, or a share profile changes, and within a minute of changing your upload slots.

## Warnings

- A status line in that hub's window. Only you see it; nothing is sent to the hub.
- An entry in the event log (can be turned off).
- At most one warning per hub and rule per hour (configurable, at least an hour), also across
  restarts. A rule that gets worse (close to the minimum, then below it) warns again at once.
- A second, milder warning when your share is less than 5 % (configurable) above a minimum.

## Commands (type in a hub window)

| Command | What it does |
| --- | --- |
| `/rules` | The rules known for this hub, where each came from, and your value next to it |
| `/rules set minshare 50GB` | Your own limit for this hub. Also: `minslots 3`, `maxslots 20`, `maxhubs 10`, `hubs 10/5/3`, `slotratio 0.5` |
| `/rules clear minshare` / `/rules clear all` | Remove what you set for this hub |
| `/rules forget` | Drop what was learned from this hub (messages, kicks, hub list); keeps what you set |
| `/rules help` | The command list |

The commands are handled locally; they are not sent to the hub.

## What it never does

- It never sends anything to a hub: no chat messages, no commands.
- It never disconnects you, never changes your share, slots or any other setting.
- It never downloads the public hub list.
- It registers no hooks, so nothing in the client ever waits for it.

## Limits

- Hubs phrase their rules in many ways and languages. Only English phrasings with clear numbers
  are read; for anything else, use `/rules set`.
- A hub that counts hubs or slots differently from your tag (some count only normal hubs) may
  still disagree with the warning.
- A kick is recognised from a message that names a rule and is addressed to you (or names your
  nick), followed by a disconnect within a minute. A rule your values met at the last check is not
  recorded as the reason.
