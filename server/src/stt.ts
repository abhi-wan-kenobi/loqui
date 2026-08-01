/**
 * Speech-to-text adapters.
 *
 * Two adapters:
 *   - DeepgramBatchAdapter: accumulate a whole utterance of 16 kHz mono int16
 *     PCM, wrap it in a WAV header, POST it, parse the Deepgram-shaped transcript.
 *     Higher latency (nothing happens until utterance.end) but robust.
 *   - DeepgramStreamAdapter: open a WebSocket, relay PCM as it arrives, and get
 *     confirmed segments back live (much lower perceived latency). Falls back to
 *     the batch path when the single-session engine is busy or the socket fails.
 *
 * The stt-server (Notare STT) speaks a Deepgram-compatible protocol: binary
 * frames carry raw int16 PCM in; text controls are {"type":"Finalize"},
 * {"type":"KeepAlive"}, {"type":"CloseStream"}; responses are Deepgram-shaped
 * JSON with the transcript at results.channels[0].alternatives[0].transcript.
 */

import { WebSocket } from "ws";
import type { LoquiConfig } from "./config.js";

export interface SttAdapter {
  /** Transcribe one finalized utterance (16 kHz mono int16 PCM). */
  transcribeUtterance(pcm: Int16Array): Promise<string>;
  /** Open a live streaming session; only present on streaming adapters. */
  openStream?(): SttStream;
  /** Cheap liveness probe for /healthz. */
  ping(): Promise<boolean>;
}

/** A live STT session. Segments arrive via onSegment; finalize awaits the tail. */
export interface SttStream {
  /** Resolves once the socket is open and ready, rejects on connect/4xx failure. */
  ready(): Promise<void>;
  /** Relay a raw even-length int16-LE PCM buffer. */
  pushPcm(pcm: Buffer): void;
  /** Register the confirmed-segment callback (called once per final segment). */
  onSegment(cb: (text: string, final: boolean) => void): void;
  /** Send Finalize and await the tail segment (or `timeoutMs`), then settle. */
  finalize(timeoutMs: number): Promise<void>;
  /** Send CloseStream and close the socket. Idempotent. */
  close(): void;
}

export interface DeepgramSegment {
  transcript: string;
  isFinal: boolean;
  speechFinal: boolean;
}

/**
 * Parse one Deepgram-shaped streaming message. Returns the segment when the
 * message carries a transcript, or null for control/metadata/unknown shapes.
 * Accepts both the batch shape (results.channels[0]…) and the Deepgram live
 * shape (channel.alternatives[0]…) defensively. Exported for unit testing.
 */
export function parseDeepgramMessage(
  raw: string | Record<string, unknown>,
): DeepgramSegment | null {
  let obj: any;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  } else {
    obj = raw;
  }
  if (!obj || typeof obj !== "object") return null;
  const alt =
    obj?.results?.channels?.[0]?.alternatives?.[0] ??
    obj?.channel?.alternatives?.[0];
  if (!alt || typeof alt.transcript !== "string") return null;
  const isFinal =
    typeof obj.is_final === "boolean"
      ? obj.is_final
      : typeof obj.speech_final === "boolean"
        ? obj.speech_final
        : true; // this engine emits confirmed segments only
  const speechFinal =
    typeof obj.speech_final === "boolean" ? obj.speech_final : isFinal;
  return { transcript: alt.transcript, isFinal, speechFinal };
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

const DEBUG_STT = process.env.LOQUI_DEBUG_STT === "1";

/** One live streaming session over a Deepgram-compatible WebSocket. */
class DeepgramStream implements SttStream {
  private ws: WebSocket | null = null;
  private readonly openPromise: Promise<void>;
  private segmentCb: ((text: string, final: boolean) => void) | null = null;
  private keepAlive: NodeJS.Timeout | null = null;
  private lastSend = Date.now();
  private closed = false;
  private opened = false;
  private queue: Buffer[] = []; // frames pushed before the socket opened
  // finalize() tail-wait plumbing:
  private tailResolve: (() => void) | null = null;
  private tailTimer: NodeJS.Timeout | null = null;

