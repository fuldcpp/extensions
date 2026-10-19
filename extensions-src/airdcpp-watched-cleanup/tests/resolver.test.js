'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createResolver } = require('../src/resolver');

// 16 bytes of id + 8 more, base32: what the share API sends for a path id
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32 = (hex16) => {
  const buf = Buffer.concat([ Buffer.from(hex16, 'hex'), Buffer.alloc(8, 7) ]);
  let bits = 0; let value = 0; let out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return bits > 0 ? out + B32[(value << (5 - bits)) & 31] : out;
};
const hex = (n) => n.toString(16).padStart(32, '0');

const setup = ({ listings, chain, pageSize }) => {
  const posts = [];
  const socket = {
    post: async (url, body) => {
      posts.push(url);
      const [ start, count ] = url.split('/').slice(-2).map(Number);
      const all = listings[body.path] || [];
      if (all.length > 0 && start >= all.length) throw new Error('Invalid range');
      return all.slice(start, start + count);
    },
  };
  const jellyfin = { get: async () => chain };
  const resolver = createResolver({ jellyfin, socket, rootsById: new Map([ [ hex(1), 'D:\\Media\\' ] ]), libraryRootIds: new Set([ hex(1) ]), pageSize });
  return { resolver, posts };
};

const dir = (n, p) => ({ id: b32(hex(n)), path: p, type: { id: 'directory' } });
const file = (n, p, size = 10) => ({ id: b32(hex(n)), path: p, size, type: { id: 'file' } });

test('walks the ancestor chain down the share by id, ignoring names', async () => {
  const { resolver } = setup({
    chain: [ { Id: hex(3) }, { Id: hex(2) }, { Id: hex(1) } ],
    listings: {
      'D:\\Media\\': [ dir(9, 'D:\\Media\\Decoy\\'), dir(2, 'D:\\Media\\Films\\') ],
      'D:\\Media\\Films\\': [ dir(3, 'D:\\Media\\Films\\A\\') ],
      'D:\\Media\\Films\\A\\': [ file(5, 'D:\\Media\\Films\\A\\a.nfo'), file(4, 'D:\\Media\\Films\\A\\a.mkv', 99) ],
    },
  });
  assert.deepEqual(await resolver.resolve({ Id: hex(4) }), { path: 'D:\\Media\\Films\\A\\a.mkv', root: 'D:\\Media\\', shareSize: 99 });
});

test('anything that does not match all the way is not resolved', async () => {
  const listings = { 'D:\\Media\\': [ dir(2, 'D:\\Media\\Films\\') ], 'D:\\Media\\Films\\': [ file(8, 'D:\\Media\\Films\\x.mkv') ] };
  let t = setup({ chain: [ { Id: hex(2) }, { Id: hex(1) } ], listings });
  assert.match((await t.resolver.resolve({ Id: hex(4) })).reason, /not a single file/);
  t = setup({ chain: [ { Id: hex(7) }, { Id: hex(1) } ], listings });
  assert.match((await t.resolver.resolve({ Id: hex(4) })).reason, /no longer in the share/);
  t = setup({ chain: [ { Id: hex(2) }, { Id: hex(6) } ], listings });
  assert.match((await t.resolver.resolve({ Id: hex(8) })).reason, /not under a shared media library folder/);
  t = setup({ chain: [], listings });
  assert.match((await t.resolver.resolve({ Id: hex(8) })).reason, /not a file/);
});

test('long folders are read page by page, and each folder only once', async () => {
  const many = Array.from({ length: 1200 }, (_, i) => file(100 + i, `D:\\Media\\f${i}.mkv`));
  const t = setup({ chain: [ { Id: hex(1) } ], listings: { 'D:\\Media\\': many } });
  assert.equal((await t.resolver.resolve({ Id: hex(100 + 1100) })).path, 'D:\\Media\\f1100.mkv');
  assert.equal((await t.resolver.resolve({ Id: hex(100 + 5) })).path, 'D:\\Media\\f5.mkv');
  assert.deepEqual(t.posts, [ 'share/directories/by_real/content/0/500', 'share/directories/by_real/content/500/500', 'share/directories/by_real/content/1000/500' ]);
});
