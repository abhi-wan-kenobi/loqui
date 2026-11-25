import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildId, injectBuild, listPrecache, precacheUrls } from "./precache.mjs";

function dist(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "loqui-dist-"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

test("the shell is the app files, without maps, the worker itself or the VAD runtime", () => {
  const dir = dist({
    "index.html": "x",
    "sw.js": "x",
    "manifest.webmanifest": "x",
    "assets/index-1.js": "x",
    "assets/index-1.js.map": "x",
    "icons/icon-192.png": "x",
    "worklets/mic-processor.js": "x",
    "vad/ort-wasm-simd-threaded.wasm": "x",
  });
  const files = listPrecache(dir);
  assert.deepEqual(files, [
    "assets/index-1.js",
    "icons/icon-192.png",
    "index.html",
    "manifest.webmanifest",
    "worklets/mic-processor.js",
  ]);
  assert.deepEqual(precacheUrls(["index.html"]), ["/", "/index.html"]);
});

test("the build id follows content, so an unchanged build keeps its cache", () => {
  const a = dist({ "index.html": "one", "assets/a.js": "a" });
  const same = dist({ "index.html": "one", "assets/a.js": "a" });
  const changed = dist({ "index.html": "two", "assets/a.js": "a" });
  const idOf = (d) => buildId(d, listPrecache(d));
  assert.equal(idOf(a), idOf(same));
  assert.notEqual(idOf(a), idOf(changed));
});

test("injectBuild stamps the real worker and refuses a worker without the marker", () => {
  const sw = readFileSync(fileURLToPath(new URL("../public/sw.js", import.meta.url)), "utf8");
  const stamped = injectBuild(sw, "abc123", ["/", "/index.html"]);
  assert.match(stamped, /^const BUILD = \{"id":"abc123","precache":\["\/","\/index\.html"\]\}; \/\/ __BUILD__$/m);
  assert.throws(() => injectBuild("const x = 1;", "abc", []), /marker not found/);
});
