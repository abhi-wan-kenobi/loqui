import { MicVAD } from "@ricky0123/vad-web";

export type VadHandlers = {
  /** Fired when the user starts speaking. */
  onSpeechStart: () => void;
  /** Fired when the user stops speaking; `audio` is 16 kHz mono float PCM. */
  onSpeechEnd: (audio: Float32Array) => void;
};

/**
 * Thin wrapper around `@ricky0123/vad-web`'s MicVAD. All assets are
 * SELF-HOSTED under `/vad/` (copied at build time by
 * scripts/copy-vad-assets.mjs) — no CDN. The VAD reads the *same* MediaStream
 * as the capture pipeline (passed via `getStream`) so the mic is only opened
 * once; `pauseStream`/`resumeStream` are neutered so the VAD never stops the
 * shared capture track when it pauses.
 */
export class VoiceActivity {
  private vad: MicVAD | null = null;
  private destroyed = false;

  async start(getStream: () => MediaStream, handlers: VadHandlers): Promise<void> {
    this.destroyed = false;
    const vad = await MicVAD.new({
      baseAssetPath: "/vad/",
      onnxWASMBasePath: "/vad/",
      // Share the capture pipeline's stream — never open a second mic.
      getStream: async () => getStream(),
      pauseStream: async () => {},
      resumeStream: async () => getStream(),
      onSpeechStart: handlers.onSpeechStart,
      onSpeechEnd: handlers.onSpeechEnd,
      startOnLoad: true,
    });
    // A destroy() may have raced in while we were loading the model.
    if (this.destroyed) {
      await vad.destroy();
      return;
    }
    this.vad = vad;
  }

  /** Pause detection (half-duplex: while the assistant is speaking). */
  pause(): void {
    void this.vad?.pause();
  }

  /** Resume detection after a pause. */
  resume(): void {
    void this.vad?.start();
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    const vad = this.vad;
    this.vad = null;
    if (vad) await vad.destroy().catch(() => undefined);
  }

  get isActive(): boolean {
    return this.vad !== null;
  }
}
