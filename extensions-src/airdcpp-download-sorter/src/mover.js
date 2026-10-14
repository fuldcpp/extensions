'use strict';

// Moves a finished release (a folder or a single file) into a destination folder, never
// overwriting anything.
// - Same drive: one rename.
// - Another drive: copy into "<name>.sorter-partial", compare every file size, rename to the
//   final name, and only then delete the original. Until that rename nothing at the
//   destination carries the real name, so an interrupted copy can never pass for a finished one.

const fsp = require('fs/promises');
const path = require('path');

const PARTIAL_SUFFIX = '.sorter-partial';

const exists = async (p) => {
  try {
    await fsp.lstat(p);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') {
      return false;
    }

    throw e;
  }
};

const fail = (code, message) => Object.assign(new Error(message), { code });

// Every regular file below `root` (or root itself when it is a file) as paths relative to root's
// parent, and whether anything else (links, junctions, devices) was seen
const listFiles = async (root) => {
  const stat = await fsp.lstat(root);
  if (stat.isFile()) {
    return { files: [ { rel: path.basename(root), size: stat.size } ], special: false };
  }

  if (!stat.isDirectory()) {
    return { files: [], special: true };
  }

  const files = [];
  let special = false;
  const walk = async (dir, rel) => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const r = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        await walk(full, r);
      } else if (entry.isFile()) {
        files.push({ rel: r, size: (await fsp.lstat(full)).size });
      } else {
        special = true;
      }
    }
  };

  await walk(root, path.basename(root));
  return { files, special };
};

const copyTree = async (src, dst, copyFile) => {
  const stat = await fsp.lstat(src);
  if (stat.isDirectory()) {
    await fsp.mkdir(dst);
    for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
      await copyTree(path.join(src, entry.name), path.join(dst, entry.name), copyFile);
    }
  } else {
    // COPYFILE_EXCL: never overwrite
    await copyFile(src, dst, 1);
  }

  // Keep the modification time: whatever the hash rename does not cover is not rehashed
  await fsp.utimes(dst, stat.atime, stat.mtime);
};

// Moves `source` into `destinationDir`.
// Resolves { target, files: [{ from, to, size }], crossDevice, leftovers } once the release is
// complete at the destination. `leftovers` is non-empty when the original could not be fully
// deleted after a cross-drive copy (a file still open for an upload): the move itself counts.
// Rejects only while the original is still complete and nothing carries the final name.
const moveInto = async (source, destinationDir, { renameImpl = fsp.rename, copyFileImpl = fsp.copyFile, removeSourceImpl = (p) => fsp.rm(p, { recursive: true, force: true }) } = {}) => {
  const base = path.basename(source);
  if (/[. ]$/.test(base)) {
    // Windows hides trailing dots and spaces: the path Node sees could be a different folder
    throw fail('EBADNAME', `${base} ends with a dot or a space`);
  }

  const target = path.join(destinationDir, base);
  if (await exists(target)) {
    throw fail('EEXIST', `${target} already exists`);
  }

  const { files: listed, special } = await listFiles(source);
  const files = listed.map((f) => ({
    from: path.join(path.dirname(source), f.rel),
    to: path.join(destinationDir, f.rel),
    size: f.size,
  }));

  await fsp.mkdir(destinationDir, { recursive: true });

  try {
    await renameImpl(source, target);
    return { target, files, crossDevice: false, leftovers: [] };
  } catch (e) {
    if (e.code !== 'EXDEV') {
      throw e;
    }
  }

  // Another drive
  if (special) {
    throw fail('ESPECIAL', `${base} contains links or other special entries; not moved to another drive`);
  }

  const partial = target + PARTIAL_SUFFIX;
  await fsp.rm(partial, { recursive: true, force: true });
  try {
    await copyTree(source, partial, copyFileImpl);
    const copied = (await listFiles(partial)).files;
    const rel = (r) => path.join(base, ...r.split(path.sep).slice(1));
    const want = new Map(listed.map((f) => [ f.rel, f.size ]));
    const got = new Map(copied.map((f) => [ rel(f.rel), f.size ]));
    if (want.size !== got.size || [ ...want ].some(([ r, size ]) => got.get(r) !== size)) {
      throw fail('EVERIFY', 'the copy does not match the original');
    }

    if (await exists(target)) {
      throw fail('EEXIST', `${target} appeared during the copy`);
    }

    await fsp.rename(partial, target);
  } catch (e) {
    await fsp.rm(partial, { recursive: true, force: true }).catch(() => {});
    throw e;
  }

  // Committed: the release is complete at the destination. A failure from here on leaves
  // extra files behind, never a missing one.
  let leftovers = [];
  try {
    await removeSourceImpl(source);
  } catch (e) {
    try {
      leftovers = (await exists(source)) ? (await listFiles(source)).files.map((f) => path.join(path.dirname(source), f.rel)) : [];
    } catch (listError) {
      leftovers = [ source ];
    }
  }

  return { target, files, crossDevice: true, leftovers };
};

module.exports = { moveInto, listFiles, exists, PARTIAL_SUFFIX };
