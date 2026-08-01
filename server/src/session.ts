/**
 * The single-voice-session state machine.
 *
 *   idle -> listening -> thinking -> speaking -> listening (open-mic loop)
 *
 * Multiple WS clients may connect (phone + desktop); all receive state and
 * broadcasts. Mic binary is accepted only from the client that sent
 * session.start (last-writer-wins). Barge-in from speaking/thinking flushes TTS
 * and interrupts the agent.
 *
 * STT is streaming when the adapter supports it (stt.adapter "deepgram-ws"): the
 * WS opens lazily on the first mic frame, frames relay live, and each confirmed
 * segment is broadcast immediately (live transcript) as well as accumulated. On
 * utterance.end we Finalize, await the tail, and join the segments. If the single
 * -session engine is busy or the socket fails, we fall back to the batch path
 * using the PCM buffered up to that point (when stt.batchFallback is set).
 */

import type { WebSocket } from "ws";
import {
  type ClientMessage,
  type ServerMessage,
  type SessionState,
  TTS_SEGMENT_HEADER_BYTES,
} from "@loqui/protocol";
import type { LoquiConfig } from "./config.js";
import { ClaudeSession } from "./claude-session.js";
import type { SttAdapter, SttStream } from "./stt.js";
import { TtsQueue, type TtsAdapter } from "./tts.js";
import { SentenceChunker } from "./chunker.js";
import { VaultLog } from "./vault-log.js";

const KOKORO_VOICES = ["af_heart", "af_bella", "af_sky", "am_adam", "bf_emma"];

/** How long to wait for the streaming engine's tail segment after Finalize. */
const FINALIZE_TAIL_MS = 4000;

type SttStreamState = "none" | "connecting" | "open" | "failed";

export class VoiceSession {
  private state: SessionState = "idle";
  private readonly clients = new Set<WebSocket>();
  private micOwner: WebSocket | null = null;

  // mic accumulation (listening) — also the pre-open / batch-fallback buffer.
  private pcmParts: Int16Array[] = [];
  private pcmLen = 0;

  // streaming STT
  private readonly streaming: boolean;
  private readonly batchFallback: boolean;
  private sttStream: SttStream | null = null;
  private sttStreamState: SttStreamState = "none";
  private sttSegments: string[] = [];

  // per-turn
  private chunker = new SentenceChunker();
  private currentUserText = "";
  private currentAssistantText = "";
  private resultReceived = false;
  private lastCostUsd: number | undefined;
  private segmentSeq = 0;

  // per-turn timings
  private turnAgentStart = 0;
  private turnFirstDeltaAt = 0;
  private turnFirstAudioAt = 0;
  private turnSttMs: number | undefined;

  // effective config
  private modelKey: string;
  private voice: string;
  private speed: number;

  private readonly claude: ClaudeSession;
  private readonly ttsQueue: TtsQueue;
  private readonly vaultLog: VaultLog;

  constructor(
    private readonly cfg: LoquiConfig,
    private readonly stt: SttAdapter,
    tts: TtsAdapter,
    claude: ClaudeSession,
  ) {
    this.modelKey = claude.model || cfg.agent.defaultModel;
    this.voice = cfg.tts.voice;
    this.speed = cfg.tts.speed;
    this.claude = claude;
    this.vaultLog = new VaultLog(cfg.log.conversationsDir);
    this.streaming =
      cfg.stt.adapter === "deepgram-ws" && typeof stt.openStream === "function";
    this.batchFallback = cfg.stt.batchFallback !== false;

    this.ttsQueue = new TtsQueue(
      tts,
      () => ({ voice: this.voice, speed: this.speed }),
      {
        onStart: (id, text) => {
          if (this.state !== "speaking") this.setState("speaking");
          this.broadcast({ type: "tts.segment", id, text });
        },
        onChunk: (id, pcm) => this.broadcastAudio(id, pcm),
        onDone: () => this.maybeFinishTurn(),
        onError: (_id, err) =>
          this.broadcast({ type: "error", message: `speech error: ${err.message}` }),
      },
    );

    // Persistent agent callbacks drive the current turn.
    this.claude.setCallbacks({
      onDelta: (text) => this.onAgentDelta(text),
      onToolActivity: (a) =>
        this.broadcast({ type: "tool.activity", tool: a.tool, detail: a.detail }),
      onResult: (r) => this.onAgentResult(r.costUsd),
      onInit: (info) => {
        if (info.model) {
          // reflect the model the agent actually reports
        }
      },
      onError: (message) => this.broadcast({ type: "error", message }),
    });
  }

