# airdcpp-seen-tracker

Remembers when each user was last online, on any of your hubs, and answers `/seen <nick>`.

Type `/seen bob` in a hub or a private chat. The answer appears there as a status line, visible
only to you:

- `bob is online now (Hub A, Hub B)`
- `bob was last seen 3 days 4 hours ago on Hub A (leaving)`
- `bob was last seen 2 hours ago on Hub A (still online when we last saw the hub)`: bob was
  there when you left that hub or your client stopped
- `No record of bob. Users are recorded from the moment this extension runs.`

The match ignores case. If no nick matches exactly, nicks containing the text are listed, newest
first (up to 5). `/help` lists the command.

## Answering other users

**Off by default.** When you turn it on, other users can type `!seen <nick>` in main chat and
the extension answers there, at most once per hub per cooldown (30 s by default). It never
answers itself or bots. Think before enabling it: it tells everyone in the hub when a user was
last online, and many hubs do not allow automatic answers in main chat.

Public answers are deliberately narrow:

- Only `!seen` followed by a single word (a nick, up to 64 characters) is answered.
- Every answer starts with `[seen] `, so a nick can never turn your answer into a command or a
  hub-bot trigger. A query that matches nothing is not repeated back.
- Only what happened **on that hub** is told. Your other hubs are never named, and a user who
  is online elsewhere counts as unknown there.

## Notes

- One record per user (by CID): their latest join or leave, on whichever hub. On ADC hubs a nick
  change is followed; NMDC users are identified by nick and hub, so there each nick is its own
  record.
- Users who were already online when the extension started get a record the first time they
  join or leave in front of it.
- Records older than the retention (365 days by default) are dropped, and at most 100 000 users
  are kept, newest first.
- Changes are appended to `seen.log` within a few seconds, and folded into `seen.json` at start
  and hourly once the log has grown. This keeps writes small on busy hubs. `alive.json` notes
  when the extension was last running, so that after a crash or a forced stop the users it saw
  online get the right time.
- The extension only listens to client events and never registers a hook, so it cannot slow
  down chat or joins.
- Requires Node.js 18 or newer.

## License

MIT
