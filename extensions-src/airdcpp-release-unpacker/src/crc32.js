'use strict';

// CRC-32 (the one in RAR, ZIP and 7z headers), incremental. Node 20.15+/22.2+ has zlib.crc32
// in native code; older Nodes use the table version.

const zlib = require('zlib');

let table = null;
const makeTable = () => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c;
  }
  return t;
};

const crc32Js = (buf, prev = 0) => {
  table = table || makeTable();
  let c = (prev ^ -1) | 0;
  for (let i = 0; i < buf.length; i++) {
    c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
};

const crc32 = typeof zlib.crc32 === 'function' ? (buf, prev = 0) => zlib.crc32(buf, prev) >>> 0 : crc32Js;

module.exports = { crc32, crc32Js };
