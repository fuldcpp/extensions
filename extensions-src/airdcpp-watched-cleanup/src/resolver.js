'use strict';

// Finds the real file behind a media server item.
//
// The media server never sends a real path (JellyfinApi.cpp:6286-6295 sends "fuldc:/<id>/<name>").
// But every item id IS the path: the first 16 bytes of the Tiger hash of the lower-cased real path
// (MediaLibrary.cpp:1183 idForPath -> ValueGenerator.cpp:68 generatePathId), and the share API
// sends the same hash, whole, as the "id" of every directory and file it lists (ShareApi.cpp:187,
// 206). So the item is found by walking its ancestor chain (GET /Items/{id}/Ancestors,
// JellyfinApi.cpp:18273: the item's own folder, then each folder up to the library root -- an
// episode's or a film's parentId still names its folder, MediaCatalog.cpp:1996) down through the
// share listing (share/directories/by_real/content, ShareApi.cpp:317), matching ids at each level.
// Nothing is guessed from names: an item whose ids do not all match is not resolved.

const { base32ToHex16, normId } = require('./decide');

const PAGE = 500;
const MAX_ENTRIES = 20000;

const createResolver = ({ jellyfin, socket, rootsById, libraryRootIds }) => {
  const listings = new Map(); // folder path -> [{ hex, path, isDir, size, name }]

  const list = async (folder) => {
    if (listings.has(folder)) return listings.get(folder);
    const all = [];
    for (let start = 0; start < MAX_ENTRIES; start += PAGE) {
      let page;
      try {
        page = await socket.post(`share/directories/by_real/content/${start}/${PAGE}`, { path: folder });
      } catch (error) {
        // "Invalid range" past the end of a listing that is an exact multiple of the page
        if (start > 0) break;
        throw error;
      }

      if (!Array.isArray(page)) break;
      for (const e of page) {
        if (!e || typeof e.path !== 'string') continue;
        const isDir = (e.type && e.type.id === 'directory') || /[\\/]$/.test(e.path);
        all.push({ hex: base32ToHex16(e.id), path: e.path, isDir, size: Number(e.size) || 0, name: e.name });
      }

      if (page.length < PAGE) break;
    }

    listings.set(folder, all);
    return all;
  };

  // -> { path, root, shareSize } or { reason }
  const resolve = async (item) => {
    const id = normId(item.Id);
    let chain;
    try {
      chain = await jellyfin.get(`/Items/${encodeURIComponent(id)}/Ancestors`);
    } catch (error) {
      return { reason: `could not read its folders (${error.status || 'no answer'})` };
    }

    if (!Array.isArray(chain) || chain.length === 0) {
      return { reason: 'not a file in a shared folder' };
    }

    const top = normId(chain[chain.length - 1].Id);
    const root = rootsById.get(top);
    if (!root || !libraryRootIds.has(top)) {
      return { reason: 'not under a shared media library folder' };
    }

    let folder = root;
    for (let i = chain.length - 2; i >= 0; i--) {
      const want = normId(chain[i].Id);
      const next = (await list(folder)).find((e) => e.isDir && e.hex === want);
      if (!next) {
        return { reason: 'its folder is no longer in the share (refresh pending?)' };
      }

      folder = next.path;
    }

    const file = (await list(folder)).find((e) => !e.isDir && e.hex === id);
    if (!file) {
      // A disc structure or a multi-part set is identified by a file deeper down: left alone
      return { reason: 'not a single file in its folder (disc or multi-part)' };
    }

    return { path: file.path, root, shareSize: file.size };
  };

  return { resolve };
};

module.exports = { createResolver };
