# Changelog

## 1.0.0-beta.1

- First release: a daily report of the aired episodes missing from the series in the media
  library (the media server's own missing-episode lists and/or TMDB), whole missing seasons,
  `/gaps` chat commands, and an on-request hub fill that downloads only exact show + episode
  matches within a search budget.
- Review fix: a release whose name carries a year that is not the show's year, or the bare
  title of a show the library tags with a country (`The Office (US)`), is never downloaded.
- Review fix: sample and trailer files are never queued. A folder download still waiting for the
  source's file list is not searched for again. One that fails is tried again after a backoff
  (1 h to 24 h) instead of after retry_days.
- Review fix: a release tagged with another language, a dub, hardsubs or extras is never queued
  unless the new setting "accepted language tags" lists the tag.

- Live-test fix: with only the media server's own lists to go on, a series its metadata has not
  identified (no TMDB id: metadata off or no key in the media server) is listed under "Not fully
  checked", the report gets a note saying how to fix it, and the summary counts it. Before, such
  a library read "0 show(s) with gaps" although nothing could be compared.
