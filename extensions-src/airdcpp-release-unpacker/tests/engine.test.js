'use strict';

// The decoders for real, in real worker threads (src/index.js is the worker entry, as the
// bundle is in the client), on the fixture archives in tests/fixtures (make-fixtures.ps1).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunner, defaultVendor } = require('../src/runner');
const { parse7zListing, outputPathOf, verifyWritten } = require('../src/engine');
const { payload } = require('./fixtures/payload');

const FIX = path.join(__dirname, 'fixtures');
const workerFile = path.join(__dirname, '..', 'src', 'index.js');
const runner = createRunner({ workerFile, vendor: defaultVendor(path.dirname(workerFile)) });

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'unpk-eng-'));
const copySet = (name) => {
  const dir = tmpDir();
  for (const f of fs.readdirSync(path.join(FIX, name))) fs.copyFileSync(path.join(FIX, name, f), path.join(dir, f));
  return dir;
};

const listAndExtract = async (kind, dir, first) => {
  const listing = await runner.run({ op: 'list', kind, dir, first });
  const out = tmpDir();
  const files = listing.entries.filter((e) => !e.directory);
  const result = await runner.run({ op: 'extract', kind, dir, first, outDir: out, files });
  return { listing, out, result };
};

for (const [ name, kind, first, stored ] of [
  [ 'rar4', 'rar', 'rel.rar', false ],
  [ 'rar5', 'rar', 'rel.part1.rar', false ],
  [ 'rar5stored', 'rar', 'rel.part1.rar', true ],
  [ 'zip', 'zip', 'rel.zip', false ],
  [ 'sevenzip', '7z', 'rel.7z', false ],
]) {
  test(`${name}: listed with sizes and methods, unpacked byte for byte`, async () => {
    const { listing, out, result } = await listAndExtract(kind, path.join(FIX, name), first);
    const mkv = listing.entries.find((e) => e.name === 'movie.mkv');
    assert.equal(mkv.size, 150000);
    assert.equal(mkv.stored, stored);
    assert.equal(mkv.encrypted, false);
    assert.ok(result.results.some((r) => r.rel === 'movie.mkv' && r.size === 150000));
    assert.ok(fs.readFileSync(path.join(out, 'movie.mkv')).equals(payload()));
  });
}

test('RAR: only the wanted entries are written', async () => {
  const dir = path.join(FIX, 'rar4');
  const listing = await runner.run({ op: 'list', kind: 'rar', dir, first: 'rel.rar' });
  const out = tmpDir();
  const files = listing.entries.filter((e) => e.name === 'movie.srt');
  await runner.run({ op: 'extract', kind: 'rar', dir, first: 'rel.rar', outDir: out, files });
  assert.deepEqual(fs.readdirSync(out), [ 'movie.srt' ]);
  assert.ok(fs.readFileSync(path.join(out, 'movie.srt')).equals(payload(3000, 99)));
});

test('encrypted data and encrypted headers are recognised', async () => {
  const data = await runner.run({ op: 'list', kind: 'rar', dir: path.join(FIX, 'encrypted'), first: 'rel.rar' });
  assert.equal(data.entries[0].encrypted, true);
  await assert.rejects(runner.run({ op: 'list', kind: 'rar', dir: path.join(FIX, 'encheaders'), first: 'rel.rar' }), (e) => e.reason === 'encrypted');
});

test('a missing volume is named', async () => {
  await assert.rejects(runner.run({ op: 'list', kind: 'rar', dir: path.join(FIX, 'missing'), first: 'rel.rar' }), (e) => e.reason === 'missing_volume' && /rel\.r01/.test(e.message));
});

