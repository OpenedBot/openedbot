import type { HermesArchiveEntry } from "../hermes-profile-bundle";

export class HermesArchiveError extends Error {
  constructor(readonly code: "too-large" | "unsupported" | "truncated" | "invalid") {
    super(code); this.name = "HermesArchiveError";
  }
}

/** Incremental ustar reader. Every declared size must be satisfied by actual bytes. */
export class HermesTarReader {
  private buffer = new Uint8Array(0);
  private current: { path: string; size: number; left: number; padding: number; type: HermesArchiveEntry["type"]; parts: Uint8Array[]; retain: boolean } | null = null;
  private count = 0;
  private produced = 0;
  private zeroBlocks = 0;
  private ended = false;

  constructor(
    private readonly onEntry: (entry: HermesArchiveEntry, tooLarge: boolean) => void,
    private readonly limits = { entries: 4000, fileBytes: 1024 * 1024, totalBytes: 64 * 1024 * 1024 },
  ) {}

  push(chunk: Uint8Array, final = false): void {
    if (this.ended) throw new HermesArchiveError("invalid");
    this.produced += chunk.byteLength;
    if (this.produced > this.limits.totalBytes) throw new HermesArchiveError("too-large");
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer); merged.set(chunk, this.buffer.length);
    let offset = 0;
    while (offset < merged.length) {
      if (this.current) {
        const file = this.current;
        const take = Math.min(file.left, merged.length - offset);
        if (take && file.retain) file.parts.push(merged.slice(offset, offset + take));
        file.left -= take; offset += take;
        if (file.left) break;
        const padding = Math.min(file.padding, merged.length - offset);
        offset += padding; file.padding -= padding;
        if (file.padding) break;
        const bytes = new Uint8Array(file.retain ? file.size : 0);
        let index = 0; for (const part of file.parts) { bytes.set(part, index); index += part.length; }
        this.onEntry({ path: file.path, type: file.type, bytes }, !file.retain);
        this.current = null;
      } else {
        if (merged.length - offset < 512) break;
        const header = merged.subarray(offset, offset + 512); offset += 512;
        if (header.every((byte) => byte === 0)) { this.zeroBlocks++; continue; }
        if (this.zeroBlocks) throw new HermesArchiveError("invalid");
        if (++this.count > this.limits.entries) throw new HermesArchiveError("too-large");
        const checksum = octal(header.subarray(148, 156));
        let actual = 0;
        for (let i = 0; i < header.length; i++) actual += i >= 148 && i < 156 ? 32 : header[i]!;
        if (checksum !== actual || text(header.subarray(257, 263)) !== "ustar" || text(header.subarray(263, 265)) !== "00") throw new HermesArchiveError("invalid");
        const size = octal(header.subarray(124, 136));
        if (size > this.limits.totalBytes) throw new HermesArchiveError("too-large");
        const flag = header[156];
        const type: HermesArchiveEntry["type"] = flag === 0 || flag === 48 ? "file" : flag === 53 ? "directory" : flag === 49 || flag === 50 ? "symlink" : "unsupported";
        if (type === "unsupported") throw new HermesArchiveError("unsupported");
        const prefix = text(header.subarray(345, 500));
        const name = text(header.subarray(0, 100));
        this.current = {
          path: prefix ? `${prefix}/${name}` : name, type, size, left: size, padding: (512 - size % 512) % 512,
          parts: [], retain: size <= this.limits.fileBytes && type === "file",
        };
        // A zero-sized entry must be emitted even when its header ends this chunk.
        if (!size) {
          this.onEntry({ path: this.current.path, type, bytes: new Uint8Array() }, false);
          this.current = null;
        }
      }
    }
    this.buffer = merged.slice(offset);
    if (final) {
      if (this.current || this.buffer.length || this.zeroBlocks < 2) throw new HermesArchiveError("truncated");
      this.ended = true;
    }
  }
}

function text(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(end < 0 ? bytes : bytes.subarray(0, end)); }
  catch { throw new HermesArchiveError("invalid"); }
}
function octal(bytes: Uint8Array): number {
  const raw = text(bytes).trim();
  if (!/^[0-7]+$/.test(raw)) throw new HermesArchiveError("invalid");
  const number = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(number) || number < 0) throw new HermesArchiveError("invalid");
  return number;
}
