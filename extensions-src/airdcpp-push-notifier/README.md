# airdcpp-push-notifier

Sends push notifications to your phone or desktop when something happens in AirDC++ / FulDC++,
which is most useful when the client runs headless on a server or NAS.

**Events**

- a private message (by default only while you are away)
- someone mentions your nick in a hub (by default only while you are away)
- a download finishes, or fails
- a hub stays disconnected (off by default; waits for the client's own reconnect first)

**Services** (configure one or several)

| Service | What to fill in |
| :--- | :--- |
| [ntfy](https://ntfy.sh) | server (e.g. `https://ntfy.sh`), topic, optional access token |
| [Gotify](https://gotify.net) | server, application token |
| Telegram | bot token from @BotFather, chat id |
| Discord | channel webhook URL |
| [Pushover](https://pushover.net) | application token, user key |
| Generic webhook | any URL; receives `POST` JSON `{ event, title, message, time }` |

After saving, tick **Send a test notification now** and save again: a test goes to every
configured service and the result appears in the event log.

## Limits

- **Cooldown**: one notification per source (a user's private messages, a hub's mentions) within
  the cooldown, so a burst of messages gives one buzz.
- **Rate limit**: at most N notifications per minute. Dropped ones are counted and mentioned in
  the next notification that goes out.
- **Quiet hours**: nothing is sent between the two times (a window over midnight, such as
  22:00-07:00, works).

## Privacy

- Notifications go only to the services you configure. Turn off **Include the message text** to
  send only who wrote, never what.
- Download notifications carry the release name only, never the local path.
- Tokens and webhook URLs are stored **in plain text** in the extension's settings file, like
  every extension setting. Anyone who can read your settings folder can read them.
- Starting the extension in debug mode makes the extension library log every event and
  setting it receives, including message text and tokens. Use it only to troubleshoot.
- Redirects are refused: enter the final `https://` address of a service.
- Discord mentions are disabled on every message (`@everyone` in a chat line stays plain text),
  and Telegram messages are sent as plain text.

## Notes

- The extension only listens to client events. It never registers a hook, so it cannot slow
  down or block chat, downloads or sharing, even when a service is slow or unreachable.
- A failing service is reported once in the event log, not once per message, and again only
  after it has worked in between.
- Requires Node.js 18 or newer.

## License

MIT
