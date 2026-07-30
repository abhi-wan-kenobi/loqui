/**
 * Text-to-speech adapters + a serial synthesis queue.
 *
 * OpenAiSpeechAdapter talks to the local Kokoro OpenAI-compatible speech API and
 * streams back raw 24 kHz mono int16 PCM. TtsQueue drives synthesis one sentence
 * at a time, forwarding PCM chunks to a broadcast callback, and is abortable so a
 * barge-in can flush everything instantly.
 */

import type { LoquiConfig } from "./config.js";

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
    for await (const chunk of reader) {
      if (signal.aborted) return;
      yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
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

/**
 * Serial TTS queue. Sentences are synthesized one at a time, in order, so the
 * binary frames stay in sequence. flush() aborts the in-flight synth and clears
 * the backlog (barge-in). At normal speaking cadence the backlog stays shallow
 * (<= 2 pending), which is the intended depth.
 */
export class TtsQueue {
  private queue: Array<{ id: number; text: string }> = [];
  private running = false;
  private abort: AbortController | null = null;

  constructor(
    private readonly adapter: TtsAdapter,
    private readonly optsFn: () => TtsOptions,
    private readonly cb: TtsQueueCallbacks,
  ) {}

  enqueue(id: number, text: string): void {
    this.queue.push({ id, text });
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift();
        if (!job) break;
        const ac = new AbortController();
        this.abort = ac;
        try {
          this.cb.onStart(job.id, job.text);
          for await (const chunk of this.adapter.synthesize(
            job.text,
            this.optsFn(),
            ac.signal,
          )) {
            if (ac.signal.aborted) break;
            this.cb.onChunk(job.id, chunk);
          }
          if (!ac.signal.aborted) this.cb.onDone(job.id);
        } catch (err) {
          if (!ac.signal.aborted) {
            this.cb.onError(
              job.id,
              err instanceof Error ? err : new Error(String(err)),
            );
          }
        } finally {
          this.abort = null;
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Barge-in: abort the current synth and drop the backlog. */
  flush(): void {
    this.queue = [];
    if (this.abort) this.abort.abort();
  }

  get busy(): boolean {
    return this.running || this.queue.length > 0;
  }
}
