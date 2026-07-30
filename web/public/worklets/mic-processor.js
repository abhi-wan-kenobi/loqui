// AudioWorkletProcessor that downsamples the mic input to a target sample
// rate (16 kHz for Loqui) and int16 PCM, posting fixed-size frames
// (~20 ms) back to the main thread as transferable ArrayBuffers.
//
// Resampling is plain linear interpolation, which is fine for speech at
// this ratio. Handles the case where the AudioContext refused a fixed
// 16 kHz constructor rate by resampling from whatever `inputSampleRate`
// actually is.

class MicProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { inputSampleRate, targetSampleRate, frameSamples } = options.processorOptions;
    this.ratio = inputSampleRate / targetSampleRate;
    this.frameSamples = frameSamples;

    // Rolling buffer of not-yet-consumed input samples (carries partial
    // interpolation state across render quanta).
    this.inputBuf = new Float32Array(0);
    this.readPos = 0; // fractional index into inputBuf for the next output sample

    this.outBuffer = new Int16Array(this.frameSamples);
    this.outIndex = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;

    const merged = new Float32Array(this.inputBuf.length + channel.length);
    merged.set(this.inputBuf, 0);
    merged.set(channel, this.inputBuf.length);
    this.inputBuf = merged;

    while (Math.floor(this.readPos) + 1 < this.inputBuf.length) {
      const i0 = Math.floor(this.readPos);
      const frac = this.readPos - i0;
      const s0 = this.inputBuf[i0];
      const s1 = this.inputBuf[i0 + 1];
      const sample = s0 + (s1 - s0) * frac;
      const clamped = Math.max(-1, Math.min(1, sample));
      this.outBuffer[this.outIndex++] = clamped < 0 ? clamped * 32768 : clamped * 32767;

      if (this.outIndex >= this.frameSamples) {
        const buf = this.outBuffer.buffer.slice(0);
        this.port.postMessage(buf, [buf]);
        this.outIndex = 0;
      }

      this.readPos += this.ratio;
    }

    // Clamp: on a boundary iteration readPos can float past the buffer end;
    // slice() would silently clamp while readPos kept the unclamped value,
    // leaving readPos negative next frame (glitched first sample).
    const consumed = Math.min(Math.floor(this.readPos), this.inputBuf.length);
    if (consumed > 0) {
      this.inputBuf = this.inputBuf.slice(consumed);
      this.readPos -= consumed;
    }

    return true;
  }
}

registerProcessor("mic-processor", MicProcessor);
