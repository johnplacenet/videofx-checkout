import fs from "node:fs";
import path from "node:path";
import { deflateRawSync, crc32 } from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(root, "app");
export const downloadZipPath = path.join(root, "downloads", "VideoFX-Automator.zip");
const folder = "VideoFX Automator";

function zipEntries(dir, prefix) {
  const entries = [];
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name === ".node" || name === ".npm-cache" || name === ".chrome-profile" || name === "uploads") continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    const rel = `${prefix}/${name}`;
    if (stat.isDirectory()) {
      entries.push({ name: `${rel}/`, mode: 0o040755, data: Buffer.alloc(0) });
      entries.push(...zipEntries(full, rel));
      continue;
    }
    const mode = name.endsWith(".command") ? 0o100755 : 0o100644;
    entries.push({ name: rel, mode, data: fs.readFileSync(full) });
  }
  return entries;
}

function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

export function buildDownloads() {
  if (!fs.existsSync(appDir)) return downloadZipPath;
  const entries = [{ name: `${folder}/`, mode: 0o040755, data: Buffer.alloc(0) }, ...zipEntries(appDir, folder)];
  const stamp = dosTime(new Date());
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = entry.data.length ? deflateRawSync(entry.data) : Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(entry.data.length ? 8 : 0, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.day, 12);
    local.writeUInt32LE(crc32(entry.data) >>> 0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, compressed);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE((3 << 8) | 20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(entry.data.length ? 8 : 0, 10);
    header.writeUInt16LE(stamp.time, 12);
    header.writeUInt16LE(stamp.day, 14);
    header.writeUInt32LE(crc32(entry.data) >>> 0, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE((entry.mode << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  fs.mkdirSync(path.dirname(downloadZipPath), { recursive: true });
  fs.writeFileSync(downloadZipPath, Buffer.concat([...parts, centralBuf, end]));
  return downloadZipPath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = buildDownloads();
  console.log(file);
}
