'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRecycler, SCRIPT } = require('../src/recycle');

const fakeExec = (answer, sink) => (file, args, options, cb) => {
  sink.push({ file, args, options });
  setImmediate(() => answer(options, cb));
};

test('the paths travel only in the environment, never in the command', async () => {
  const calls = [];
  const evil = "D:\\Media\\x'; Remove-Item -Recurse C:\\ ; '$(calc)`.mkv";
  const recycler = createRecycler({
    execFileImpl: fakeExec((options, cb) => {
      const req = JSON.parse(options.env.WC_RECYCLE_REQUEST);
      cb(null, `\uFEFF${JSON.stringify(req.items.map((i) => ({ path: i.path, ok: true, reason: '', in_bin: true })))}\r\n`);
    }, calls),
  });
  const results = await recycler.recycle([ { path: evil, is_dir: false, size: 5 } ]);
  assert.deepEqual(results, [ { path: evil, ok: true, reason: '', in_bin: true } ]);
  const { file, args, options } = calls[0];
  assert.equal(file, 'powershell.exe');
  const encoded = args[args.indexOf('-EncodedCommand') + 1];
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), SCRIPT);
  assert.ok(!args.join(' ').includes('Remove-Item'));
  assert.equal(options.windowsHide, true);
  assert.ok(options.timeout > 0);
});

test('the script refuses what the Recycle Bin would delete outright, and never deletes', () => {
  assert.match(SCRIPT, /SendToRecycleBin/);
  assert.ok(!/DeletePermanently|Remove-Item|\.Delete\(/.test(SCRIPT));
  assert.match(SCRIPT, /DriveType -ne 'Fixed'/);
  assert.match(SCRIPT, /NukeOnDelete/);
  assert.match(SCRIPT, /larger than the recycle bin/);
  assert.match(SCRIPT, /'Open', 'Read', 'None'/); // in use: refused before starting
});

test('an unreadable answer, a short answer or a failed run is an error, not success', async () => {
  for (const answer of [
    (o, cb) => cb(null, 'garbage'),
    (o, cb) => cb(null, '[]'),
    (o, cb) => cb(Object.assign(new Error('x'), { killed: true }), ''),
  ]) {
    const recycler = createRecycler({ execFileImpl: fakeExec(answer, []) });
    await assert.rejects(recycler.recycle([ { path: 'D:\\a.mkv', is_dir: false, size: 1 } ]));
  }
});

test('a single result that PowerShell sent as an object is accepted', async () => {
  const recycler = createRecycler({ execFileImpl: fakeExec((o, cb) => cb(null, '{"path":"D:\\\\a.mkv","ok":false,"reason":"in use","in_bin":false}'), []) });
  const [ r ] = await recycler.recycle([ { path: 'D:\\a.mkv', is_dir: false, size: 1 } ]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'in use');
});

// Review 2026-10-18, run for real on Windows: on a SUBST drive letter the shell's "send to the
// Recycle Bin" deleted the file PERMANENTLY (the drive reports Fixed, but no volume has that
// letter). The script must refuse it and leave the file where it is.
test('a file on a SUBST drive is refused, not deleted', { skip: process.platform !== 'win32' }, async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const letter = 'ZYXWVUTSRQPONMLKJIHG'.split('').find((l) => !fs.existsSync(`${l}:\\`));
  if (!letter) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-subst-'));
  fs.writeFileSync(path.join(dir, 'victim.txt'), 'must survive');
  execFileSync('subst', [ `${letter}:`, dir ], { windowsHide: true });
  try {
    const target = `${letter}:\\victim.txt`;
    const [ result ] = await createRecycler().recycle([ { path: target, is_dir: false, size: 12 } ]);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(result.reason, /not a volume of its own/);
    assert.ok(fs.existsSync(path.join(dir, 'victim.txt')), 'the file was deleted');
  } finally {
    execFileSync('subst', [ `${letter}:`, '/D' ], { windowsHide: true });
  }
});

// Reached through a junction, the item lives on whatever volume the junction points at, not the
// one whose bin the script checked: refused.
test('a file reached through a junction is refused, not moved', { skip: process.platform !== 'win32' }, async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-junction-'));
  const target = path.join(base, 'target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'victim.txt'), 'must stay');
  fs.symlinkSync(target, path.join(base, 'link'), 'junction');
  const [ result ] = await createRecycler().recycle([ { path: path.join(base, 'link', 'victim.txt'), is_dir: false, size: 9 } ]);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.reason, /link or a mounted folder/);
  assert.ok(fs.existsSync(path.join(target, 'victim.txt')));
});
