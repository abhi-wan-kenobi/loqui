#!/usr/bin/env node
// Canned WS server for manually sanity-checking the web client without a real
// loqui server. Exercises the open-mic flow: live streaming stt.segment frames
// WHILE listening, a mid-stream tts.flush, and per-stage timings on
// assistant.done. No binary audio frames (the player just sees state/segment
// flow).
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 8443;
const wss = new WebSocketServer({ port: PORT, path: "/ws" });
console.log(`[mock] loqui server on ws://localhost:${PORT}/ws`);

const send = (ws, msg) => ws.send(JSON.stringify(msg));

wss.on("connection", (ws) => {
  console.log("[mock] client connected");
  send(ws, {
    type: "config",
    model: "mock-model",
    models: ["mock-model"],
    voice: "mock-voice",
    voices: ["mock-voice"],
    speed: 1,
  });
  send(ws, { type: "state", value: "idle" });

  const timers = new Set();
  const later = (fn, ms) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  let sttTimers = [];
  const clearStt = () => {
    for (const t of sttTimers) clearTimeout(t);
    sttTimers = [];
  };

  // Simulate a streaming STT engine emitting partial segments WHILE the user
  // is still speaking (server relays live stt.segment during listening).
  const startLiveStt = () => {
    clearStt();
    const words = ["what's", "the", "weather", "like", "today"];
    words.forEach((w, i) => {
      const t = setTimeout(() => send(ws, { type: "stt.segment", text: w, final: false }), 250 * (i + 1));
      sttTimers.push(t);
    });
  };

  const respond = () => {
    clearStt();
    send(ws, { type: "state", value: "thinking" });
    later(() => {
      send(ws, { type: "state", value: "speaking" });

      // First TTS segment + streamed assistant text.
      send(ws, { type: "tts.segment", id: 1, text: "Let me check" });
      send(ws, { type: "assistant.delta", text: "Let me check " });

      // A flush mid-stream: drop segment 1 and re-utter (barge/correction).
      later(() => {
        send(ws, { type: "tts.flush" });
        send(ws, { type: "tts.segment", id: 2, text: "It's sunny and 24 degrees." });
        send(ws, { type: "assistant.delta", text: "— it's sunny and 24 degrees." });

        later(() => {
          send(ws, {
            type: "assistant.done",
            text: "Let me check — it's sunny and 24 degrees.",
            timings: { sttMs: 420, ttfbMs: 1900, firstAudioMs: 2300 },
          });
          later(() => send(ws, { type: "state", value: "idle" }), 300);
        }, 350);
      }, 300);
    }, 400);
  };

  ws.on("message", (data, isBinary) => {
    if (isBinary) return; // mic audio frames — the mock ignores the PCM payload
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    console.log("[mock] <-", msg.type);

    switch (msg.type) {
      case "session.start":
        send(ws, { type: "state", value: "listening" });
        startLiveStt();
        break;
      case "utterance.end":
      case "text.prompt":
        respond();
        break;
      case "barge_in":
        send(ws, { type: "tts.flush" });
        send(ws, { type: "state", value: "listening" });
        startLiveStt();
        break;
      case "session.stop":
        clearStt();
        send(ws, { type: "state", value: "idle" });
        break;
      default:
        break;
    }
  });

  ws.on("close", () => {
    clearStt();
    for (const t of timers) clearTimeout(t);
  });
});
