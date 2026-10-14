'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { moveInto } = require('../src/mover');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sorter-'));

const makeRelease = (root, name) => {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'Sample'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.mkv'), 'x'.repeat(1000));
  fs.writeFileSync(path.join(dir, 'a.nfo'), 'nfo');
  fs.writeFileSync(path.join(dir, 'Sample', 's.mkv'), 'sample');
  const old = new Date('2020-01-02T03:04:05Z');
  fs.utimesSync(path.join(dir, 'a.mkv'), old, old);
  return dir;
};

test('same drive: one rename, every file listed with from and to', async () => {
  const root = tmp();
  const src = makeRelease(path.join(root, 'dl'), 'Rel-GRP');
  const dest = path.join(root, 'TV', 'Show', 'Season 01');
  const result = await moveInto(src, dest);
  assert.equal(result.crossDevice, false);
  assert.equal(result.target, path.join(dest, 'Rel-GRP'));
  assert.equal(fs.existsSync(src), false);
  assert.equal(fs.readFileSync(path.join(dest, 'Rel-GRP', 'Sample', 's.mkv'), 'utf8'), 'sample');
  const froms = result.files.map((f) => path.relative(root, f.from)).sort();
  assert.deepEqual(froms, [ path.join('dl', 'Rel-GRP', 'Sample', 's.mkv'), path.join('dl', 'Rel-GRP', 'a.mkv'), path.join('dl', 'Rel-GRP', 'a.nfo') ].sort());
  for (const f of result.files) {
    assert.ok(fs.existsSync(f.to), f.to);
  }
});

test('another drive (EXDEV): copy, verify, keep mtimes, then delete the source', async () => {
  const root = tmp();
  const src = makeRelease(path.join(root, 'dl'), 'Rel-GRP');
  const dest = path.join(root, 'Movies');
  const exdev = async () => { const e = new Error('cross-device'); e.code = 'EXDEV'; throw e; };
  const result = await moveInto(src, dest, { renameImpl: exdev });
  assert.equal(result.crossDevice, true);
  assert.equal(fs.existsSync(src), false);
  const moved = path.join(dest, 'Rel-GRP', 'a.mkv');
  assert.equal(fs.statSync(moved).size, 1000);
  assert.equal(fs.statSync(moved).mtime.toISOString(), '2020-01-02T03:04:05.000Z');
});

test('an existing target is never overwritten and the source stays', async () => {
  const root = tmp();
  const src = makeRelease(path.join(root, 'dl'), 'Rel-GRP');
  const dest = path.join(root, 'TV');
  fs.mkdirSync(path.join(dest, 'Rel-GRP'), { recursive: true });
  await assert.rejects(moveInto(src, dest), { code: 'EEXIST' });
  assert.ok(fs.existsSync(path.join(src, 'a.mkv')));
});

test('a failing rename (file in use) leaves the source untouched', async () => {
  const root = tmp();
  const src = makeRelease(path.join(root, 'dl'), 'Rel-GRP');
  const busy = async () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; };
  await assert.rejects(moveInto(src, path.join(root, 'TV'), { renameImpl: busy }), { code: 'EBUSY' });
  assert.ok(fs.existsSync(path.join(src, 'Sample', 's.mkv')));
});

test('a failing cross-drive copy removes the partial copy and keeps the source', async () => {
  const root = tmp();
  const src = makeRelease(path.join(root, 'dl'), 'Rel-GRP');
  const dest = path.join(root, 'Movies');
  // The second file copy fails (disk full on the destination drive)
  const exdev = async () => { const e = new Error('cross-device'); e.code = 'EXDEV'; throw e; };
  let calls = 0;
  const copyFileImpl = async (...args) => { if (++calls === 2) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return fs.promises.copyFile(...args); };
  await assert.rejects(moveInto(src, dest, { renameImpl: exdev, copyFileImpl }), { code: 'ENOSPC' });

  assert.equal(fs.existsSync(path.join(dest, 'Rel-GRP')), false);
  assert.equal(fs.existsSync(path.join(dest, 'Rel-GRP.sorter-partial')), false);
  assert.ok(fs.existsSync(path.join(src, 'a.mkv')));
  assert.ok(fs.existsSync(path.join(src, 'Sample', 's.mkv')));
});

