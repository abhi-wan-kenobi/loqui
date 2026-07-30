// AudioWorkletProcessor implementing a simple ring buffer for TTS playback.
// The main thread pushes Float32 sample chunks (already resampled to the
// AudioContext's actual rate); process() drains them out, filling silence
// when starved. A "flush" message (barge-in / tts.flush) resets the ring
// instantly, dropping everything buffered.

class PlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is a global in AudioWorkletGlobalScope.
    this.capacity = sampleRate * 10; // 10s ceiling, generous for a TTS segment queue
    this.buffer = new Float32Array(this.capacity);
    this.writeIdx = 0;
    this.readIdx = 0;
    this.available = 0;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === "push") {
        this._push(new Float32Array(msg.samples));
      } else if (msg.type === "flush") {
        this.readIdx = this.writeIdx;
        this.available = 0;
      }
    };
  }

  _push(samples) {
    for (let i = 0; i < samples.length; i++) {
      if (this.available >= this.capacity) {
        // Overflow (shouldn't happen at normal speech rates): drop oldest.
        this.readIdx = (this.readIdx + 1) % this.capacity;
        this.available--;
      }
      this.buffer[this.writeIdx] = samples[i];
      this.writeIdx = (this.writeIdx + 1) % this.capacity;
      this.available++;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    for (let i = 0; i < out.length; i++) {
      if (this.available > 0) {
        out[i] = this.buffer[this.readIdx];
        this.readIdx = (this.readIdx + 1) % this.capacity;
        this.available--;
      } else {
        out[i] = 0;
      }
    }
    return true;
  }
}

registerProcessor("player-processor", PlayerProcessor);
