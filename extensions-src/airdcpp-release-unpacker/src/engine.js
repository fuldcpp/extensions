'use strict';

// Lists and unpacks one archive set. Runs inside a worker thread (worker.js): the decoders are
// synchronous and a big set takes minutes, which must not stall the extension's socket.
//
// RAR: node-unrar-js (the unRAR library compiled to WASM). Its file mode reads the volumes and
// writes the output through plain fs calls in small blocks, so memory stays flat whatever the
// size (measured: a 5 GiB entry unpacked with ~100 MB RSS). Every write passes through here,
// which computes the CRC-32 and the size of each file as it is written.
//
// ZIP and 7z: 7z-wasm (7-Zip compiled to WASM) on Emscripten's NODEFS, which maps file calls to
// the real disk, again in blocks. 7-Zip checks the CRC itself; here every file is read back and
// its size and CRC compared with the listing as well.

const fs = require('fs');
const path = require('path');

const { crc32 } = require('./crc32');
const { safeRelativePath } = require('./plan');

const PROGRESS_STEP = 64 * 1024 * 1024;

class EngineError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason; // encrypted | missing_volume | damaged | disk_full | unsafe_name | unsupported | failed
  }
}

// The output file for an entry, refused when it would land outside the output folder
const outputPathOf = (outDir, entryName) => {
  const rel = safeRelativePath(entryName);
  if (!rel) {
    throw new EngineError('unsafe_name', `unsafe file name in the archive: ${entryName}`);
  }

  const full = path.join(outDir, rel);
  const rootWithSep = outDir.endsWith(path.sep) ? outDir : outDir + path.sep;
  if (!full.startsWith(rootWithSep)) {
    throw new EngineError('unsafe_name', `unsafe file name in the archive: ${entryName}`);
  }

  return { rel, full };
};

// ---------------------------------------------------------------------------------------------
// RAR

const loadUnrar = (vendor) => {
  // The library itself is bundled; its WASM is read from the file shipped beside the bundle
  // The CommonJS entry by name: webpack would pick the package's browser ESM build (no file mode)
  const { createExtractorFromFile } = require('node-unrar-js/dist/index.js');
  const wasmBinary = fs.readFileSync(vendor.unrarWasm);
  return (options) => createExtractorFromFile({ wasmBinary: wasmBinary.buffer.slice(wasmBinary.byteOffset, wasmBinary.byteOffset + wasmBinary.byteLength), ...options });
};

const rarErrorOf = (error) => {
  const reason = error && error.reason;
  if (reason === 'ERAR_MISSING_PASSWORD' || reason === 'ERAR_BAD_PASSWORD') {
    return new EngineError('encrypted', 'the archive is password protected');
  }

  if (error && error.code === 'ENOENT') {
    return new EngineError('missing_volume', `a volume is missing (${path.basename(error.path || '')})`);
  }

  if (error && (error.code === 'ENOSPC' || reason === 'ERAR_EWRITE')) {
    return new EngineError('disk_full', 'the disk is full');
  }

  if (reason === 'ERAR_EOPEN') {
    return new EngineError('missing_volume', 'a volume could not be opened');
  }

  if (reason === 'ERAR_BAD_DATA' || reason === 'ERAR_BAD_ARCHIVE' || reason === 'ERAR_UNKNOWN_FORMAT') {
    return new EngineError('damaged', `the archive is damaged (${reason})`);
  }

  if (error instanceof EngineError) {
    return error;
  }

  return new EngineError('failed', (error && (error.message || error.code || error.reason)) || String(error));
};

const listRar = async ({ dir, first, vendor }) => {
  const create = loadUnrar(vendor);
  try {
    const extractor = await create({ filepath: path.join(dir, first) });
    const list = extractor.getFileList();
    // In a volume set the header read here is the FIRST part's, and its CRC covers only the
    // bytes in that volume; the whole file's CRC is in the last part's header. unRAR checks
    // that itself at the end (a bad byte in any volume fails with ERAR_BAD_DATA), so here the
    // own CRC is compared only for a single-volume archive.
    const volume = !!list.arcHeader.flags.volume;
    const entries = [];
    for (const h of list.fileHeaders) {
      entries.push({
        name: h.name,
        size: h.unpSize,
        crc: volume ? 0 : h.crc >>> 0,
        stored: h.method === 'Storing',
        encrypted: h.flags.encrypted,
        directory: h.flags.directory,
      });
    }

    return { encrypted: list.arcHeader.flags.headerEncrypted, entries };
  } catch (error) {
    throw rarErrorOf(error);
  }
};

