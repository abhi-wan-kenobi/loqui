/**
 * Loqui client<->server WebSocket protocol.
 *
 * One multiplexed WS connection carries JSON text frames (control) and binary
 * frames (audio) in both directions:
 *   client -> server binary: 16 kHz mono int16 PCM mic frames
 *   server -> client binary: 24 kHz mono int16 PCM TTS audio, prefixed with a
 *     4-byte little-endian uint32 segment id (so stale segments are droppable
 *     after a `tts.flush`).
 */

export type SessionState = "idle" | "listening" | "thinking" | "speaking";

// ---------- client -> server ----------

export type ClientMessage =
  | { type: "session.start" }
  | { type: "session.stop" }
  /** Client VAD says the user stopped talking; finalize the utterance. */
  | { type: "utterance.end" }
  /** User spoke or tapped while the assistant was speaking. */
  | { type: "barge_in" }
  /** Typed fallback path (also the v0.1 test path). */
  | { type: "text.prompt"; text: string }
  | { type: "config.set"; model?: string; voice?: string; speed?: number }
  /** Rotate to a fresh agent conversation. */
  | { type: "session.new" };

// ---------- server -> client ----------

export type ServerMessage =
  | { type: "state"; value: SessionState; reason?: string }
  /** Confirmed STT segment (the STT engine emits finalized segments only). */
  | { type: "stt.segment"; text: string; final: boolean }
  /** Incremental assistant text (token/sentence granularity). */
  | { type: "assistant.delta"; text: string }
  | {
      type: "assistant.done";
      text: string;
      costUsd?: number;
      /** Per-stage latency breakdown for the turn (debug row in the app). */
      timings?: { sttMs?: number; ttfbMs?: number; firstAudioMs?: number };
    }
  /** Agent is using a tool (orb shimmer + caption, e.g. Grep over the vault). */
  | { type: "tool.activity"; tool: string; detail?: string }
  /** A TTS segment is about to stream; binary frames carry this id. */
  | { type: "tts.segment"; id: number; text: string }
  /** Drop all buffered TTS audio immediately (barge-in). */
  | { type: "tts.flush" }
  /** Current effective config (sent on connect and after config.set). */
  | {
      type: "config";
      model: string;
      models: string[];
      voice: string;
      voices?: string[];
      speed: number;
    }
  | { type: "error"; message: string; fatal?: boolean };

// ---------- audio framing ----------

export const MIC_SAMPLE_RATE = 16000;
export const TTS_SAMPLE_RATE = 24000;
/** Bytes of the uint32-LE segment-id prefix on server->client binary frames. */
export const TTS_SEGMENT_HEADER_BYTES = 4;