  constructor(wsUrl: string, token: string | undefined) {
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    this.openPromise = new Promise<void>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl, headers ? { headers } : undefined);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.ws = ws;
      const connectTimer = setTimeout(() => {
        reject(new Error("stt stream connect timeout"));
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      }, 5000);
      ws.on("open", () => {
        clearTimeout(connectTimer);
        this.opened = true;
        // flush anything buffered before open
        for (const b of this.queue) this.rawSendBinary(b);
        this.queue = [];
        this.startKeepAlive();
        resolve();
      });
      ws.on("unexpected-response", (_req, res) => {
        clearTimeout(connectTimer);
        reject(new Error(`stt stream HTTP ${res.statusCode}`));
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      });
      ws.on("error", (err) => {
        clearTimeout(connectTimer);
        if (!this.opened) reject(err);
        // post-open errors are surfaced via close/finalize timeout
      });
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) return;
        this.onTextMessage(data.toString());
      });
      ws.on("close", () => {
        this.stopKeepAlive();
        // If finalize is waiting and the socket closed, release it.
        this.resolveTail();
      });
    });
  }

  ready(): Promise<void> {
    return this.openPromise;
  }

  onSegment(cb: (text: string, final: boolean) => void): void {
    this.segmentCb = cb;
  }

  pushPcm(pcm: Buffer): void {
    if (this.closed || pcm.length === 0) return;
    if (!this.opened) {
      this.queue.push(pcm);
      return;
    }
    this.rawSendBinary(pcm);
  }

  private rawSendBinary(buf: Buffer): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(buf, { binary: true });
      this.lastSend = Date.now();
    } catch {
      /* ignore */
    }
  }

  private rawSendText(obj: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(obj));
      this.lastSend = Date.now();
    } catch {
      /* ignore */
    }
  }

  private startKeepAlive(): void {
    this.keepAlive = setInterval(() => {
      if (Date.now() - this.lastSend >= 8000) {
        this.rawSendText({ type: "KeepAlive" });
      }
    }, 4000);
    if (typeof this.keepAlive.unref === "function") this.keepAlive.unref();
  }

  private stopKeepAlive(): void {
    if (this.keepAlive) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
  }

  private onTextMessage(text: string): void {
    const seg = parseDeepgramMessage(text);
    if (!seg) {
      if (DEBUG_STT) {
        process.stderr.write(`[stt-stream] non-transcript message: ${text.slice(0, 200)}\n`);
      }
      return;
    }
    const t = seg.transcript.trim();
    if (t && this.segmentCb) this.segmentCb(t, seg.isFinal);
    // Any transcript arriving after Finalize satisfies the tail wait.
    this.resolveTail();
  }

  finalize(timeoutMs: number): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.tailResolve = resolve;
      this.tailTimer = setTimeout(() => this.resolveTail(), timeoutMs);
      if (typeof this.tailTimer.unref === "function") this.tailTimer.unref();
      this.rawSendText({ type: "Finalize" });
    });
  }

  private resolveTail(): void {
    if (this.tailTimer) {
      clearTimeout(this.tailTimer);
      this.tailTimer = null;
    }
    const r = this.tailResolve;
    this.tailResolve = null;
    if (r) r();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopKeepAlive();
    this.resolveTail();
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        /* ignore */
      }
    }
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    // Guarantee the socket is gone shortly even if close() handshake stalls.
    setTimeout(() => {
      try {
        this.ws?.terminate();
      } catch {
        /* ignore */
      }
    }, 1500).unref?.();
  }
}

/**
 * Streaming adapter. Selected when stt.adapter === "deepgram-ws". Delegates the
 * batch path (fallback) to an embedded DeepgramBatchAdapter.
 */
export class DeepgramStreamAdapter implements SttAdapter {
  private readonly wsBase: string;
  private readonly sampleRate: number;
  private readonly languages: string;
  private readonly token: string | undefined;
  private readonly batch: DeepgramBatchAdapter;

  constructor(cfg: LoquiConfig, token: string | undefined) {
    // http(s) -> ws(s), preserving any path prefix (Caddy proxies /notare-stt).
    const base = cfg.stt.url.replace(/\/$/, "");
    if (/^https:/i.test(base)) this.wsBase = base.replace(/^https:/i, "wss:");
    else if (/^http:/i.test(base)) this.wsBase = base.replace(/^http:/i, "ws:");
    else this.wsBase = base;
    this.sampleRate = cfg.stt.sampleRate || 16000;
    this.languages = cfg.stt.languages || "en";
    this.token = token;
    this.batch = new DeepgramBatchAdapter(cfg, token);
  }

  private streamUrl(): string {
    return `${this.wsBase}/v1/listen?sample_rate=${this.sampleRate}&channels=1&languages=${encodeURIComponent(this.languages)}`;
  }

  openStream(): SttStream {
    return new DeepgramStream(this.streamUrl(), this.token);
  }

  transcribeUtterance(pcm: Int16Array): Promise<string> {
    return this.batch.transcribeUtterance(pcm);
  }

  ping(): Promise<boolean> {
    return this.batch.ping();
  }
}

export function makeSttAdapter(
  cfg: LoquiConfig,
  token: string | undefined,
): SttAdapter {
  if (cfg.stt.adapter === "deepgram-ws") {
    return new DeepgramStreamAdapter(cfg, token);
  }
  return new DeepgramBatchAdapter(cfg, token);
}
