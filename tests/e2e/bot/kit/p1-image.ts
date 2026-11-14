import { deflateSync } from "node:zlib";

const DIGITS = [
  ["11111","10001","10001","10001","10001","10001","11111"],
  ["00100","01100","00100","00100","00100","00100","01110"],
  ["11111","00001","00001","11111","10000","10000","11111"],
  ["11111","00001","00001","11111","00001","00001","11111"],
  ["10001","10001","10001","11111","00001","00001","00001"],
  ["11111","10000","10000","11111","00001","00001","11111"],
  ["11111","10000","10000","11111","10001","10001","11111"],
  ["11111","00001","00001","00010","00100","00100","00100"],
  ["11111","10001","10001","11111","10001","10001","11111"],
  ["11111","10001","10001","11111","00001","00001","11111"],
];

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name: string, data: Uint8Array): Buffer {
  const type = Buffer.from(name);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  type.copy(result, 4); Buffer.from(data).copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, result.length - 4)), result.length - 4);
  return result;
}

/** A real raster fixture: the random code occurs only in its pixels, never PNG metadata. */
export function proofPng(code: string, recoveryCode?: string): Buffer {
  const codes = recoveryCode === undefined ? [code] : [code, recoveryCode];
  if (codes.some((value) => !/^\d{5}$/.test(value))) throw new Error("The raster proof must contain five decimal digits.");
  const scale = 12, margin = 24, spacing = 12, rowSpacing = 48;
  const width = margin * 2 + code.length * 5 * scale + (code.length - 1) * spacing;
  const height = margin * 2 + codes.length * 7 * scale + (codes.length - 1) * rowSpacing;
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(height * stride, 255);
  for (let y = 0; y < height; y++) raw[y * stride] = 0;
  for (let row = 0; row < codes.length; row++) for (let index = 0; index < code.length; index++) {
    const digit = DIGITS[Number(codes[row]![index])]!;
    for (let y = 0; y < 7; y++) for (let x = 0; x < 5; x++) if (digit[y]![x] === "1") {
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const at = (margin + row * (7 * scale + rowSpacing) + y * scale + dy) * stride + 1 + (margin + index * (5 * scale + spacing) + x * scale + dx) * 3;
        raw.fill(0, at, at + 3);
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