for (const [ name, kind, first, victim ] of [ [ 'rar5', 'rar', 'rel.part1.rar', 'rel.part2.rar' ], [ 'rar4', 'rar', 'rel.rar', 'rel.r00' ], [ 'zip', 'zip', 'rel.zip', 'rel.zip' ], [ 'sevenzip', '7z', 'rel.7z', 'rel.7z' ] ]) {
  test(`${name}: one flipped byte fails the unpack as damaged`, async () => {
    const dir = copySet(name);
    const listing = await runner.run({ op: 'list', kind, dir, first });
    const file = path.join(dir, victim);
    const b = fs.readFileSync(file);
    b[Math.floor(b.length / 2)] ^= 0x55;
    fs.writeFileSync(file, b);
    const out = tmpDir();
    await assert.rejects(
      runner.run({ op: 'extract', kind, dir, first, outDir: out, files: listing.entries.filter((e) => !e.directory) }),
      (e) => e.reason === 'damaged',
    );
  });
}

test('RAR: a file already in the temporary folder is never replaced (opened exclusively)', async () => {
  const dir = path.join(FIX, 'rar5');
  const listing = await runner.run({ op: 'list', kind: 'rar', dir, first: 'rel.part1.rar' });
  const out = tmpDir();
  fs.writeFileSync(path.join(out, 'movie.mkv'), 'mine');
  await assert.rejects(runner.run({ op: 'extract', kind: 'rar', dir, first: 'rel.part1.rar', outDir: out, files: listing.entries }));
  assert.equal(fs.readFileSync(path.join(out, 'movie.mkv'), 'utf8'), 'mine');
});

test('7-Zip listing parser: entries, folders, encryption, stored', () => {
  const out = [
    'Listing archive: /src/a.zip', '--', 'Path = /src/a.zip', 'Type = zip', '', '----------',
    'Path = Subs', 'Folder = +', 'Size = 0', 'Attributes = D', '',
    'Path = Subs/eng.srt', 'Folder = -', 'Size = 12', 'CRC = 0000000A', 'Method = Store', 'Encrypted = -', '',
    'Path = film.mkv', 'Folder = -', 'Size = 123456789012', 'CRC = FFFFFFFF', 'Method = ZipCrypto Deflate', 'Encrypted = +', '',
  ].join('\n');
  const { entries, archiveEncrypted } = parse7zListing(out);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].directory, true);
  assert.deepEqual(entries[1], { name: 'Subs/eng.srt', size: 12, crc: 10, stored: true, encrypted: false, directory: false });
  assert.equal(entries[2].size, 123456789012);
  assert.equal(entries[2].crc, 0xFFFFFFFF);
  assert.equal(entries[2].encrypted, true);
  assert.equal(archiveEncrypted, true);
});

test('an entry name cannot leave the output folder', () => {
  const out = tmpDir();
  assert.equal(outputPathOf(out, '../../x.mkv').full, path.join(out, 'x.mkv'));
  assert.throws(() => outputPathOf(out, '..'), (e) => e.reason === 'unsafe_name');
  assert.throws(() => outputPathOf(out, 'nul'), (e) => e.reason === 'unsafe_name');
});

test('verification: a wrong size or CRC, or a file never written, fails; CRC 0 means "checked by unRAR"', () => {
  const f = { name: 'm.mkv', size: 10, crc: 1234 };
  assert.deepEqual(verifyWritten([ f ], () => ({ rel: 'm.mkv', size: 10, crc: 1234 })).results, [ { name: 'm.mkv', rel: 'm.mkv', size: 10 } ]);
  assert.throws(() => verifyWritten([ f ], () => ({ rel: 'm.mkv', size: 9, crc: 1234 })), (e) => e.reason === 'damaged');
  assert.throws(() => verifyWritten([ f ], () => ({ rel: 'm.mkv', size: 10, crc: 1 })), (e) => e.reason === 'damaged' && /CRC/.test(e.message));
  assert.throws(() => verifyWritten([ f ], () => null), (e) => e.reason === 'damaged');
  assert.equal(verifyWritten([ { ...f, crc: 0 } ], () => ({ rel: 'm.mkv', size: 10, crc: 99 })).results.length, 1);
});

