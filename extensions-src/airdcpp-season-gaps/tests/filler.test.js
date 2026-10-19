'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFiller } = require('../src/filler');
const { titleKeys } = require('../src/release');

const DEFAULTS = { quality: '1080p', preferred_groups: '', require_preferred_group: false, searches_per_hour: 20, search_spacing_seconds: 20, retry_days: 3 };

const setup = ({ results = [], bundles = [], hubSearchError = null, values = {}, downloadAnswer = { bundle_info: {} }, directoryDownloads = [] } = {}) => {
  const clock = { value: Date.UTC(2026, 9, 18, 12) };
  const state = { searches: [], attempts: {}, pending: [] };
  const calls = [];
  const events = [];
  const savedSnapshots = [];
  const countedAtSearch = [];
  const socket = {
    logger: { info() {}, error() {}, verbose() {} },
    get: async (url) => {
      calls.push([ 'GET', url ]);
      if (url === 'queue/bundles/0/100000') return bundles;
      if (url === 'filelists/directory_downloads') return typeof directoryDownloads === 'function' ? directoryDownloads() : directoryDownloads;
      if (/^search\/\d+\/results\/0\/200$/.test(url)) return results;
      throw new Error(`unexpected ${url}`);
    },
    post: async (url, body) => {
      calls.push([ 'POST', url, body ]);
      if (url === 'search') {
        countedAtSearch.push(state.searches.length);
        return { id: 77 };
      }
      if (url.endsWith('/hub_search')) {
        if (hubSearchError) throw hubSearchError;
        return { queue_time: 1000, queued_count: 2 };
      }

      if (url.endsWith('/download')) return downloadAnswer;
      throw new Error(`unexpected ${url}`);
    },
    delete: async (url) => { calls.push([ 'DELETE', url ]); },
  };
  const filler = createFiller({
    socket,
    getValues: () => ({ ...DEFAULTS, ...values }),
    store: { get: () => state, save: () => savedSnapshots.push(JSON.parse(JSON.stringify(state))) },
    now: () => clock.value,
    sleep: async (ms) => { clock.value += ms; },
    onEvent: (text) => events.push(text),
  });
  return { filler, state, calls, events, clock, savedSnapshots, countedAtSearch };
};

const item = (episode, season = 2) => ({ seriesId: 'S1', show: 'Show Name', keys: Array.from(titleKeys('Show Name')), season, episode });
const dir = (id, name, hits = 1, extra = {}) => ({ id, name, type: { id: 'directory' }, hits, dupe: null, ...extra });

test('one search per tick: queues only the exact match, deletes the instance, records the search first', async () => {
  const t = setup({ results: [ dir('X', 'Show.Name.S02E06.1080p-A', 9), dir('Y', 'Show.Name.S02E05.1080p-B', 2) ] });
  assert.equal(t.filler.enqueue([ item(5), item(6) ], { manual: true }), 2);
  assert.equal(await t.filler.tick(), true);
  const posts = t.calls.filter((c) => c[0] === 'POST');
  assert.deepEqual(posts[0], [ 'POST', 'search', { expiration: 10, owner_suffix: 'season-gaps' } ]);
  assert.deepEqual(posts[1], [ 'POST', 'search/77/hub_search', { query: { pattern: 'Show Name S02E05 1080p', file_type: 'any' } } ]);
  assert.deepEqual(posts[2], [ 'POST', 'search/77/results/Y/download', {} ]);
  assert.ok(t.calls.some((c) => c[0] === 'DELETE' && c[1] === 'search/77'));
  assert.match(t.events[0], /queued Show Name S02E05: Show\.Name\.S02E05\.1080p-B/);
  // The search was counted (and saved) before the search instance was even created
  assert.deepEqual(t.countedAtSearch, [ 1 ]);
  assert.ok(t.savedSnapshots.some((s) => s.searches.length === 1 && s.pending.length === 1 && !s.attempts['S1|S02E05']));
  // The next one waits for the spacing
  assert.equal(await t.filler.tick(), false);
  t.clock.value += 20 * 1000;
  assert.equal(await t.filler.tick(), true);
  assert.match(t.state.attempts['S1|S02E06'].outcome, /^queued /, 'E06 was found among the same kind of results');
});

test('no exact match: nothing downloaded, and the top result is never taken', async () => {
  const t = setup({ results: [ dir('X', 'Show.Name.S02E06.1080p-A', 50), dir('Z', 'Show.Name.S02E05.720p-A', 40), dir('Q', 'Show.Name.S02.1080p-PACK', 30) ] });
  t.filler.enqueue([ item(5) ], { manual: true });
  await t.filler.tick();
  assert.ok(!t.calls.some((c) => c[1] && c[1].endsWith('/download')));
  assert.match(t.state.attempts['S1|S02E05'].outcome, /no exact match among 3/);
  assert.ok(t.calls.some((c) => c[0] === 'DELETE'));
});

