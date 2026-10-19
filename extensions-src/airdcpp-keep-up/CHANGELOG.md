# Changelog

## 1.0.0-beta.1

- First release: follows the shows one media-server account is watching and queues the next
  aired episodes that are neither in the library nor in the queue, from hub searches matched
  strictly on show and SxxEyy. Hourly search budget, search spacing, per-episode retry backoff,
  caps on its own downloads (count and total size), dry run on by default, `/keepup status` and
  `/keepup run`.
- Review fixes before release: a year in the release name must be one of the show's years; a
  country-tagged show is never matched by its bare title; sample and trailer files are never
  taken; its downloads are tracked by queue id (renamed bundles and pending folder downloads
  count against the caps); a folder download that fails before it is queued is retried; the dry
  run keeps to the caps.
- Releases tagged with another language, a dub, hardcoded subtitles, extras, bonus, subpack or
  trailer are never taken; new setting "Accepted language tags" (default empty).

- Live-test fix: without a TMDB key, a followed show the media server's metadata has not
  identified is named in `/keepup status` ("next episodes unknown for: ..."); before, the run read
  "0 queued, 0 not found" as if nothing were needed.
- Live-test fix: the settings load at every start was handled as a settings change before the
  state was loaded, which wrote "Settings update failed: Cannot set properties of null" to the
  error log on each start (and would have dropped the stored sign-in once the order changed).
- When a release folder and the loose video file of the same release both match, the folder is
  queued: it carries the .nfo/.sfv the client checks a release with, and the download sorter
  files it whole. Before, whichever more users shared won.
