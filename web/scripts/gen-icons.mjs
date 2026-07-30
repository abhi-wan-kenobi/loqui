#!/usr/bin/env node
// Generates the PWA icon set (192, 512, apple-touch 180) as a simple
// violet-to-indigo glowing orb on near-black, matching the app's design
// language. Zero npm dependencies — hand-rolls a PNG encoder on top of
// Node's built-in zlib deflate so this stays a "keep it simple" script
// rather than pulling in sharp/canvas.

import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const OUT_DIR = fileURLToPath(new URL("../public/icons/", import.meta.url));

const BG = [10, 12, 19]; // #0A0C13
const VIOLET = [139, 92, 246]; // #8B5CF6
const INDIGO = [99, 102, 241]; // #6366F1

let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw);

  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp8 = (v) => Math.max(0, Math.min(255, Math.round(v)));

function renderOrb(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const maxR = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy) / maxR; // 0 at center, 1 at edge
      const t = Math.min(1, dist);
      const glow = Math.max(0, 1 - dist * 1.15);

      const r = lerp(VIOLET[0], INDIGO[0], t);
      const g = lerp(VIOLET[1], INDIGO[1], t);
      const b = lerp(VIOLET[2], INDIGO[2], t);

      const idx = (y * size + x) * 4;
      rgba[idx] = clamp8(lerp(BG[0], r, glow));
      rgba[idx + 1] = clamp8(lerp(BG[1], g, glow));
      rgba[idx + 2] = clamp8(lerp(BG[2], b, glow));
      rgba[idx + 3] = 255;
    }
  }
  return rgba;
}

mkdirSync(OUT_DIR, { recursive: true });

for (const size of [192, 512]) {
  writeFileSync(`${OUT_DIR}icon-${size}.png`, encodePng(size, size, renderOrb(size)));
  console.log(`wrote icon-${size}.png`);
}

writeFileSync(`${OUT_DIR}apple-touch-icon.png`, encodePng(180, 180, renderOrb(180)));
console.log("wrote apple-touch-icon.png");