const extractRar = async ({ dir, first, outDir, files, vendor, onProgress }) => {
  const create = loadUnrar(vendor);
  const wanted = new Map(files.map((f) => [ f.name, f ]));
  const written = new Map(); // entry name -> { full, rel, size, crc }
  let total = 0;
  let nextReport = PROGRESS_STEP;

  try {
    const extractor = await create({ filepath: path.join(dir, first), targetPath: outDir });
    const fds = new Map(); // fd -> record

    // The library's own create() joins the name to the target and opens with 'w' (overwrite);
    // replaced: a checked name, and 'wx' so not even a file in our own temp folder is replaced
    extractor.create = function (filename) {
      const { full, rel } = outputPathOf(outDir, filename);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      const fd = fs.openSync(full, 'wx');
      const record = { full, rel, size: 0, crc: 0 };
      written.set(filename, record);
      fds.set(fd, record);
      this.fileMap[fd] = { size: 0, pos: 0, name: filename };
      return fd;
    };

    const baseWrite = extractor.write.bind(extractor);
    extractor.write = (fd, buf, size) => {
      const record = fds.get(fd);
      if (record) {
        const view = extractor.unrar.HEAPU8.subarray(buf, buf + size);
        record.crc = crc32(view, record.crc);
        record.size += size;
        total += size;
        if (total >= nextReport) {
          nextReport += PROGRESS_STEP;
          onProgress(total);
        }
      }

      return baseWrite(fd, buf, size);
    };

    const baseClose = extractor.closeFile.bind(extractor);
    extractor.closeFile = (fd) => {
      fds.delete(fd);
      baseClose(fd);
    };

    const { files: produced } = extractor.extract({ files: (header) => wanted.has(header.name) && !header.flags.directory });
    for (const item of produced) {
      void item; // each step unpacks one file; the checks follow below
    }
  } catch (error) {
    throw rarErrorOf(error);
  }

  return verifyWritten(files, (name) => written.get(name));
};

// Every wanted entry was written, with the size and CRC its header gives
const verifyWritten = (files, recordOf) => {
  const results = [];
  for (const f of files) {
    const record = recordOf(f.name);
    if (!record) {
      throw new EngineError('damaged', `${f.name} was not unpacked`);
    }

    if (record.size !== f.size) {
      throw new EngineError('damaged', `${f.name}: ${record.size} bytes unpacked, the archive says ${f.size}`);
    }

    // A RAR5 entry protected by BLAKE2 instead of CRC-32 lists crc 0: unRAR checked the hash
    if (f.crc && record.crc !== f.crc) {
      throw new EngineError('damaged', `${f.name}: CRC mismatch`);
    }

    results.push({ name: f.name, rel: record.rel, size: record.size });
  }

  return { results };
};

// ---------------------------------------------------------------------------------------------
// ZIP / 7z

// A password nobody uses: 7-Zip asks for one on the console otherwise, and a worker has none
const NO_PASSWORD = '-pfuldcpp-unpacker-no-password';

const run7z = async (vendor, mounts, args) => {
  // eslint-disable-next-line no-undef
  const nodeRequire = typeof __non_webpack_require__ === 'function' ? __non_webpack_require__ : module.require.bind(module);
  const SevenZip = nodeRequire(vendor.sevenZipJs);
  let output = '';
  const sz = await SevenZip({
    wasmBinary: fs.readFileSync(vendor.sevenZipWasm),
    print: (s) => { output += `${s}\n`; },
    printErr: (s) => { output += `${s}\n`; },
    stdin: () => null,
    quit: () => {},
  });

  for (const [ mountPoint, hostDir ] of mounts) {
    sz.FS.mkdir(mountPoint);
    sz.FS.mount(sz.NODEFS, { root: hostDir }, mountPoint);
  }

  // A write error on NODEFS reaches 7-Zip as a bare C++ exception: its output names no reason.
  // The file calls are watched instead, so a full disk is reported as one. (This runs in its
  // own worker thread, whose fs module no one else uses; restored in any case.)
  const baseWriteSync = fs.writeSync;
  let writeError = null;
  fs.writeSync = function (...writeArgs) {
    try {
      return baseWriteSync.apply(this, writeArgs);
    } catch (error) {
      writeError = writeError || (error && error.code) || 'EIO';
      throw error;
    }
  };

  let code;
  try {
    code = sz.callMain(args);
    if (code !== 0 && writeError) output += `${writeError}\n`;
  } catch (error) {
    if (writeError) output += `${writeError}\n`;
    if (error && typeof error.status === 'number') {
      code = error.status; // Emscripten's ExitStatus
    } else {
      const text = (error && (error.message || error.code)) || String(error);
      output += `${text}\n`;
      code = /ENOSPC/.test(text) ? 8 : 2;
    }
  } finally {
    fs.writeSync = baseWriteSync;
  }

  return { code: typeof code === 'number' ? code : 0, output };
};

