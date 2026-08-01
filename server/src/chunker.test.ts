import { test } from "node:test";
import assert from "node:assert/strict";
import { SentenceChunker, cleanText, chunkAll } from "./chunker.js";

test("splits into sentences on enders past the min length", () => {
  const out = chunkAll(
    "The weather in Delhi is quite warm today. You should carry some water with you.",
  );
  assert.equal(out.length, 2);
  assert.equal(out[0], "The weather in Delhi is quite warm today.");
  assert.equal(out[1], "You should carry some water with you.");
});

test("never emits a segment longer than maxLen, even with a late ender", () => {
  // An ender only after 260 chars must not produce a 261-char sentence.
  const out = chunkAll("A".repeat(260) + ". " + "B".repeat(10));
  for (const seg of out) assert.ok(seg.length <= 250, `segment ${seg.length} > 250`);
  // No text lost: 260 A + 1 period + 10 B = 271 non-whitespace chars.
  assert.equal(out.join("").replace(/\s/g, "").length, 271);
});

test("hard-cut fuzz keeps every segment within maxLen", () => {
  for (let len = 240; len <= 600; len += 37) {
    const out = chunkAll("x".repeat(len) + "! done.");
    for (const seg of out) assert.ok(seg.length <= 250, `len ${len}: seg ${seg.length}`);
  }
});

test("does not split on a decimal point", () => {
  const out = chunkAll(
    "The apartment costs about 3.5 lakh rupees per month which is a lot.",
  );
  assert.equal(out.length, 1);
  assert.ok(out[0]!.includes("3.5 lakh"));
});

test("merges a short leading fragment into the next sentence", () => {
  // "Hi." is under 40 chars, so it should not become its own segment.
  const out = chunkAll("Hi. I can help you plan the trip to Vietnam next month.");
  assert.equal(out.length, 1);
  assert.ok(out[0]!.startsWith("Hi."));
});

test("strips markdown markers", () => {
  assert.equal(
    cleanText("This is **bold** and _italic_ and `code` and # heading"),
    "This is bold and italic and code and heading",
  );
});

test("turns a markdown link into its text", () => {
  assert.equal(
    cleanText("See [the docs](https://example.com/docs/page) for details"),
    "See the docs for details",
  );
});

test("strips a bare URL down to its hostname", () => {
  assert.equal(
    cleanText("Go to https://example.com/foo/bar?x=1 now"),
    "Go to example.com now",
  );
});

test("treats a newline as a sentence boundary", () => {
  const out = chunkAll(
    "First line of the response here for you\nSecond line of the response here for you",
  );
  assert.equal(out.length, 2);
  assert.equal(out[0], "First line of the response here for you");
  assert.equal(out[1], "Second line of the response here for you");
});

test("skips blank lines", () => {
  const out = chunkAll(
    "A reasonably long first paragraph goes here.\n\n\nA reasonably long second paragraph goes here.",
  );
  assert.equal(out.length, 2);
});

test("hard-cuts an overlong run with no enders", () => {
  const word = "word ";
  const long = word.repeat(80); // 400 chars, no sentence ender
  const out = chunkAll(long.trim());
  assert.ok(out.length >= 2, "should split into multiple chunks");
  for (const seg of out) {
    assert.ok(seg.length <= 250, `segment too long: ${seg.length}`);
  }
});

test("flush emits the trailing partial sentence", () => {
  const c = new SentenceChunker();
  const streamed = c.push("A complete sentence that is over forty characters long. Tail");
  assert.equal(streamed.length, 1);
  const rest = c.flush();
  assert.equal(rest.length, 1);
  assert.equal(rest[0], "Tail");
});

test("handles deltas that split tokens across pushes", () => {
  const c = new SentenceChunker();
  let out: string[] = [];
  for (const frag of ["The mee", "ting is scheduled at ", "3.5 ", "pm sharp this after", "noon. ", "Bye"]) {
    out = out.concat(c.push(frag));
  }
  out = out.concat(c.flush());
  assert.equal(out.length, 2);
  assert.ok(out[0]!.includes("3.5 pm"));
  assert.equal(out[1], "Bye");
});

test("filters thinking-style leakage only structurally (chunker is text-only)", () => {
  // The chunker only sees text_delta; ensure plain prose passes untouched.
  const out = chunkAll("Sure, I can do that for you right away without any trouble.");
  assert.equal(out.length, 1);
});
