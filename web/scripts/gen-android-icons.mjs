#!/usr/bin/env node
// Generates Android launcher icons (legacy + round + adaptive foreground) and
// splash screens for the Capacitor android/ platform. Same violet-to-indigo
// glowing orb on near-black as the PWA icons (web/scripts/gen-icons.mjs),
// re-rendered at Android's required densities. Zero npm dependencies — same
// hand-rolled PNG encoder (Node's built-in zlib deflate) so this stays
// dependency-free like its PWA sibling (sharp is not installed).

import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const RES_DIR = fileURLToPath(new URL("../android/app/src/main/res/", import.meta.url));

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

// Renders the glowing orb into a `size`x`size` RGBA buffer.
//   opaqueBg   - true: solid BG fills every pixel (legacy square icon).
//                false: BG pixels are fully transparent (adaptive foreground).
//   circleMask - true: pixels outside the inscribed circle get alpha 0
//                (round launcher icon).
//   orbScale   - orb radius as a fraction of size/2 (lets the adaptive
//                foreground sit inside the safe zone so masks don't clip it).
function renderOrb(size, { opaqueBg = true, circleMask = false, orbScale = 1 } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const maxR = (size / 2) * orbScale;
  const circleR = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const distPx = Math.sqrt(dx * dx + dy * dy);
      const dist = distPx / maxR;
      const t = Math.min(1, dist);
      const glow = Math.max(0, 1 - dist * 1.15);

      const r = lerp(VIOLET[0], INDIGO[0], t);
      const g = lerp(VIOLET[1], INDIGO[1], t);
      const b = lerp(VIOLET[2], INDIGO[2], t);

      const idx = (y * size + x) * 4;
      if (opaqueBg) {
        rgba[idx] = clamp8(lerp(BG[0], r, glow));
        rgba[idx + 1] = clamp8(lerp(BG[1], g, glow));
        rgba[idx + 2] = clamp8(lerp(BG[2], b, glow));
        rgba[idx + 3] = 255;
      } else {
        rgba[idx] = clamp8(r);
        rgba[idx + 1] = clamp8(g);
        rgba[idx + 2] = clamp8(b);
        rgba[idx + 3] = clamp8(255 * glow);
      }

      if (circleMask && distPx > circleR) {
        rgba[idx + 3] = 0;
      }
    }
  }
  return rgba;
}

function renderSplash(width, height) {
  const rgba = Buffer.alloc(width * height * 4);
  const cx = width / 2;
  const cy = height / 2;
  const maxR = Math.min(width, height) * 0.22;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy) / maxR;
      const glow = Math.max(0, 1 - dist * 1.15);
      const t = Math.min(1, dist);

      const r = lerp(VIOLET[0], INDIGO[0], t);
      const g = lerp(VIOLET[1], INDIGO[1], t);
      const b = lerp(VIOLET[2], INDIGO[2], t);

      const idx = (y * width + x) * 4;
      rgba[idx] = clamp8(lerp(BG[0], r, glow));
      rgba[idx + 1] = clamp8(lerp(BG[1], g, glow));
      rgba[idx + 2] = clamp8(lerp(BG[2], b, glow));
      rgba[idx + 3] = 255;
    }
  }
  return rgba;
}

// legacy launcher size -> matching adaptive foreground size (2.25x, per the
// stock Capacitor android template: 48/108, 72/162, 96/216, 144/324, 192/432)
const DENSITIES = {
  mdpi: { legacy: 48, foreground: 108 },
  hdpi: { legacy: 72, foreground: 162 },
  xhdpi: { legacy: 96, foreground: 216 },
  xxhdpi: { legacy: 144, foreground: 324 },
  xxxhdpi: { legacy: 192, foreground: 432 },
};

for (const [density, { legacy, foreground }] of Object.entries(DENSITIES)) {
  const dir = `${RES_DIR}mipmap-${density}/`;

  writeFileSync(`${dir}ic_launcher.png`, encodePng(legacy, legacy, renderOrb(legacy, { opaqueBg: true })));
  writeFileSync(
    `${dir}ic_launcher_round.png`,
    encodePng(legacy, legacy, renderOrb(legacy, { opaqueBg: true, circleMask: true })),
  );
  writeFileSync(
    `${dir}ic_launcher_foreground.png`,
    encodePng(foreground, foreground, renderOrb(foreground, { opaqueBg: false, orbScale: 0.62 })),
  );
  console.log(`wrote mipmap-${density}/ic_launcher{,_round,_foreground}.png`);
}

// Splash screens: solid dark-navy background with a centered orb glow,
// matching each existing drawable-{port,land}-<density>/splash.png's
// dimensions so the layout capacitor-android already wired up is untouched.
const SPLASH_DIRS = {
  "drawable": [480, 320],
  "drawable-land-mdpi": [480, 320],
  "drawable-land-hdpi": [800, 480],
  "drawable-land-xhdpi": [1280, 720],
  "drawable-land-xxhdpi": [1600, 960],
  "drawable-land-xxxhdpi": [1920, 1280],
  "drawable-port-mdpi": [320, 480],
  "drawable-port-hdpi": [480, 800],
  "drawable-port-xhdpi": [720, 1280],
  "drawable-port-xxhdpi": [960, 1600],
  "drawable-port-xxxhdpi": [1280, 1920],
};

for (const [dir, [w, h]] of Object.entries(SPLASH_DIRS)) {
  writeFileSync(`${RES_DIR}${dir}/splash.png`, encodePng(w, h, renderSplash(w, h)));
  console.log(`wrote ${dir}/splash.png (${w}x${h})`);
}

console.log("done");
