#!/usr/bin/env node
// Self-host all @ricky0123/vad-web runtime assets so nothing is fetched from a
// CDN. Copies the VAD worklet bundle, the Silero ONNX models, and the
// onnxruntime-web WASM/mjs runtime into web/public/vad/. Vite serves public/
// at the site root in dev and copies it verbatim into dist/ on build, so this
// single step satisfies both `/vad/...` in dev and `dist/vad/...` in prod.
//
// Wired as a prebuild/predev step in package.json. Idempotent.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../public/vad");

const vadDist = path.join(path.dirname(require.resolve("@ricky0123/vad-web/package.json")), "dist");
// onnxruntime-web restricts package.json in its "exports"; resolve its main
// entry instead (which lives in dist/) and take that directory.
const ortDist = path.dirname(require.resolve("onnxruntime-web"));

mkdirSync(outDir, { recursive: true });

// The VAD worklet + both Silero model variants (legacy is the default; v5 is
// copied too so switching the model needs no rebuild).
const vadFiles = ["vad.worklet.bundle.min.js", "silero_vad_legacy.onnx", "silero_vad_v5.onnx"];

// onnxruntime-web fetches its wasm binary + mjs loader from wasmPaths
// (= onnxWASMBasePath = /vad/). The `onnxruntime-web/wasm` backend that
// vad-web imports selects the plain SIMD-threaded build (and the `.jsep`
// build when a WebGPU/WebNN EP is available). The `.asyncify`/`.jspi`
// variants are proxy/stack-switching builds it never picks here, so we skip
// them to keep dist/ lean (they add ~40 MB).
const ortFiles = readdirSync(ortDist).filter(
  (f) =>
    f.startsWith("ort-wasm-simd-threaded") &&
    !f.includes(".asyncify") &&
    !f.includes(".jspi") &&
    (f.endsWith(".wasm") || f.endsWith(".mjs")),
);

let copied = 0;
for (const f of vadFiles) {
  cpSync(path.join(vadDist, f), path.join(outDir, f));
  copied++;
}
for (const f of ortFiles) {
  cpSync(path.join(ortDist, f), path.join(outDir, f));
  copied++;
}

console.log(`[copy-vad-assets] copied ${copied} files -> ${path.relative(process.cwd(), outDir)}`);
