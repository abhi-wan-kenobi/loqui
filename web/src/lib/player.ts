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

  // Streaming-resampler state, carried across chunks of a single segment so the
  // per-chunk interpolation seam stays continuous (no click at chunk joins).
  // `resSegment` is the segment these belong to; a new id or a flush resets it.
  private resSegment = -1;
  private resPos = 1; // read position in the virtual [prevSample, ...chunk] array
  private resPrev = 0; // last input sample of the previous chunk, normalised -1..1
  private warnedOddLength = false;

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
      processorOptions: {
        // Jitter buffer: hold a fresh segment until ~150 ms is buffered (or the
        // segment ends). Samples in the ring are at the ctx rate, so 150 ms
        // scales with the device rate automatically (3600 @ 24 kHz).
        primeThresholdSamples: Math.round(this.ctx.sampleRate * 0.15),
      },
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

    // Belt-and-braces: the server guarantees even-length int16 payloads, but a
    // stray odd byte would misalign the whole Int16Array. Drop the trailing
    // byte and warn once per session rather than corrupt playback.
    if ((pcm.byteLength & 1) !== 0) {
      if (!this.warnedOddLength) {
        console.warn("[player] odd-length TTS payload; truncating trailing byte");
        this.warnedOddLength = true;
      }
      pcm = pcm.slice(0, pcm.byteLength - 1);
    }

    await this.ready;
    // Re-check after the await: a flush() may have run while we yielded, and
    // its message would reach the worklet *before* this push (MessagePort is
    // FIFO), re-adding stale audio to a freshly cleared ring.
    if (segmentId < this.minValidSegment) return;

    // New segment → reset the streaming-resampler seam so we don't interpolate
    // across a segment boundary.
    if (segmentId !== this.resSegment) {
      this.resSegment = segmentId;
      this.resPos = 1;
      this.resPrev = 0;
    }

    const int16 = new Int16Array(pcm);
    const samples = this.resample(int16);
    const buf = samples.buffer;
    // The worklet enforces the watermark too (belt and braces): pushes carry
    // their segment id, flushes carry the new minimum.
    this.node?.port.postMessage({ type: "push", segmentId, samples: buf }, [buf]);
  }

  /**
   * Streaming linear resampler. State (`resPos`, `resPrev`) carries across the
   * chunks of one segment so the interpolation is continuous at chunk joins —
   * the last sample of a chunk feeds the first output of the next chunk. Reset
   * on a new segment id or a flush.
   *
   * Virtual input for a chunk is V = [resPrev, s0, s1, ..., s(N-1)] (length
   * N+1). `resPos` reads through V; on the first chunk of a segment it starts
   * at 1 (pointing at s0, so playback begins at the true segment start).
   */
  private resample(int16: Int16Array): Float32Array {
    const n = int16.length;
    if (n === 0) return new Float32Array(0);

    if (this.ratio === 1) {
      // Identity: no interpolation, no seam. Keep resPrev current in case a
      // later chunk resamples (ratio can't change mid-run, but be safe).
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = int16[i] / 32768;
      this.resPrev = int16[n - 1] / 32768;
      return out;
    }

    const sampleAt = (idx: number): number => (idx === 0 ? this.resPrev : int16[idx - 1] / 32768);

    const maxOut = Math.ceil((n + 1 - this.resPos) / this.ratio) + 1;
    const out = new Float32Array(Math.max(0, maxOut));
    let count = 0;
    // Need V[i0] and V[i0+1]; the highest valid index is N, so continue while
    // floor(resPos) + 1 <= N.
    while (Math.floor(this.resPos) + 1 <= n) {
      const i0 = Math.floor(this.resPos);
      const frac = this.resPos - i0;
      const s0 = sampleAt(i0);
      const s1 = sampleAt(i0 + 1);
      out[count++] = s0 + (s1 - s0) * frac;
      this.resPos += this.ratio;
    }

    // The current chunk's last sample becomes the next chunk's prevSample
    // (new V[0]); shift resPos into the next chunk's coordinate space.
    this.resPrev = int16[n - 1] / 32768;
    this.resPos -= n;

    return count === out.length ? out : out.slice(0, count);
  }

  /** Drop all buffered audio instantly (barge-in / server tts.flush). */
  flush(): void {
    this.minValidSegment = this.maxSeenSegment + 1;
    // Force the next segment to re-prime the jitter buffer and start a fresh
    // resampler seam.
    this.resSegment = -1;
    this.node?.port.postMessage({ type: "flush", minValid: this.minValidSegment });
  }

  /**
   * Mark the current TTS segment complete. Lets the worklet release a final
   * short segment (< the jitter threshold) instead of holding it, and re-arm
   * the jitter buffer once it drains. Call when playback ends (state leaves
   * `speaking`).
   */
  endSegment(): void {
    this.node?.port.postMessage({ type: "end" });
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
