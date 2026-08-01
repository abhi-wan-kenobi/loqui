/**
 * Regression tests for the TTS byte-alignment / coalesce logic (the static bug).
 *
 * Kokoro's chunked stream can emit odd-length chunks; framing one verbatim as
 * int16 PCM byte-swaps every subsequent sample (white noise) and makes odd
 * frames throw client-side. ByteAligner must guarantee:
 *   - every emitted Buffer is even-length (sample-grid aligned),
 *   - the concatenation of all outputs is byte-identical to the input, minus at
 *     most one trailing dangling byte (half a sample) dropped at flush,
 *   - every non-final chunk is >= the coalesce threshold (960 bytes).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ByteAligner, MIN_TTS_CHUNK_BYTES } from "./tts.js";

/** Deterministic byte buffer of length n (values 0..255, position-derived). */
function seq(start: number, n: number): Buffer {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (start + i) & 0xff;
  return b;
}

/** Run a chunk sequence through a fresh ByteAligner, returning push + flush out. */
function run(chunks: Buffer[]): { outputs: Buffer[]; flushed: Buffer | null } {
  const a = new ByteAligner();
  const outputs: Buffer[] = [];
  for (const c of chunks) outputs.push(...a.push(c));
  const flushed = a.flush();
  return { outputs, flushed };
}

function assertAllEven(outputs: Buffer[], flushed: Buffer | null): void {
  for (const o of outputs) assert.equal(o.length % 2, 0, `push output odd: ${o.length}`);
  if (flushed) assert.equal(flushed.length % 2, 0, `flush output odd: ${flushed.length}`);
}

function assertNonFinalCoalesced(outputs: Buffer[]): void {
  for (const o of outputs) {
    assert.ok(
      o.length >= MIN_TTS_CHUNK_BYTES,
      `non-final chunk below coalesce threshold: ${o.length}`,
    );
  }
}

/** Concatenation of all outputs (push outputs then the flush). */
function concatAll(outputs: Buffer[], flushed: Buffer | null): Buffer {
  return Buffer.concat(flushed ? [...outputs, flushed] : outputs);
}

test("even-length input: output is byte-identical and all even", () => {
  const input = seq(0, 4000); // even total
  const { outputs, flushed } = run([input]);
  assertAllEven(outputs, flushed);
  assertNonFinalCoalesced(outputs);
  assert.deepEqual(concatAll(outputs, flushed), input);
});

test("single odd large chunk: one trailing byte carried, then dropped at flush", () => {
  const input = seq(7, 4001); // odd total
  const { outputs, flushed } = run([input]);
  assertAllEven(outputs, flushed);
  const got = concatAll(outputs, flushed);
  // The very last (dangling) byte is dropped: identical to input minus 1 byte.
  assert.equal(got.length, 4000);
  assert.deepEqual(got, input.subarray(0, 4000));
});

test("odd/even/1-byte/large mix reassembles byte-identically (even total)", () => {
  const chunks = [
    seq(0, 3), // odd, below threshold -> buffered
    seq(3, 1), // 1 byte -> now 4 buffered
    seq(4, 1001), // odd, pushes over threshold -> emits even, carries 1
    seq(1005, 2), // even small
    seq(1007, 5000), // large
    seq(6007, 1), // trailing 1 byte -> makes running total even here
  ];
  const total = chunks.reduce((s, c) => s + c.length, 0); // 6008, even
  assert.equal(total % 2, 0);
  const { outputs, flushed } = run(chunks);
  assertAllEven(outputs, flushed);
  assertNonFinalCoalesced(outputs);
  const expected = Buffer.concat(chunks);
  assert.deepEqual(concatAll(outputs, flushed), expected);
});

test("odd/even/1-byte/large mix (odd total) drops exactly the final byte", () => {
  const chunks = [
    seq(0, 1),
    seq(1, 959), // now exactly 960 -> emits 960
    seq(960, 3), // odd small -> buffered
    seq(963, 1000), // over threshold -> emits even, carry 1
    seq(1963, 7), // odd
  ];
  const expected = Buffer.concat(chunks);
  const total = expected.length; // 1970? compute: 1+959+3+1000+7 = 1970 (even)
  // Make it odd by appending a single byte.
  const chunksOdd = [...chunks, seq(9000, 1)];
  const expectedOdd = Buffer.concat(chunksOdd);
  assert.equal(expectedOdd.length % 2, 1);
  const { outputs, flushed } = run(chunksOdd);
  assertAllEven(outputs, flushed);
  assertNonFinalCoalesced(outputs);
  const got = concatAll(outputs, flushed);
  assert.equal(got.length, expectedOdd.length - 1);
  assert.deepEqual(got, expectedOdd.subarray(0, expectedOdd.length - 1));
  void total;
});

test("many tiny odd chunks coalesce into >= 960-byte frames", () => {
  const chunks: Buffer[] = [];
  for (let i = 0; i < 500; i++) chunks.push(seq(i, 3)); // 1500 x 1? -> 500*3 = 1500 bytes
  const { outputs, flushed } = run(chunks);
  assertAllEven(outputs, flushed);
  assertNonFinalCoalesced(outputs);
  assert.ok(outputs.length >= 1, "should have emitted at least one coalesced frame");
  const expected = Buffer.concat(chunks); // 1500 bytes, even
  assert.deepEqual(concatAll(outputs, flushed), expected);
});

test("sub-threshold total is emitted only at flush", () => {
  const input = seq(0, 800); // < 960
  const { outputs, flushed } = run([input]);
  assert.equal(outputs.length, 0, "nothing emitted before flush");
  assert.ok(flushed, "flush emits the remainder");
  assert.deepEqual(flushed, input);
});

test("empty stream: no outputs, no flush", () => {
  const { outputs, flushed } = run([]);
  assert.equal(outputs.length, 0);
  assert.equal(flushed, null);
});
