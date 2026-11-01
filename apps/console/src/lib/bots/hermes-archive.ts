import { Gunzip, Unzip, UnzipInflate } from "fflate";
import { HermesArchiveError, HermesTarReader } from "@openedbot/portability/domain/archive/tar";
import { hermesArchiveDropReason, normalizeHermesArchivePath, type HermesArchiveDrop, type HermesArchiveEntry } from "@openedbot/portability/domain/hermes-profile-bundle";

export { HermesArchiveError };
const COMPRESSED_LIMIT = 32 * 1024 * 1024;
const EXTRACTED_LIMIT = 64 * 1024 * 1024;
const FILE_LIMIT = 1024 * 1024;
// Bound work before every ondata check: never push the entire compressed bomb.
const INPUT_CHUNK = 1024;

export async function readHermesArchive(file: File): Promise<{ entries: HermesArchiveEntry[]; dropped: HermesArchiveDrop[] }> {
  if (file.size > COMPRESSED_LIMIT) throw new HermesArchiveError("too-large");
  const compressed = new Uint8Array(await file.arrayBuffer());
  if (compressed.length > COMPRESSED_LIMIT) throw new HermesArchiveError("too-large");
  const entries: HermesArchiveEntry[] = [];
  const dropped: HermesArchiveDrop[] = [];
  let produced = 0;
  const consume = (bytes: Uint8Array) => {
    produced += bytes.byteLength;
    if (produced > EXTRACTED_LIMIT) throw new HermesArchiveError("too-large");
  };
  const accept = (entry: HermesArchiveEntry, tooLarge = false) => {
    const path = normalizeHermesArchivePath(entry.path);
    const reason = !path ? "path-invalid" : entry.type === "symlink" ? "symlink" : hermesArchiveDropReason(path) ?? (tooLarge ? "too-large" : null);
    if (reason) dropped.push({ path: entry.path, reason });
    else entries.push({ ...entry, path: path! });
  };
  try {
    if (/\.(tgz|tar\.gz)$/i.test(file.name) && compressed[0] === 31 && compressed[1] === 139) {
      const tar = new HermesTarReader(accept);
      let crc = 0xffffffff;
      let complete = false;
      const gunzip = new Gunzip((chunk, final) => { consume(chunk); crc = updateCrc(crc, chunk); tar.push(chunk, final); complete = final; });
      for (let offset = 0; offset < compressed.length; offset += INPUT_CHUNK) {
        gunzip.push(compressed.subarray(offset, offset + INPUT_CHUNK), offset + INPUT_CHUNK >= compressed.length);
        if (offset % (256 * INPUT_CHUNK) === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      if (!complete || compressed.length < 18) throw new HermesArchiveError("truncated");
      const trailer = new DataView(compressed.buffer, compressed.byteOffset + compressed.length - 8, 8);
      if (trailer.getUint32(0, true) !== ((crc ^ 0xffffffff) >>> 0) || trailer.getUint32(4, true) !== produced) throw new HermesArchiveError("invalid");
    } else if (/\.zip$/i.test(file.name) && compressed[0] === 80 && compressed[1] === 75) {
      const index = zipIndex(compressed);
      let count = 0; let complete = 0;
      let failure: unknown;
      const unzip = new Unzip((entry) => {
        const meta = index[count++];
        if (!meta || meta.name !== entry.name || count > 4000 || meta.compression !== entry.compression) throw new HermesArchiveError("invalid");
        const parts: Uint8Array[] = [];
        let size = 0; let crc = 0xffffffff;
        entry.ondata = (error, chunk, final) => {
          if (error) { failure = error; entry.terminate(); return; }
          try {
            consume(chunk); size += chunk.length; crc = updateCrc(crc, chunk);
            if (size <= FILE_LIMIT) parts.push(chunk.slice()); else parts.length = 0;
            if (final) {
              complete++;
              if (size !== meta.size || ((crc ^ 0xffffffff) >>> 0) !== meta.crc) throw new HermesArchiveError("invalid");
              const bytes = new Uint8Array(size <= FILE_LIMIT ? size : 0);
              let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
              accept({ path: entry.name, type: meta.type, bytes }, size > FILE_LIMIT);
            }
          } catch (error) { failure = error; entry.terminate(); }
        };
        entry.start();
      });
      unzip.register(UnzipInflate);
      for (let offset = 0; offset < compressed.length; offset += INPUT_CHUNK) {
        unzip.push(compressed.subarray(offset, offset + INPUT_CHUNK), offset + INPUT_CHUNK >= compressed.length);
        if (failure) throw failure;
        if (offset % (256 * INPUT_CHUNK) === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      if (complete !== index.length || count !== index.length) throw new HermesArchiveError("truncated");
    } else throw new HermesArchiveError("unsupported");
  } catch (error) {
    if (error instanceof HermesArchiveError) throw error;
    throw new HermesArchiveError("invalid");
  }
  return { entries, dropped };
}

type ZipIndexEntry = { crc: number; name: string; size: number; offset: number; compression: number; type: HermesArchiveEntry["type"] };
/** Central and local headers must agree. Unix link attributes never reach fflate's stream API. */
function zipIndex(bytes: Uint8Array): ZipIndexEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);
  let end = -1;
  for (let pos = bytes.length - 22; pos >= Math.max(0, bytes.length - 65557); pos--) {
    if (u32(pos) === 0x06054b50 && pos + 22 + u16(pos + 20) === bytes.length) { end = pos; break; }
  }
  if (end < 0) throw new HermesArchiveError("truncated");
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10)) throw new HermesArchiveError("unsupported");
  const count = u16(end + 10), length = u32(end + 12), start = u32(end + 16);
  if (count === 65535 || length === 0xffffffff || start === 0xffffffff) throw new HermesArchiveError("unsupported");
  if (count > 4000) throw new HermesArchiveError("too-large");
  if (start + length !== end) throw new HermesArchiveError("invalid");
  let pos = start;
  const entries: ZipIndexEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || u32(pos) !== 0x02014b50) throw new HermesArchiveError("truncated");
    const flags = u16(pos + 8), compression = u16(pos + 10), size = u32(pos + 24), packed = u32(pos + 20);
    const nameLength = u16(pos + 28), extraLength = u16(pos + 30), commentLength = u16(pos + 32), offset = u32(pos + 42);
    if (flags & ~0x080e || ![0, 8].includes(compression) || size === 0xffffffff || packed === 0xffffffff || offset === 0xffffffff || u16(pos + 34)) throw new HermesArchiveError("unsupported");
    if (pos + 46 + nameLength + extraLength + commentLength > end || offset + 30 > start || u32(offset) !== 0x04034b50) throw new HermesArchiveError("invalid");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(pos + 46, pos + 46 + nameLength));
    const localNameLength = u16(offset + 26), localExtra = u16(offset + 28);
    const localName = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset + 30, offset + 30 + localNameLength));
    if (localName !== name || u16(offset + 8) !== compression || u16(offset + 6) !== flags || offset + 30 + localNameLength + localExtra + packed > start) throw new HermesArchiveError("invalid");
    if (!(flags & 8) && (u32(offset + 18) !== packed || u32(offset + 22) !== size || u32(offset + 14) !== u32(pos + 16))) throw new HermesArchiveError("invalid");
    for (const [extraStart, extraEnd] of [[pos + 46 + nameLength, pos + 46 + nameLength + extraLength], [offset + 30 + localNameLength, offset + 30 + localNameLength + localExtra]]) {
      let extra = extraStart!;
      while (extra < extraEnd!) {
        if (extra + 4 > extraEnd!) throw new HermesArchiveError("invalid");
        if (u16(extra) === 1) throw new HermesArchiveError("unsupported");
        extra += 4 + u16(extra + 2);
        if (extra > extraEnd!) throw new HermesArchiveError("invalid");
      }
    }
    const unixMode = u32(pos + 38) >>> 16;
    entries.push({ crc: u32(pos + 16), name, size, offset, compression, type: (unixMode & 0xf000) === 0xa000 ? "symlink" : name.endsWith("/") || (unixMode & 0xf000) === 0x4000 ? "directory" : (unixMode & 0xf000) && (unixMode & 0xf000) !== 0x8000 ? "unsupported" : "file" });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  if (pos !== end) throw new HermesArchiveError("invalid");
  return entries.sort((a, b) => a.offset - b.offset);
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function updateCrc(crc: number, bytes: Uint8Array): number {
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return crc;
}