const sevenErrorOf = (output) => {
  if (/wrong password|encrypted|can not open encrypted/i.test(output)) {
    return new EngineError('encrypted', 'the archive is password protected');
  }

  if (/missing volume|unexpected end of archive|can not open the file as archive.*\.(z\d\d|\d{3})/i.test(output)) {
    return new EngineError('missing_volume', 'a volume is missing');
  }

  if (/not enough space|no space left|ENOSPC/i.test(output)) {
    return new EngineError('disk_full', 'the disk is full');
  }

  if (/crc failed|data error|headers error|is not archive|can not open the file as archive/i.test(output)) {
    return new EngineError('damaged', 'the archive is damaged');
  }

  return new EngineError('failed', '7-Zip failed');
};

// "-slt" listing: blocks of "Key = Value", one per item, after a "----------" line
const parse7zListing = (output) => {
  const after = output.split(/^-{10}\s*$/m).slice(1).join('\n');
  const entries = [];
  let archiveEncrypted = false;
  for (const block of after.split(/\r?\n\s*\r?\n/)) {
    const fields = {};
    for (const line of block.split(/\r?\n/)) {
      const m = /^([^=]+?) = (.*)$/.exec(line);
      if (m) fields[m[1].trim()] = m[2];
    }

    if (!('Path' in fields)) continue;
    const method = fields.Method || '';
    entries.push({
      name: fields.Path,
      size: Number(fields.Size || 0),
      crc: fields.CRC ? parseInt(fields.CRC, 16) >>> 0 : 0,
      stored: /^(copy|store)$/i.test(method),
      encrypted: fields.Encrypted === '+' || /aes|zipcrypto/i.test(method),
      directory: fields.Folder === '+' || /D/.test((fields.Attributes || '').split(' ')[0]),
    });
    if (fields.Encrypted === '+') archiveEncrypted = true;
  }

  return { entries, archiveEncrypted };
};

const list7z = async ({ dir, first, vendor }) => {
  const { code, output } = await run7z(vendor, [ [ '/src', dir ] ], [ 'l', '-slt', '-sccUTF-8', NO_PASSWORD, `/src/${first}` ]);
  if (code !== 0) {
    throw sevenErrorOf(output);
  }

  const { entries, archiveEncrypted } = parse7zListing(output);
  return { encrypted: archiveEncrypted, entries };
};

const readCrc = (file) => {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(1024 * 1024);
  let crc = 0;
  let size = 0;
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      crc = crc32(buf.subarray(0, n), crc);
      size += n;
    }
  } finally {
    fs.closeSync(fd);
  }

  return { crc, size };
};

const extract7z = async ({ dir, first, outDir, files, vendor, onProgress }) => {
  const { code, output } = await run7z(vendor, [ [ '/src', dir ], [ '/out', outDir ] ], [ 'x', '-y', '-bd', '-sccUTF-8', NO_PASSWORD, '-aos', '-o/out', `/src/${first}` ]);
  if (code !== 0) {
    throw sevenErrorOf(output);
  }

  let total = 0;
  return verifyWritten(files, (name) => {
    const { full, rel } = outputPathOf(outDir, name);
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch (error) {
      return null;
    }

    // Only a plain file is ever moved into the release: never a link 7-Zip may have made
    if (!stat.isFile()) {
      throw new EngineError('unsafe_name', `${name} is not a plain file`);
    }

    const { crc, size } = readCrc(full);
    total += size;
    onProgress(total);
    return { full, rel, size, crc };
  });
};

// ---------------------------------------------------------------------------------------------

const listArchive = (job) => (job.kind === 'rar' ? listRar(job) : list7z(job));
const extractArchive = (job) => (job.kind === 'rar' ? extractRar(job) : extract7z(job));

module.exports = { listArchive, extractArchive, EngineError, parse7zListing, outputPathOf, verifyWritten };