// Review 2026-10-18: on a full disk 7-Zip (on NODEFS) printed no reason and the set was
// reported as "7-Zip failed"; RAR already said "the disk is full"
for (const [ name, kind, first ] of [ [ 'zip', 'zip', 'rel.zip' ], [ 'sevenzip', '7z', 'rel.7z' ], [ 'rar4', 'rar', 'rel.rar' ] ]) {
  test(`${name}: a full disk while unpacking is reported as a full disk`, async () => {
    const { Worker } = require('node:worker_threads');
    const dir = copySet(name);
    const out = tmpDir();
    const worker = new Worker(path.join(FIX, 'enospc-worker.js'), {
      workerData: { kind, dir, first, outDir: out, vendor: defaultVendor(path.dirname(workerFile)) },
    });
    const result = await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    await worker.terminate();
    assert.equal(result.reason, 'disk_full', result.message);
  });
}

test('runner: a thread that never finishes is ended at its timeout and the run fails as "timeout"', async () => {
  const hang = createRunner({ workerFile: path.join(FIX, 'hang-worker.js'), vendor: {} });
  const outcome = await Promise.race([
    hang.run({ op: 'list' }, () => {}, 200).then(() => 'resolved', (e) => e.reason),
    new Promise((resolve) => setTimeout(() => resolve('still running after 5 s'), 5000).unref()),
  ]);
  hang.stopAll();
  assert.equal(outcome, 'timeout');
});

test('runner: a thread that dies on its own fails as "failed"; only stopAll gives "stopped"', async () => {
  const crash = createRunner({ workerFile: path.join(FIX, 'crash-worker.js'), vendor: {} });
  await assert.rejects(crash.run({ op: 'list', kind: 'rar' }), (e) => e.reason === 'failed');
  const hang = createRunner({ workerFile: path.join(FIX, 'hang-worker.js'), vendor: {} });
  const p = hang.run({ op: 'list' });
  setTimeout(() => hang.stopAll(), 100);
  await assert.rejects(p, (e) => e.reason === 'stopped');
});

// Review 2026-10-18: 7-Zip writes through Emscripten's NODEFS, where a name with backslashes
// would be joined by Windows' path rules. Neither "..\..\..\x" nor a symlink entry followed by
// "link/x" may put anything outside the output folder. (The two zips were made with Python's
// zipfile: a FAT-less unix entry named ..\..\..\escape_bs_unix.txt; a symlink lnk -> ../../..
// plus an entry lnk/escape_symlink.txt.)
const filesUnder = (d, acc = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    acc.push(p);
    if (e.isDirectory() && !e.isSymbolicLink()) filesUnder(p, acc);
  }
  return acc;
};

test('zip: a backslash ".." name lands inside the output folder', async () => {
  const dir = copySet('evil-backslash');
  const base = tmpDir();
  const out = path.join(base, 'a', 'b', 'c', 'out');
  fs.mkdirSync(out, { recursive: true });
  const listing = await runner.run({ op: 'list', kind: 'zip', dir, first: 'rel.zip' });
  await runner.run({ op: 'extract', kind: 'zip', dir, first: 'rel.zip', outDir: out, files: listing.entries.filter((e) => !e.directory) }).catch(() => {});
  const outside = filesUnder(base).filter((p) => p !== out && !p.startsWith(out + path.sep) && !out.startsWith(p + path.sep));
  assert.deepEqual(outside, []);
  assert.deepEqual(fs.readdirSync(dir), [ 'rel.zip' ]);
});

test('zip: a symlink entry fails the set and nothing is written outside the output folder', async () => {
  const dir = copySet('evil-symlink');
  const base = tmpDir();
  const out = path.join(base, 'a', 'b', 'c', 'out');
  fs.mkdirSync(out, { recursive: true });
  const listing = await runner.run({ op: 'list', kind: 'zip', dir, first: 'rel.zip' });
  await assert.rejects(runner.run({ op: 'extract', kind: 'zip', dir, first: 'rel.zip', outDir: out, files: listing.entries.filter((e) => !e.directory) }));
  const outside = filesUnder(base).filter((p) => p !== out && !p.startsWith(out + path.sep) && !out.startsWith(p + path.sep));
  assert.deepEqual(outside, []);
  assert.deepEqual(fs.readdirSync(dir), [ 'rel.zip' ]);
});
