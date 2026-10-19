'use strict';

// The bytes packed into every fixture archive. Deterministic, so the tests can compare what was
// unpacked with what went in, and compressible, so RAR really compresses it (method != stored).
const payload = (size = 150000, seed = 7) => {
  const out = Buffer.alloc(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = 65 + ((x >>> 16) & 7);
  }

  return out;
};

module.exports = { payload };

if (require.main === module) {
  // node payload.js <out dir>: writes movie.mkv, movie.nfo and subs.srt for make-fixtures.ps1
  const fs = require('fs');
  const path = require('path');
  const dir = process.argv[2];
  fs.writeFileSync(path.join(dir, 'movie.mkv'), payload());
  fs.writeFileSync(path.join(dir, 'movie.nfo'), 'nfo text');
  fs.writeFileSync(path.join(dir, 'movie.srt'), payload(3000, 99));
}