test('already in the queue: no search at all, no budget spent', async () => {
  const t = setup({ bundles: [ { id: 1, name: 'Show.Name.S02E05.720p.WEB-X' } ] });
  t.filler.enqueue([ item(5) ], { manual: true });
  await t.filler.tick();
  assert.equal(t.state.searches.length, 0);
  assert.ok(!t.calls.some((c) => c[1] === 'search'));
});

test('a double episode fills its partner; the partner is dropped from the waiting list', async () => {
  const t = setup({ results: [ dir('D', 'Show.Name.S02E05E06.1080p-G') ] });
  t.filler.enqueue([ item(5), item(6) ], { manual: true });
  await t.filler.tick();
  assert.equal(t.state.pending.length, 0);
  assert.ok(t.state.attempts['S1|S02E06']);
});

test('the hourly budget holds even across many ticks', async () => {
  const t = setup({ values: { searches_per_hour: 3 } });
  t.filler.enqueue([ 1, 2, 3, 4, 5, 6 ].map((n) => item(n)), { manual: true });
  let searched = 0;
  for (let i = 0; i < 100; i++) {
    if (await t.filler.tick()) searched++;
    t.clock.value += 5000;
  }

  // 100 ticks of 5 s plus the waits for results stay inside one hour
  assert.ok(t.clock.value - Date.UTC(2026, 9, 18, 12) < 60 * 60 * 1000);
  assert.equal(searched, 3);
  assert.equal(t.calls.filter((c) => c[1] === 'search').length, 3);
});

test('a search that could not be sent is tried again a few times, then given up', async () => {
  const error = Object.assign(new Error('No online hubs'), { code: 400 });
  const t = setup({ hubSearchError: error });
  t.filler.enqueue([ item(5) ], { manual: true });
  for (let i = 0; i < 3; i++) {
    t.clock.value += 60 * 1000;
    await t.filler.tick();
  }

  assert.equal(t.state.pending.length, 0);
  assert.match(t.state.attempts['S1|S02E05'].outcome, /search failed: No online hubs/);
  assert.equal(t.calls.filter((c) => c[0] === 'DELETE').length, 3, 'every instance removed');
});

test('automatic enqueue waits retry_days after an attempt; manual does not; duplicates are not added', () => {
  const t = setup();
  t.state.attempts['S1|S02E05'] = { at: t.clock.value - 24 * 60 * 60 * 1000, outcome: 'no exact match' };
  assert.equal(t.filler.enqueue([ item(5) ]), 0);
  assert.equal(t.filler.enqueue([ item(5) ], { manual: true }), 1);
  assert.equal(t.filler.enqueue([ item(5) ], { manual: true }), 0);
  assert.equal(t.filler.clear(), 1);
});

// REVIEW: a release year that is not the show's year is another show, even with more sources
test('a release of a same-named show from another year is never downloaded', async () => {
  const t = setup({ results: [ dir('NEW', 'Doctor.Who.2005.S01E01.1080p.WEB-X', 50), dir('OLD', 'Doctor.Who.1963.S01E01.1080p-Y', 1) ] });
  const who = { seriesId: 'D', show: 'Doctor Who', keys: [ 'doctorwho' ], years: [ 1963 ], season: 1, episode: 1 };
  t.filler.enqueue([ who ], { manual: true });
  await t.filler.tick();
  assert.deepEqual(t.calls.filter((c) => c[0] === 'POST' && c[1].endsWith('/download')).map((c) => c[1]), [ 'search/77/results/OLD/download' ]);
});

// REVIEW 2 (from the keep-up review): a release's sample or trailer file is never the episode
test('a sample or trailer file is never queued, however many users have it', async () => {
  const t = setup({ results: [
    { id: 'S1', name: 'Show.Name.S02E05.1080p.WEB-GRP-sample.mkv', type: { id: 'file' }, hits: 90, dupe: null },
    { id: 'S2', name: 'Show.Name.S02E05.1080p.WEB-GRP.(sample).mkv', type: { id: 'file' }, hits: 80, dupe: null },
    { id: 'T1', name: 'Show.Name.S02E05.Trailer.1080p.WEB-GRP.mkv', type: { id: 'file' }, hits: 70, dupe: null },
    { id: 'T2', name: 'Show.Name.S02E05.1080p.WEB-GRP-trailer.mkv', type: { id: 'file' }, hits: 60, dupe: null },
    dir('REAL', 'Show.Name.S02E05.1080p.WEB-GRP', 1),
  ] });
  t.filler.enqueue([ item(5) ], { manual: true });
  await t.filler.tick();
  assert.deepEqual(t.calls.filter((c) => c[0] === 'POST' && c[1].endsWith('/download')).map((c) => c[1]), [ 'search/77/results/REAL/download' ]);
});

