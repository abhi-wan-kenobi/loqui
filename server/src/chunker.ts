/**
 * Sentence chunker for the assistant delta stream.
 *
 * The agent streams text_delta fragments. We accumulate them and emit whole
 * "sentences" suitable for one TTS call each, so speech starts as early as
 * possible while staying natural. Along the way we strip markdown artifacts
 * that would otherwise be read aloud or would mangle boundary detection.
 *
 * Rules (see server spec):
 *  - strip backticks, *, _, #, and turn [text](url) into text; bare URLs -> host
 *  - cut on a sentence ender . ? ! : that is followed by whitespace/EOL, but
 *    only once >= MIN_LEN cleaned chars have accumulated (avoids tiny segments
 *    and, incidentally, decimals like "3.5" whose dot is not followed by space)
 *  - a newline is always a boundary (paragraph break)
 *  - hard cut at MAX_LEN chars
 *  - flush() returns the remainder (called on turn result)
 */

const MIN_LEN = 40;
const MAX_LEN = 250;
const ENDERS = new Set([".", "?", "!", ":"]);

/** Strip markdown / URL noise from a text segment and collapse whitespace. */
export function cleanText(s: string): string {
  return s
    .replace(/\[([^\]\n]*)\]\(([^)\n]*)\)/g, "$1") // [text](url) -> text
    .replace(/\bhttps?:\/\/([^\s/]+)[^\s]*/gi, "$1") // http(s) URL -> host
    .replace(/\bwww\.([^\s/]+)[^\s]*/gi, "www.$1") // www URL -> host
    .replace(/[`*_#]/g, "") // markdown markers
    .replace(/\s+/g, " ")
    .trim();
}

const isWs = (c: string): boolean => c !== "" && /\s/.test(c);

export class SentenceChunker {
  private buf = "";
  private readonly minLen: number;
  private readonly maxLen: number;

  constructor(minLen = MIN_LEN, maxLen = MAX_LEN) {
    this.minLen = minLen;
    this.maxLen = maxLen;
  }

  /** Feed a raw delta; returns zero or more complete sentences ready for TTS. */
  push(text: string): string[] {
    if (text) this.buf += text;
    const out: string[] = [];
    // Extract as many complete segments as are available.
    for (;;) {
      const seg = this.nextSegment(false);
      if (seg === null) break;
      if (seg) out.push(seg);
    }
    return out;
  }

  /** Emit whatever remains (end of turn). */
  flush(): string[] {
    const out: string[] = [];
    for (;;) {
      const seg = this.nextSegment(false);
      if (seg === null) break;
      if (seg) out.push(seg);
    }
    const tail = cleanText(this.buf);
    this.buf = "";
    if (tail) out.push(tail);
    return out;
  }

  reset(): void {
    this.buf = "";
  }

  /**
   * Consume one segment from the buffer.
   * Returns a cleaned sentence string, "" if it consumed only blank/whitespace,
   * or null if there is no complete segment available yet.
   */
  private nextSegment(_final: boolean): string | null {
    const buf = this.buf;
    const n = buf.length;

    // Only look for a natural boundary within the first maxLen chars; a sentence
    // ender that appears later must NOT produce an over-length segment — the hard
    // cut below handles the overrun instead.
    const scanLimit = Math.min(n, this.maxLen);

    for (let i = 0; i < scanLimit; i++) {
      const c = buf.charAt(i);

      if (c === "\n") {
        // Newline is always a boundary.
        const cleaned = cleanText(buf.slice(0, i));
        this.buf = buf.slice(i + 1);
        return cleaned; // "" for a blank line (skipped by caller)
      }

      if (ENDERS.has(c)) {
        const next = i + 1 < n ? buf.charAt(i + 1) : "";
        if (next === "" || isWs(next)) {
          if (next === "") break; // ender at end of buffer: wait for more
          const cleaned = cleanText(buf.slice(0, i + 1));
          if (cleaned.length >= this.minLen) {
            this.buf = buf.slice(i + 1).replace(/^\s+/, "");
            return cleaned;
          }
          // Too short: keep scanning for a later boundary (merge fragments).
        }
      }
    }

    // No usable boundary. Hard-cut if we've overrun.
    if (n >= this.maxLen) {
      let cut = -1;
      for (let i = Math.min(this.maxLen, n) - 1; i > this.minLen; i--) {
        if (isWs(buf.charAt(i))) {
          cut = i;
          break;
        }
      }
      if (cut < 0) cut = Math.min(this.maxLen, n);
      const cleaned = cleanText(buf.slice(0, cut));
      this.buf = buf.slice(cut).replace(/^\s+/, "");
      return cleaned;
    }

    return null;
  }
}

/** Convenience for tests: run a whole string through and flush. */
export function chunkAll(text: string): string[] {
  const c = new SentenceChunker();
  const out = c.push(text);
  return out.concat(c.flush());
}
