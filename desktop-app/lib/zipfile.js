"use strict";
/**
 * Zip, both ways, in about a hundred lines.
 *
 * Folder saves (3DS, Wii U, Switch, PSP, Vita) travel as a single .zip, so the
 * desktop app has to write one when it commits and read one back when it
 * restores. Everything Save Station makes is a plain, flat zip of a save
 * folder's contents, so there's no reason to pull in a dependency for it.
 *
 * Reading is the forgiving half: it accepts stored *and* deflated entries,
 * because the website writes uncompressed zips from the browser and the Python
 * app writes deflated ones, and a save should restore whichever made it.
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

/** Every file under `dir`, as { rel, full }, sorted so a zip of it is stable. */
function walkFiles(dir) {
  const out = [];
  const walk = (cur, prefix) => {
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      const rel = prefix ? prefix + "/" + entry.name : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) out.push({ rel, full });
    }
  };
  walk(dir, "");
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** Zip a folder's *contents* (not the folder itself) into a Buffer. */
function zipFolder(dir) {
  const files = walkFiles(dir);
  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const raw = fs.readFileSync(f.full);
    const deflated = zlib.deflateRawSync(raw, { level: 6 });
    // Only worth compressing if it actually got smaller — some saves are
    // already packed, and deflate would just add bytes.
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const name = Buffer.from(f.rel, "utf8");
    const crc = crc32(raw);
    const { time, date } = dosDateTime(new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);              // version made by
    cen.writeUInt16LE(20, 6);              // version needed
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);

    offset += local.length + name.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([Buffer.concat(parts), centralBuf, end]);
}

/**
 * Unpack a zip into `destDir`. Returns the file names written.
 *
 * Entry names are treated as hostile: anything climbing out of destDir with
 * `..` or an absolute path is skipped rather than followed. A save file has no
 * business writing outside the folder you pointed at.
 */
function unzipTo(buffer, destDir) {
  // Find the end-of-central-directory record, scanning back from the tail.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66000; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file");

  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  const written = [];

  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error("zip central directory is damaged");
    const method = buffer.readUInt16LE(p + 10);
    const compSize = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOff = buffer.readUInt32LE(p + 42);
    const name = buffer.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (!name || name.endsWith("/")) continue;                 // a directory entry
    const safe = name.replace(/\\/g, "/").split("/").filter((s) => s && s !== "." && s !== "..");
    if (!safe.length || /^[a-zA-Z]:/.test(name) || name.startsWith("/")) continue;

    // The local header repeats the name and extra length, and only it is
    // trustworthy for where the data actually starts.
    const lNameLen = buffer.readUInt16LE(localOff + 26);
    const lExtraLen = buffer.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buffer.subarray(start, start + compSize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);

    const dest = path.join(destDir, ...safe);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    written.push(safe.join("/"));
  }
  return written;
}

module.exports = { zipFolder, unzipTo, walkFiles, crc32 };
