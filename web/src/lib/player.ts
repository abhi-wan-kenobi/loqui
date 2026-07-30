import { TTS_SAMPLE_RATE } from "@loqui/protocol";

/**
 * TTS playback via a ring-buffer AudioWorklet. Audio arrives as raw binary
 * WS frames (24 kHz mono int16 PCM) already split from their 4-byte
 * segment-id header by ws.ts; `tts.segment` announces a new id, `tts.flush`
 * means "drop everything buffered, instantly" (barge-in).
 *
 * Staleness model: every binary frame's segment id is compared against
 * `minValidSegment`. A flush bumps that watermark past the highest id seen
 * so far, so any audio for a segment that predates the flush is dropped
 * even if it arrives (network-reordered) after the flush call returns.
 */
export class Player {
  private readonly ctx: AudioContext;
  private readonly analyser: AnalyserNode;
  private readonly levelBuf: Uint8Array<ArrayBuffer>;
  private readonly ratio: number; // TTS_SAMPLE_RATE / ctx.sampleRate
  private node: AudioWorkletNode | null = null;
  private readonly ready: Promise<void>;

  private maxSeenSegment = -1;
  private minValidSegment = 0;

  constructor() {
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: TTS_SAMPLE_RATE });
    } catch {
      ctx = new AudioContext();
    }
    this.ctx = ctx;
    this.ratio = TTS_SAMPLE_RATE / ctx.sampleRate;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.levelBuf = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));

    this.ready = this.setup();
  }

  private async setup(): Promise<void> {
    await this.ctx.audioWorklet.addModule("/worklets/player-processor.js");
    const node = new AudioWorkletNode(this.ctx, "player-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    node.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.node = node;
  }

  /** Must be called from a user gesture (e.g. first PTT press) on browsers that start contexts suspended. */
  async resume(): Promise<void> {
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  /** Call when a `tts.segment` announcement arrives, before its audio. */
  onSegmentStart(id: number): void {
    this.maxSeenSegment = Math.max(this.maxSeenSegment, id);
  }

  async pushAudio(segmentId: number, pcm: ArrayBuffer): Promise<void> {
    if (segmentId < this.minValidSegment) return; // stale: predates the last flush
    this.maxSeenSegment = Math.max(this.maxSeenSegment, segmentId);

    await this.ready;
    // Re-check after the await: a flush() may have run while we yielded, and
    // its message would reach the worklet *before* this push (MessagePort is
    // FIFO), re-adding stale audio to a freshly cleared ring.
    if (segmentId < this.minValidSegment) return;
    const int16 = new Int16Array(pcm);
    const samples = this.resample(int16);
    const buf = samples.buffer;
    // The worklet enforces the watermark too (belt and braces): pushes carry
    // their segment id, flushes carry the new minimum.
    this.node?.port.postMessage({ type: "push", segmentId, samples: buf }, [buf]);
  }

  private resample(int16: Int16Array): Float32Array {
    if (this.ratio === 1) {
      const out = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) out[i] = int16[i] / 32768;
      return out;
    }
    const outLen = Math.max(0, Math.floor(int16.length / this.ratio));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcPos = i * this.ratio;
      const i0 = Math.floor(srcPos);
      const frac = srcPos - i0;
      const s0 = int16[i0] ?? 0;
      const s1 = int16[i0 + 1] ?? s0;
      out[i] = (s0 + (s1 - s0) * frac) / 32768;
    }
    return out;
  }

  /** Drop all buffered audio instantly (barge-in / server tts.flush). */
  flush(): void {
    this.minValidSegment = this.maxSeenSegment + 1;
    this.node?.port.postMessage({ type: "flush", minValid: this.minValidSegment });
  }

  /** 0..1 RMS level of what's currently playing, for orb pulsing. */
  getLevel(): number {
    this.analyser.getByteTimeDomainData(this.levelBuf);
    let sumSquares = 0;
    for (let i = 0; i < this.levelBuf.length; i++) {
      const v = (this.levelBuf[i] - 128) / 128;
      sumSquares += v * v;
    }
    return Math.min(1, Math.sqrt(sumSquares / this.levelBuf.length) * 4);
  }
}
