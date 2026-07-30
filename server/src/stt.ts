/**
 * Speech-to-text adapters.
 *
 * v0.1 ships a batch adapter: accumulate an utterance of 16 kHz mono int16 PCM,
 * wrap it in a WAV header server-side, POST it to the Notare STT endpoint, and
 * parse the Deepgram-shaped transcript. A streaming interface is declared for
 * v0.2 but stubbed.
 */

import type { LoquiConfig } from "./config.js";

export interface SttAdapter {
  /** Transcribe one finalized utterance (16 kHz mono int16 PCM). */
  transcribeUtterance(pcm: Int16Array): Promise<string>;
  /** Streaming session (v0.2). Throws in v0.1. */
  openStream?(): SttStream;
  /** Cheap liveness probe for /healthz. */
  ping(): Promise<boolean>;
}

/** v0.2 streaming surface — declared now so the server code can grow into it. */
export interface SttStream {
  pushPcm(pcm: Int16Array): void;
  onSegment(cb: (text: string, final: boolean) => void): void;
  close(): void;
}

/** Wrap raw 16 kHz mono int16 PCM in a minimal WAV (RIFF) container. */
export function pcmToWav(pcm: Int16Array, sampleRate = 16000): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataBytes = pcm.length * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  // Copy PCM as little-endian bytes (Int16Array is LE on all supported hosts).
  const body = Buffer.from(pcm.buffer, pcm.byteOffset, dataBytes);
  return Buffer.concat([header, body]);
}

export class DeepgramBatchAdapter implements SttAdapter {
  private readonly base: string;
  private readonly sampleRate: number;
  private readonly token: string | undefined;

  constructor(cfg: LoquiConfig, token: string | undefined) {
    this.base = cfg.stt.url.replace(/\/$/, "");
    this.sampleRate = cfg.stt.sampleRate || 16000;
    this.token = token;
  }

  private listenUrl(): string {
    return `${this.base}/v1/listen?sample_rate=${this.sampleRate}&channels=1`;
  }

  async transcribeUtterance(pcm: Int16Array): Promise<string> {
    if (pcm.length === 0) return "";
    const wav = pcmToWav(pcm, this.sampleRate);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(this.listenUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "audio/wav",
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: wav,
        signal: controller.signal,
      });
      if (res.status === 409 || res.status === 429 || res.status === 503) {
        throw new Error("transcriber busy");
      }
      if (!res.ok) {
        throw new Error(`STT HTTP ${res.status}`);
      }
      const json = (await res.json()) as {
        results?: {
          channels?: Array<{
            alternatives?: Array<{ transcript?: string }>;
          }>;
        };
      };
      const transcript =
        json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
      return transcript.trim();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error("transcriber timed out");
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  openStream(): SttStream {
    throw new Error("STT streaming is a v0.2 feature");
  }

  async ping(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      // A tiny (10ms) silent utterance; we only care that the endpoint answers.
      const wav = pcmToWav(new Int16Array(160), this.sampleRate);
      const res = await fetch(this.listenUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "audio/wav",
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: wav,
        signal: controller.signal,
      });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }
}

export function makeSttAdapter(
  cfg: LoquiConfig,
  token: string | undefined,
): SttAdapter {
  // Only the batch adapter exists in v0.1; the config's "deepgram-ws" adapter
  // falls back to batch (cfg.stt.batchFallback).
  return new DeepgramBatchAdapter(cfg, token);
}
