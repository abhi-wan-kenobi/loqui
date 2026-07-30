// Deterministic check of the barge-in flush race fix in player-processor.js.
//
// Race being tested: main thread's pushAudio passed its staleness check, then
// yielded at `await this.ready`; flush() ran and posted {type:"flush"} first;
// the stale push's postMessage lands AFTER the flush. Pre-fix, the worklet
// re-added the stale samples to a freshly cleared ring. Post-fix, the push
// carries its segmentId and the flush carries the new watermark, so the
// worklet drops it at insertion.
//
// The worklet file is plain JS — run it with stubbed AudioWorklet globals.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "../public/worklets/player-processor.js"), "utf8");

let instance = null;
const sandbox = {
  sampleRate: 24000,
  AudioWorkletProcessor: class {
    constructor() {
      this.port = { onmessage: null };
    }
  },
  registerProcessor(_name, cls) {
    instance = new cls();
  },
};

// eslint-disable-next-line no-new-func
new Function(...Object.keys(sandbox), src)(...Object.values(sandbox));

if (!instance) throw new Error("worklet did not register");
const post = (msg) => instance.port.onmessage({ data: msg });

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

// 1. Normal push buffers audio.
post({ type: "push", segmentId: 0, samples: new Float32Array(480).fill(0.5).buffer });
if (instance.available !== 480) fail(`expected 480 buffered, got ${instance.available}`);

// 2. Barge-in: flush with watermark 1 clears the ring.
post({ type: "flush", minValid: 1 });
if (instance.available !== 0) fail(`flush left ${instance.available} samples`);

// 3. THE RACE: a stale in-flight push (segment 0) lands after the flush.
post({ type: "push", segmentId: 0, samples: new Float32Array(480).fill(0.5).buffer });
if (instance.available !== 0) fail(`stale push survived the flush: ${instance.available} samples re-buffered`);

// 4. Fresh audio for the next segment still plays.
post({ type: "push", segmentId: 1, samples: new Float32Array(240).fill(0.5).buffer });
if (instance.available !== 240) fail(`fresh push after flush rejected: ${instance.available}`);

// 5. process() drains the ring.
const out = [new Float32Array(128)];
instance.process([], [out]);
if (instance.available !== 240 - 128) fail(`process() drained wrong: ${instance.available}`);
if (out[0][0] !== 0.5) fail("process() output wrong sample");

console.log("PASS: stale in-flight push dropped after flush; fresh segment plays; ring drains");
