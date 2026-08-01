/**
 * Text-to-speech adapters + a pipelined synthesis queue.
 *
 * OpenAiSpeechAdapter talks to the local Kokoro OpenAI-compatible speech API and
 * streams back raw 24 kHz mono int16 PCM. TtsQueue drives synthesis with a small
 * prefetch depth (synthesize sentence N+1 while N is still streaming) but keeps
 * the broadcast strictly in order, and is abortable so a barge-in can flush both
 * in-flight fetches instantly.
 *
 * Audio correctness: Kokoro's chunked HTTP stream can emit odd-byte-length
 * chunks. Framing an odd-length chunk verbatim byte-swaps every subsequent int16
 * sample (white-noise static) and makes odd frames throw client-side. ByteAligner
 * carries the stray trailing byte across chunk boundaries so every yielded Buffer
 * is even-length and sample-grid aligned, and coalesces tiny chunks to cut WS
 * frame spam.
 */

import type { LoquiConfig } from "./config.js";

/** ~20ms of 24 kHz mono int16 audio; coalesce target before yielding a frame. */
export const MIN_TTS_CHUNK_BYTES = 960;

/**
 * Stateful transform that makes a stream of arbitrary byte chunks safe to frame
 * as int16 PCM:
 *   - carries a stray trailing byte forward so every emitted Buffer is
 *     even-length (sample-grid aligned),
 *   - coalesces small chunks until at least `minChunk` bytes have accumulated,
 *   - drops a final dangling byte (half a sample) at flush.
 *
 * Exported as a pure helper so the alignment logic is unit-tested directly.
 */
export class ByteAligner {
  private pending: Buffer = Buffer.alloc(0);

  constructor(private readonly minChunk: number = MIN_TTS_CHUNK_BYTES) {}

  /** Feed one raw chunk; returns zero or more even-length, >= minChunk buffers. */
  push(chunk: Buffer): Buffer[] {
    if (chunk.length === 0) return [];
    this.pending =
      this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const out: Buffer[] = [];
    if (this.pending.length >= this.minChunk) {
      const even = this.pending.length - (this.pending.length % 2);
      if (even > 0) {
        out.push(this.pending.subarray(0, even));
        this.pending = this.pending.subarray(even);
      }
    }
    return out;
  }

  /** Emit the remainder at stream end, dropping any dangling odd byte. */
  flush(): Buffer | null {
    const even = this.pending.length - (this.pending.length % 2);
    const out = even > 0 ? this.pending.subarray(0, even) : null;
    this.pending = Buffer.alloc(0);
    return out;
  }
}

export interface TtsOptions {
  voice: string;
  speed: number;
}

export interface TtsAdapter {
  /** Stream PCM chunks for one sentence. Respects the abort signal. */
  synthesize(
    sentence: string,
    opts: TtsOptions,
    signal: AbortSignal,
  ): AsyncIterable<Buffer>;
  /** Cheap liveness probe for /healthz. */
  ping(): Promise<boolean>;
  readonly sampleRate: number;
}

export class OpenAiSpeechAdapter implements TtsAdapter {
  private readonly base: string;
  private readonly model: string;
  private readonly format: string;
  readonly sampleRate: number;

  constructor(cfg: LoquiConfig) {
    this.base = cfg.tts.url.replace(/\/$/, "");
    this.model = cfg.tts.model;
    this.format = cfg.tts.format || "pcm";
    this.sampleRate = cfg.tts.sampleRate || 24000;
  }

