'use strict';

// After webpack: puts the decoders' WASM files (and the 7-Zip glue, kept as its own replaceable
// file because it is LGPL) beside the bundle in dist/vendor, with their licence texts. The
// client installs the tarball without npm install, so everything has to be in dist/.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const vendor = path.join(root, 'dist', 'vendor');
const sevenOut = path.join(vendor, '7z-wasm');
fs.mkdirSync(sevenOut, { recursive: true });

const unrarDir = path.dirname(require.resolve('node-unrar-js/package.json', { paths: [ root ] }));
const sevenDir = path.dirname(require.resolve('7z-wasm/package.json', { paths: [ root ] }));

const copies = [
  [ path.join(unrarDir, 'dist', 'js', 'unrar.wasm'), path.join(vendor, 'unrar.wasm') ],
  [ path.join(unrarDir, 'LICENSE.md'), path.join(vendor, 'node-unrar-js-LICENSE.md') ],
  [ path.join(sevenDir, '7zz.umd.js'), path.join(sevenOut, '7zz.umd.js') ],
  [ path.join(sevenDir, '7zz.wasm'), path.join(sevenOut, '7zz.wasm') ],
  [ path.join(sevenDir, 'License.txt'), path.join(sevenOut, 'License.txt') ],
  [ path.join(sevenDir, 'unRarLicense.txt'), path.join(sevenOut, 'unRarLicense.txt') ],
];

for (const [ from, to ] of copies) {
  fs.copyFileSync(from, to);
}

// A pointer to the sources, which the LGPL asks for
fs.writeFileSync(path.join(sevenOut, 'SOURCE.txt'), `7z-wasm ${require(path.join(sevenDir, 'package.json')).version}: 7-Zip compiled to WASM.\nSource: https://github.com/use-strict/7z-wasm (7-Zip sources: https://www.7-zip.org/)\nThese two files are loaded as they are and can be replaced by another build of the same version.\n`);
console.log(`copied ${copies.length} vendor files to ${path.relative(root, vendor)}`);