// REVIEW 2: a folder download is not a queue bundle until the source's file list arrives
test('a folder download still waiting for its file list is not searched for or queued again', async () => {
  let downloads = [];
  const t = setup({
    results: [ dir('Y', 'Show.Name.S02E05.1080p-B', 2) ],
    downloadAnswer: { directory_download_ids: [ { id: 'dd5', state: 'pending' } ] },
    directoryDownloads: () => downloads,
  });
  t.filler.enqueue([ item(5) ], { manual: true });
  await t.filler.tick();
  downloads = [ { id: 'dd5', state: 'pending' } ];
  assert.equal(t.state.attempts['S1|S02E05'].directoryDownloadId, 'dd5');

  t.clock.value += 60 * 1000;
  t.filler.enqueue([ item(5) ], { manual: true });
  await t.filler.tick();
  assert.equal(t.calls.filter((c) => c[1] === 'search').length, 1, 'no second search');
  assert.equal(t.calls.filter((c) => c[0] === 'POST' && c[1].endsWith('/download')).length, 1, 'no second download');
  assert.equal(t.state.searches.length, 1, 'no budget spent');
});

test('a folder download that failed before reaching the queue is looked for again after a backoff', async () => {
  const t = setup({ results: [ dir('Y', 'Show.Name.S02E05.1080p-B', 2) ], downloadAnswer: { directory_download_ids: [ { id: 'dd5', state: 'pending' } ] } });
  t.filler.enqueue([ item(5) ], { manual: true });
  await t.filler.tick();
  assert.equal(t.filler.enqueue([ item(5) ]), 0, 'automatic fill leaves a queued episode alone');

  assert.equal(t.filler.onDirectoryDownloadFailed({ directory_download: { id: 'dd5' }, error: 'offline' }), 1);
  const attempt = t.state.attempts['S1|S02E05'];
  assert.match(attempt.outcome, /could not be queued/);
  assert.equal(attempt.directoryDownloadId, undefined);
  assert.equal(t.filler.enqueue([ item(5) ]), 0, 'not at once');
  t.clock.value += 61 * 60 * 1000;
  assert.equal(t.filler.enqueue([ item(5) ]), 1, 'after an hour, not after retry_days');
  assert.equal(t.filler.onDirectoryDownloadFailed({ directory_download: { id: 'other' } }), 0);
});

// REVIEW 3 (from the quality-upgrader review): a language, dub, hardsub or extras release is not
// the episode the user wants, unless the user accepts that tag
test('language, dub, hardsub and extras releases are refused unless the tag is accepted', async () => {
  const tagged = [
    'Show.Name.S02E05.1080p.FRENCH.WEB-GRP', 'Show.Name.S02E05.GERMAN.DL.1080p.WEB-GRP', 'Show.Name.S02E05.1080p.NORDiC.WEB-GRP',
    'Show.Name.S02E05.1080p.SWESUB.WEB-GRP', 'Show.Name.S02E05.1080p.DUBBED.WEB-GRP', 'Show.Name.S02E05.MULTi.1080p.WEB-GRP',
    'Show.Name.S02E05.1080p.HC.WEB-GRP', 'Show.Name.S02E05.EXTRAS.1080p.WEB-GRP', 'Show.Name.S02E05.Bonus.1080p.WEB-GRP',
    'Show.Name.S02E05.1080p.SUBPACK-GRP',
  ];
  const results = [ ...tagged.map((name, i) => dir(`T${i}`, name, 90 - i)), dir('REAL', 'Show.Name.S02E05.1080p.WEB-DL.H264-GRP', 1) ];
  const t = setup({ results });
  t.filler.enqueue([ item(5) ], { manual: true });
  await t.filler.tick();
  assert.deepEqual(t.calls.filter((c) => c[0] === 'POST' && c[1].endsWith('/download')).map((c) => c[1]), [ 'search/77/results/REAL/download' ]);

  const accepting = setup({ results, values: { accepted_tags: 'multi' } });
  accepting.filler.enqueue([ item(5) ], { manual: true });
  await accepting.filler.tick();
  assert.deepEqual(accepting.calls.filter((c) => c[0] === 'POST' && c[1].endsWith('/download')).map((c) => c[1]), [ 'search/77/results/T5/download' ]);
});
