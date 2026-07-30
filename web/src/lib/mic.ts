import { MIC_SAMPLE_RATE } from "@loqui/protocol";

const FRAME_MS = 20;
const FRAME_SAMPLES = (MIC_SAMPLE_RATE * FRAME_MS) / 1000; // 320 samples @ 16 kHz

export type MicHandlers = {
  /** A ~20ms frame of 16 kHz mono int16 PCM, ready to ship over the WS. */
  onFrame: (pcm: ArrayBuffer) => void;
  /** 0..1 RMS level, ~60fps, for driving the orb/mic-ring visuals. */
  onLevel?: (level: number) => void;
};

/**
 * Push-to-talk mic capture: getUserMedia -> AudioWorklet that
 * downsamples/converts to 16 kHz mono int16 PCM frames.
 *
 * Some browsers refuse `new AudioContext({ sampleRate: 16000 })` and fall
 * back to the device's native rate; the worklet is told the *actual*
 * context rate and resamples itself, so this works either way.
 */
export class MicCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private silentGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private levelBuf: Uint8Array<ArrayBuffer> | null = null;
  private levelRaf = 0;

  constructor(private readonly handlers: MicHandlers) {}

  get isActive(): boolean {
    return this.stream !== null;
  }

  async start(): Promise<void> {
    if (this.stream) return;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    this.stream = stream;

    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: MIC_SAMPLE_RATE });
    } catch {
      ctx = new AudioContext();
    }
    if (ctx.state === "suspended") await ctx.resume();
    this.ctx = ctx;

    await ctx.audioWorklet.addModule("/worklets/mic-processor.js");

    const source = ctx.createMediaStreamSource(stream);
    this.source = source;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    this.analyser = analyser;
    this.levelBuf = new Uint8Array(new ArrayBuffer(analyser.fftSize));
    source.connect(analyser);

    const workletNode = new AudioWorkletNode(ctx, "mic-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: {
        inputSampleRate: ctx.sampleRate,
        targetSampleRate: MIC_SAMPLE_RATE,
        frameSamples: FRAME_SAMPLES,
      },
    });
    workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      this.handlers.onFrame(event.data);
    };
    source.connect(workletNode);

    // Worklets without a live downstream connection aren't reliably pulled
    // by every audio graph implementation; route through a muted gain so
    // it keeps ticking without producing an audible mic-monitor loop.
    const silentGain = ctx.createGain();
    silentGain.gain.value = 0;
    workletNode.connect(silentGain);
    silentGain.connect(ctx.destination);
    this.silentGain = silentGain;
    this.workletNode = workletNode;

    this.pollLevel();
  }

  private pollLevel = (): void => {
    if (!this.analyser || !this.levelBuf) return;
    this.analyser.getByteTimeDomainData(this.levelBuf);
    let sumSquares = 0;
    for (let i = 0; i < this.levelBuf.length; i++) {
      const v = (this.levelBuf[i] - 128) / 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / this.levelBuf.length);
    this.handlers.onLevel?.(Math.min(1, rms * 4));
    this.levelRaf = requestAnimationFrame(this.pollLevel);
  };

  stop(): void {
    cancelAnimationFrame(this.levelRaf);
    this.workletNode?.port.close();
    this.workletNode?.disconnect();
    this.silentGain?.disconnect();
    this.analyser?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.ctx?.close();

    this.stream = null;
    this.ctx = null;
    this.source = null;
    this.workletNode = null;
    this.silentGain = null;
    this.analyser = null;
    this.levelBuf = null;
    this.handlers.onLevel?.(0);
  }
}
