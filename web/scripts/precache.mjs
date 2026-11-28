// Build-time glue for the service worker (public/sw.js).
//
// After `vite build`, `swPrecachePlugin` rewrites dist/sw.js with the list of
// files that make up this build and an id derived from their contents, so the
// worker's cache is replaced exactly when the app changes and never otherwise.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// The marker line in public/sw.js that this module replaces.
const BUILD_LINE = /^const BUILD = .*; \/\/ __BUILD__$/m;

// Not part of the app shell: source maps, the worker itself, and the VAD /
// onnxruntime runtime (large, rarely changes; the worker caches it on first use).
const EXCLUDED = (rel) => rel.endsWith(".map") || rel === "sw.js" || rel.startsWith("vad/");

/** Every file under `dir` that belongs in the shell cache, as sorted relative POSIX paths. */
export function listPrecache(dir) {
  const out = [];
  const walk = (sub) => {
    for (const entry of readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (!EXCLUDED(rel)) out.push(rel);
    }
  };
  walk("");
  return out.sort();
}

/** URLs the worker precaches: every shell file, plus "/" (the same document as index.html). */
export function precacheUrls(files) {
  return ["/", ...files.map((f) => `/${f}`)];
}

/** Short content hash over file names and bytes. */
export function buildId(dir, files) {
  const hash = createHash("sha256");
  for (const f of files) {
    hash.update(f);
    hash.update("\0");
    hash.update(readFileSync(path.join(dir, f)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

/** Return `source` with its BUILD line replaced; throws if the marker is missing. */
export function injectBuild(source, id, urls) {
  if (!BUILD_LINE.test(source)) throw new Error("sw.js: `const BUILD = ...; // __BUILD__` marker not found");
  return source.replace(BUILD_LINE, `const BUILD = ${JSON.stringify({ id, precache: urls })}; // __BUILD__`);
}

/** Vite plugin: stamp dist/sw.js once the bundle and public/ files are in place. */
export function swPrecachePlugin() {
  return {
    name: "loqui-sw-precache",
    apply: "build",
    writeBundle(options) {
      const dir = options.dir;
      const swPath = path.join(dir, "sw.js");
      const files = listPrecache(dir);
      writeFileSync(swPath, injectBuild(readFileSync(swPath, "utf8"), buildId(dir, files), precacheUrls(files)));
    },
  };
}