test('a copy whose sizes do not match is rejected and removed; the original stays', async () => {
  const root = tmp();
  const src = makeRelease(path.join(root, 'dl'), 'Rel-GRP');
  const dest = path.join(root, 'Movies');
  const exdev = async () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); };
  // A copy that silently writes a short file
  const copyFileImpl = async (from, to) => { await fs.promises.copyFile(from, to); if (from.endsWith('a.mkv')) await fs.promises.truncate(to, 10); };
  await assert.rejects(moveInto(src, dest, { renameImpl: exdev, copyFileImpl }), { code: 'EVERIFY' });
  assert.equal(fs.existsSync(path.join(dest, 'Rel-GRP')), false);
  assert.equal(fs.existsSync(path.join(dest, 'Rel-GRP.sorter-partial')), false);
  assert.equal(fs.statSync(path.join(src, 'a.mkv')).size, 1000);
});

test('the copy carries the real name only once it is complete', async () => {
  const root = tmp();
  const src = makeRelease(path.join(root, 'dl'), 'Rel-GRP');
  const dest = path.join(root, 'Movies');
  const exdev = async () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); };
  const seen = [];
  const copyFileImpl = async (from, to) => { seen.push(path.relative(dest, to).split(path.sep)[0]); return fs.promises.copyFile(from, to); };
  await moveInto(src, dest, { renameImpl: exdev, copyFileImpl });
  assert.deepEqual([ ...new Set(seen) ], [ 'Rel-GRP.sorter-partial' ]);
  assert.ok(fs.existsSync(path.join(dest, 'Rel-GRP', 'a.mkv')));
});

test('an original that cannot be fully deleted after a committed copy is reported, not undone', async () => {
  const root = tmp();
  const src = makeRelease(path.join(root, 'dl'), 'Rel-GRP');
  const locked = path.join(src, 'a.nfo');
  const exdev = async () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); };
  // Like an upload holding one file open: everything else goes, that file stays and EBUSY is thrown
  const removeSourceImpl = async () => {
    fs.rmSync(path.join(src, 'Sample'), { recursive: true });
    fs.rmSync(path.join(src, 'a.mkv'));
    throw Object.assign(new Error('busy'), { code: 'EBUSY' });
  };
  const result = await moveInto(src, path.join(root, 'Movies'), { renameImpl: exdev, removeSourceImpl });
  assert.equal(result.crossDevice, true);
  assert.ok(fs.existsSync(path.join(root, 'Movies', 'Rel-GRP', 'a.mkv')));
  assert.ok(fs.existsSync(path.join(root, 'Movies', 'Rel-GRP', 'Sample', 's.mkv')));
  assert.deepEqual(result.leftovers, [ locked ]);
});

test('a release with a junction inside is not moved to another drive', async () => {
  const root = tmp();
  const src = makeRelease(path.join(root, 'dl'), 'Rel-GRP');
  fs.mkdirSync(path.join(root, 'elsewhere'));
  try {
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(src, 'link'), 'junction');
  } catch (e) {
    return; // links not available here
  }

  const exdev = async () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); };
  await assert.rejects(moveInto(src, path.join(root, 'Movies'), { renameImpl: exdev }), { code: 'ESPECIAL' });
  assert.ok(fs.existsSync(path.join(src, 'a.mkv')));
});

test('a name ending in a dot or a space is refused', async () => {
  const root = tmp();
  await assert.rejects(moveInto(path.join(root, 'Name.'), path.join(root, 'TV')), { code: 'EBADNAME' });
});

test('a single-file release moves as a file', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'dl'));
  const file = path.join(root, 'dl', 'Show.S01E01.720p.HDTV-GRP.mkv');
  fs.writeFileSync(file, 'episode');
  const result = await moveInto(file, path.join(root, 'TV'));
  assert.equal(fs.readFileSync(path.join(root, 'TV', 'Show.S01E01.720p.HDTV-GRP.mkv'), 'utf8'), 'episode');
  assert.deepEqual(result.files.map((f) => f.to), [ path.join(root, 'TV', 'Show.S01E01.720p.HDTV-GRP.mkv') ]);
});
