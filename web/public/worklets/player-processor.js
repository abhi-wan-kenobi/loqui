// AudioWorkletProcessor implementing a simple ring buffer for TTS playback.
// The main thread pushes Float32 sample chunks (already resampled to the
// AudioContext's actual rate); process() drains them out, filling silence
// when starved. A "flush" message (barge-in / tts.flush) resets the ring
// instantly, dropping everything buffered.
//
// Jitter buffer: a freshly starting segment is held (output silence) until
// ~150ms is buffered OR the segment-end marker arrives, so a bursty network
// start doesn't chop the first words. The threshold is a constructor param
// (primeThresholdSamples, at the ctx sample rate). Once primed, the existing
// behaviour (silence on transient starve) is kept; the buffer only re-arms
// after an ended segment fully drains, or on flush.
//
// The watermark is enforced HERE as well as on the main thread: a push whose
// main-thread staleness check passed before a flush can still arrive after
// the flush message (the check-then-postMessage window), so pushes carry
// their segment id and flushes carry the new minimum valid id.

class PlayerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // `sampleRate` is a global in AudioWorkletGlobalScope.
    this.capacity = sampleRate * 10; // 10s ceiling, generous for a TTS segment queue
    this.buffer = new Float32Array(this.capacity);
    this.writeIdx = 0;
    this.readIdx = 0;
    this.available = 0;
    this.minValidSegment = 0;

    const opts = (options && options.processorOptions) || {};
    this.primeThreshold =
      typeof opts.primeThresholdSamples === "number"
        ? opts.primeThresholdSamples
        : Math.round(sampleRate * 0.15);
    // `primed` gates the jitter buffer; `ended` marks the current segment as
    // complete so a sub-threshold final segment can still play and the buffer
    // re-arms once it drains.
    this.primed = false;
    this.ended = false;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === "push") {
        if (typeof msg.segmentId === "number" && msg.segmentId < this.minValidSegment) {
          return; // stale segment that raced past a flush — drop at insertion
        }
        this._push(new Float32Array(msg.samples));
      } else if (msg.type === "flush") {
        if (typeof msg.minValid === "number") this.minValidSegment = msg.minValid;
        this.readIdx = this.writeIdx;
        this.available = 0;
        this.primed = false;
        this.ended = false;
      } else if (msg.type === "end") {
        // Segment finished: release even if under the jitter threshold.
        this.ended = true;
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

    // Jitter buffer: hold a fresh segment until it's buffered enough or ended.
    if (!this.primed) {
      if (this.available >= this.primeThreshold || this.ended) {
        this.primed = true;
      } else {
        for (let i = 0; i < out.length; i++) out[i] = 0;
        return true;
      }
    }

    for (let i = 0; i < out.length; i++) {
      if (this.available > 0) {
        out[i] = this.buffer[this.readIdx];
        this.readIdx = (this.readIdx + 1) % this.capacity;
        this.available--;
      } else {
        out[i] = 0;
      }
    }

    // Re-arm only when an *ended* segment has fully drained; a transient
    // mid-segment starve keeps playing silence without re-jittering.
    if (this.available === 0 && this.ended) {
      this.primed = false;
      this.ended = false;
    }

    return true;
  }
}

registerProcessor("player-processor", PlayerProcessor);
