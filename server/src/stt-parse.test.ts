/**
 * Unit tests for the Deepgram streaming message parser. Canned messages cover
 * the batch-style (results.channels…) shape this engine emits, the Deepgram live
 * (channel.alternatives…) shape, empty transcripts, and control/metadata frames.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDeepgramMessage } from "./stt.js";

test("parses a Results message (results.channels shape)", () => {
  const msg = JSON.stringify({
    type: "Results",
    results: {
      channels: [{ alternatives: [{ transcript: "hello world" }] }],
    },
    is_final: true,
    speech_final: true,
  });
  const seg = parseDeepgramMessage(msg);
  assert.ok(seg);
  assert.equal(seg!.transcript, "hello world");
  assert.equal(seg!.isFinal, true);
  assert.equal(seg!.speechFinal, true);
});

test("parses the Deepgram live shape (channel.alternatives)", () => {
  const msg = JSON.stringify({
    type: "Results",
    channel: { alternatives: [{ transcript: "streaming path" }] },
    is_final: true,
  });
  const seg = parseDeepgramMessage(msg);
  assert.ok(seg);
  assert.equal(seg!.transcript, "streaming path");
  assert.equal(seg!.isFinal, true);
  // speech_final absent -> mirrors is_final
  assert.equal(seg!.speechFinal, true);
});

test("empty transcript still parses (caller filters blanks)", () => {
  const msg = JSON.stringify({
    results: { channels: [{ alternatives: [{ transcript: "" }] }] },
  });
  const seg = parseDeepgramMessage(msg);
  assert.ok(seg);
  assert.equal(seg!.transcript, "");
});

test("defaults is_final to true when the field is absent", () => {
  const msg = JSON.stringify({
    results: { channels: [{ alternatives: [{ transcript: "no flags" }] }] },
  });
  const seg = parseDeepgramMessage(msg);
  assert.ok(seg);
  assert.equal(seg!.isFinal, true);
});

test("returns null for a Metadata / control message (no transcript)", () => {
  assert.equal(
    parseDeepgramMessage(JSON.stringify({ type: "Metadata", request_id: "x" })),
    null,
  );
  assert.equal(parseDeepgramMessage(JSON.stringify({ type: "KeepAlive" })), null);
});

test("returns null for malformed / non-JSON input", () => {
  assert.equal(parseDeepgramMessage("not json {{{"), null);
  assert.equal(parseDeepgramMessage(JSON.stringify({ results: {} })), null);
  assert.equal(parseDeepgramMessage(JSON.stringify(null as unknown as object)), null);
});

test("accepts a pre-parsed object as well as a string", () => {
  const seg = parseDeepgramMessage({
    results: { channels: [{ alternatives: [{ transcript: "obj input" }] }] },
    is_final: false,
  } as Record<string, unknown>);
  assert.ok(seg);
  assert.equal(seg!.transcript, "obj input");
  assert.equal(seg!.isFinal, false);
});
