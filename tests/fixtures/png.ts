import { deflateSync } from "node:zlib";
export function pngChunk(kind: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(kind), data]); let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  const size = Buffer.alloc(4), tail = Buffer.alloc(4); size.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, body, tail]);
}
export function testPng(): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(390); header.writeUInt32BE(200, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", header), pngChunk("tEXt", Buffer.from("Description\0Synthetic private metadata")), pngChunk("IDAT", deflateSync(Buffer.alloc(200 * (390 * 3 + 1)))), pngChunk("IEND", Buffer.alloc(0))]);
}