  // ---- client lifecycle ----------------------------------------------------

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    this.sendTo(ws, this.configMessage());
    this.sendTo(ws, { type: "state", value: this.state });

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) this.onBinary(ws, data);
      else this.onText(ws, data);
    });
    ws.on("close", () => {
      this.clients.delete(ws);
      if (this.micOwner === ws) this.micOwner = null;
    });
    ws.on("error", () => {
      this.clients.delete(ws);
      if (this.micOwner === ws) this.micOwner = null;
    });
  }

  // ---- inbound -------------------------------------------------------------

  private onText(ws: WebSocket, data: Buffer): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString()) as ClientMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "session.start":
        this.micOwner = ws;
        this.teardownSttStream();
        this.resetMic();
        this.setState("listening");
        break;
      case "session.stop":
        this.teardownSttStream();
        this.resetMic();
        this.setState("idle");
        break;
      case "utterance.end":
        void this.finalizeUtterance();
        break;
      case "barge_in":
        this.bargeIn();
        break;
      case "text.prompt":
        void this.runTextPrompt(msg.text);
        break;
      case "config.set":
        void this.applyConfig(msg);
        break;
      case "session.new":
        void this.claude.newConversation().catch((e) =>
          this.broadcast({ type: "error", message: `new session failed: ${String(e)}` }),
        );
        break;
      default:
        break;
    }
  }

  private onBinary(ws: WebSocket, data: Buffer): void {
    // Only the mic owner, only while listening.
    if (ws !== this.micOwner || this.state !== "listening") return;
    const usable = data.length - (data.length % 2);
    if (usable <= 0) return;

    if (this.streaming) {
      if (this.sttStreamState === "none") this.openSttStream();
      if (this.sttStreamState === "open" && this.sttStream) {
        // Relay live. `data` is a fresh per-message buffer, so a view is safe.
        this.sttStream.pushPcm(data.subarray(0, usable));
        return;
      }
      // connecting / failed: fall through and buffer (pre-open relay + fallback)
    }

    const view = new Int16Array(
      data.buffer.slice(data.byteOffset, data.byteOffset + usable),
    );
    this.pcmParts.push(view);
    this.pcmLen += view.length;
  }

  // ---- streaming STT -------------------------------------------------------

  private openSttStream(): void {
    this.sttStreamState = "connecting";
    this.sttSegments = [];
    let stream: SttStream;
    try {
      stream = this.stt.openStream!();
    } catch {
      this.sttStreamState = "failed";
      return;
    }
    this.sttStream = stream;
    stream.onSegment((text) => this.onSttSegment(text));
    stream
      .ready()
      .then(() => {
        // Superseded (stopped / barged / finalized) while connecting: discard.
        if (this.sttStream !== stream || this.sttStreamState !== "connecting") {
          try {
            stream.close();
          } catch {
            /* ignore */
          }
          return;
        }
        this.sttStreamState = "open";
        // Flush the pre-open buffer into the stream, then drop it (no longer
        // needed for fallback now that the stream is healthy).
        if (this.pcmLen > 0) {
          const pcm = this.collectPcm();
          stream.pushPcm(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
        }
      })
      .catch((err) => {
        if (this.sttStream !== stream) return;
        this.sttStreamState = "failed";
        this.sttStream = null;
        process.stderr.write(
          `[stt-stream] connect failed, falling back to batch: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
        try {
          stream.close();
        } catch {
          /* ignore */
        }
        // pcmParts is intact -> batch path will use it at utterance.end.
      });
  }

  private onSttSegment(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.sttSegments.push(t);
    // Live transcript: show the confirmed segment immediately.
    this.broadcast({ type: "stt.segment", text: t, final: true });
  }

  private teardownSttStream(): void {
    const s = this.sttStream;
    this.sttStream = null;
    this.sttStreamState = "none";
    this.sttSegments = [];
    if (s) {
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
  }

  // ---- turn flow -----------------------------------------------------------

  private resetMic(): void {
    this.pcmParts = [];
    this.pcmLen = 0;
  }

  private collectPcm(): Int16Array {
    const out = new Int16Array(this.pcmLen);
    let off = 0;
    for (const part of this.pcmParts) {
      out.set(part, off);
      off += part.length;
    }
    this.resetMic();
    return out;
  }

  private async finalizeUtterance(): Promise<void> {
    if (this.state !== "listening") return;
    this.setState("thinking");
    const sttStart = Date.now();
    let transcript = "";
    let usedStream = false;

    if (this.streaming && this.sttStreamState === "open" && this.sttStream) {
      const stream = this.sttStream;
      usedStream = true;
      try {
        await stream.finalize(FINALIZE_TAIL_MS);
      } catch {
        /* use whatever segments we already have */
      }
      transcript = this.sttSegments.join(" ").replace(/\s+/g, " ").trim();
      // Segments were already broadcast live; tear the stream down.
      this.teardownSttStream();
    }

    if (!usedStream) {
      // Batch path: streaming disabled, failed, or never opened in time.
      const hadStreamAttempt =
        this.streaming && this.sttStreamState !== "none";
      this.teardownSttStream();
      if (this.streaming && !this.batchFallback && hadStreamAttempt) {
        this.broadcast({ type: "error", message: "transcriber busy" });
        this.resetMic();
        this.setState("listening");
        return;
      }
      const pcm = this.collectPcm();
      try {
        transcript = await this.stt.transcribeUtterance(pcm);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.broadcast({ type: "error", message });
        this.setState("listening");
        return;
      }
      this.broadcast({ type: "stt.segment", text: transcript, final: true });
    }

    this.turnSttMs = Date.now() - sttStart;

    if (!transcript) {
      this.setState("listening");
      return;
    }
    await this.startAgentTurn(transcript);
  }

  private async runTextPrompt(text: string): Promise<void> {
    const t = (text ?? "").trim();
    if (!t) return;
    this.turnSttMs = undefined; // no STT stage for a typed prompt
    this.setState("thinking");
    await this.startAgentTurn(t);
  }

  private async startAgentTurn(userText: string): Promise<void> {
    this.currentUserText = userText;
    this.currentAssistantText = "";
    this.resultReceived = false;
    this.lastCostUsd = undefined;
    this.turnAgentStart = Date.now();
    this.turnFirstDeltaAt = 0;
    this.turnFirstAudioAt = 0;
    this.chunker.reset();
    try {
      await this.claude.sendUser(userText);
    } catch (err) {
      this.broadcast({
        type: "error",
        message: `agent error: ${err instanceof Error ? err.message : String(err)}`,
      });
      this.setState("listening");
    }
  }

  private onAgentDelta(text: string): void {
    if (!text) return;
    if (!this.turnFirstDeltaAt) this.turnFirstDeltaAt = Date.now();
    this.currentAssistantText += text;
    this.broadcast({ type: "assistant.delta", text });
    for (const sentence of this.chunker.push(text)) {
      this.enqueueSpeech(sentence);
    }
  }

  private onAgentResult(costUsd?: number): void {
    this.resultReceived = true;
    this.lastCostUsd = costUsd;
    // Flush any trailing partial sentence to TTS.
    for (const sentence of this.chunker.flush()) {
      this.enqueueSpeech(sentence);
    }

    const timings: { sttMs?: number; ttfbMs?: number; firstAudioMs?: number } = {};
    if (this.turnSttMs !== undefined) timings.sttMs = this.turnSttMs;
    if (this.turnFirstDeltaAt) {
      timings.ttfbMs = this.turnFirstDeltaAt - this.turnAgentStart;
    }
    if (this.turnFirstAudioAt) {
      timings.firstAudioMs = this.turnFirstAudioAt - this.turnAgentStart;
    }
    const hasTimings = Object.keys(timings).length > 0;

    this.broadcast({
      type: "assistant.done",
      text: this.currentAssistantText,
      costUsd,
      ...(hasTimings ? { timings } : {}),
    });

    process.stdout.write(
      `[turn] stt=${timings.sttMs ?? "-"}ms ttfb=${timings.ttfbMs ?? "-"}ms ` +
        `firstAudio=${timings.firstAudioMs ?? "-"}ms cost=${costUsd ?? "-"}\n`,
    );

    // Persist the turn (best effort).
    void this.vaultLog
      .appendTurn(this.currentUserText, this.currentAssistantText, costUsd)
      .catch((e) => process.stderr.write(`[vault-log] ${String(e)}\n`));
    this.maybeFinishTurn();
  }

  private enqueueSpeech(sentence: string): void {
    if (!sentence) return;
    this.segmentSeq += 1;
    this.ttsQueue.enqueue(this.segmentSeq, sentence);
  }

  /** Transition to listening once the agent turn is done AND TTS has drained. */
  private maybeFinishTurn(): void {
    if (!this.resultReceived) return;
    if (this.ttsQueue.busy) return;
    if (this.state !== "idle") this.setState("listening");
  }

  private bargeIn(): void {
    if (this.state !== "speaking" && this.state !== "thinking") return;
    this.ttsQueue.flush();
    this.broadcast({ type: "tts.flush" });
    this.claude.interrupt();
    this.teardownSttStream();
    this.resultReceived = false;
    this.setState("listening");
  }

  private async applyConfig(msg: {
    model?: string;
    voice?: string;
    speed?: number;
  }): Promise<void> {
    if (typeof msg.voice === "string" && msg.voice) this.voice = msg.voice;
    if (typeof msg.speed === "number" && msg.speed > 0) this.speed = msg.speed;
    if (
      typeof msg.model === "string" &&
      msg.model &&
      msg.model !== this.modelKey
    ) {
      if (!this.cfg.agent.models[msg.model]) {
        this.broadcast({ type: "error", message: `unknown model: ${msg.model}` });
      } else {
        this.modelKey = msg.model;
        try {
          await this.claude.switchModel(msg.model);
        } catch (err) {
          this.broadcast({
            type: "error",
            message: `model switch failed: ${String(err)}`,
          });
        }
      }
    }
    this.broadcast(this.configMessage());
  }

  // ---- outbound ------------------------------------------------------------

  private setState(value: SessionState, reason?: string): void {
    this.state = value;
    this.broadcast(reason ? { type: "state", value, reason } : { type: "state", value });
  }

  private configMessage(): ServerMessage {
    return {
      type: "config",
      model: this.modelKey,
      models: Object.keys(this.cfg.agent.models),
      voice: this.voice,
      voices: KOKORO_VOICES,
      speed: this.speed,
    };
  }

  private broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) this.rawSend(ws, data);
  }

  private sendTo(ws: WebSocket, msg: ServerMessage): void {
    this.rawSend(ws, JSON.stringify(msg));
  }

  private rawSend(ws: WebSocket, data: string): void {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(data);
      } catch {
        /* ignore */
      }
    }
  }

  private broadcastAudio(id: number, pcm: Buffer): void {
    if (!this.turnFirstAudioAt) this.turnFirstAudioAt = Date.now();
    const head = Buffer.alloc(TTS_SEGMENT_HEADER_BYTES);
    head.writeUInt32LE(id >>> 0, 0);
    const frame = Buffer.concat([head, pcm]);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(frame, { binary: true });
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** Current health snapshot for /healthz. */
  snapshot(): {
    state: SessionState;
    model: string;
    clients: number;
    agentAlive: boolean;
  } {
    return {
      state: this.state,
      model: this.modelKey,
      clients: this.clients.size,
      agentAlive: this.claude.isAlive,
    };
  }
}