  async *synthesize(
    sentence: string,
    opts: TtsOptions,
    signal: AbortSignal,
  ): AsyncIterable<Buffer> {
    const text = sentence.trim();
    if (!text) return;
    const res = await fetch(`${this.base}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        input: text,
        voice: opts.voice,
        response_format: this.format,
        speed: opts.speed,
      }),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`TTS HTTP ${res.status}`);
    }
    // Node's fetch body is a web ReadableStream and is async-iterable.
    const reader = res.body as unknown as AsyncIterable<Uint8Array>;
    const aligner = new ByteAligner();
    for await (const chunk of reader) {
      if (signal.aborted) return;
      // COPY, don't view: `chunk` aliases undici's response-buffer pool, which is
      // reused on the next read. ByteAligner holds bytes in `pending` across that
      // read, so a view would be silently overwritten -> garbled audio.
      const buf = Buffer.from(chunk);
      for (const out of aligner.push(buf)) yield out;
    }
    if (signal.aborted) return;
    const tail = aligner.flush();
    if (tail) yield tail;
  }

  async ping(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      // Any HTTP answer from the host means it is reachable.
      const res = await fetch(`${this.base}/v1/models`, {
        method: "GET",
        signal: controller.signal,
      }).catch(() => fetch(this.base, { signal: controller.signal }));
      clearTimeout(timer);
      return !!res;
    } catch {
      return false;
    }
  }
}

export interface TtsQueueCallbacks {
  onStart(id: number, text: string): void;
  onChunk(id: number, pcm: Buffer): void;
  onDone(id: number): void;
  onError(id: number, err: Error): void;
}

interface PrefetchJob {
  id: number;
  text: string;
  ac: AbortController;
  chunks: Buffer[];
  done: boolean;
  error: Error | null;
  waiters: Array<() => void>;
}

/**
 * Pipelined TTS queue. Up to `depth` sentences synthesize concurrently (prefetch)
 * but their audio is broadcast strictly in order — sentence N drains fully before
 * N+1 starts broadcasting, so the binary frames stay in sequence. flush() aborts
 * every in-flight synth and clears the backlog (barge-in), killing all in-flight
 * fetches via their abort signals.
 */
export class TtsQueue {
  private pending: Array<{ id: number; text: string }> = [];
  private active: PrefetchJob[] = [];
  private running = false;

  constructor(
    private readonly adapter: TtsAdapter,
    private readonly optsFn: () => TtsOptions,
    private readonly cb: TtsQueueCallbacks,
    private readonly depth = 2,
  ) {}

  enqueue(id: number, text: string): void {
    this.pending.push({ id, text });
    void this.pump();
  }

  /** Fill the active window up to `depth`, starting synthesis for each new job. */
  private fill(): void {
    while (this.active.length < this.depth && this.pending.length > 0) {
      const spec = this.pending.shift();
      if (!spec) break;
      const job: PrefetchJob = {
        id: spec.id,
        text: spec.text,
        ac: new AbortController(),
        chunks: [],
        done: false,
        error: null,
        waiters: [],
      };
      this.active.push(job);
      void this.synth(job);
    }
  }

  /** Producer: pull PCM from the adapter into the job's buffer, notifying the
   *  consumer as data arrives. Runs concurrently for up to `depth` jobs. */
  private async synth(job: PrefetchJob): Promise<void> {
    try {
      for await (const chunk of this.adapter.synthesize(
        job.text,
        this.optsFn(),
        job.ac.signal,
      )) {
        if (job.ac.signal.aborted) break;
        job.chunks.push(chunk);
        this.notify(job);
      }
    } catch (err) {
      if (!job.ac.signal.aborted) {
        job.error = err instanceof Error ? err : new Error(String(err));
      }
    } finally {
      job.done = true;
      this.notify(job);
    }
  }

  private notify(job: PrefetchJob): void {
    const ws = job.waiters;
    job.waiters = [];
    for (const w of ws) w();
  }

  private wait(job: PrefetchJob): Promise<void> {
    return new Promise((resolve) => job.waiters.push(resolve));
  }

  /** Consumer: broadcast active[0] to completion, then advance. In order. */
  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.fill();
      while (this.active.length > 0) {
        const job = this.active[0]!;
        // A job aborted before we started broadcasting it: drop silently.
        if (job.ac.signal.aborted) {
          this.active.shift();
          this.fill();
          continue;
        }
        this.cb.onStart(job.id, job.text);
        for (;;) {
          if (job.ac.signal.aborted) break;
          if (job.chunks.length > 0) {
            const c = job.chunks.shift()!;
            if (!job.ac.signal.aborted) this.cb.onChunk(job.id, c);
          } else if (job.done) {
            break;
          } else {
            await this.wait(job);
          }
        }
        this.active.shift();
        if (job.ac.signal.aborted) {
          // barge-in: swallow, client drops via tts.flush
        } else if (job.error) {
          this.cb.onError(job.id, job.error);
        } else {
          this.cb.onDone(job.id);
        }
        this.fill();
      }
    } finally {
      this.running = false;
    }
  }

  /** Barge-in: abort every in-flight synth and drop the backlog. */
  flush(): void {
    this.pending = [];
    for (const job of this.active) {
      job.ac.abort();
      this.notify(job);
    }
  }

  get busy(): boolean {
    return this.running || this.pending.length > 0 || this.active.length > 0;
  }
}
