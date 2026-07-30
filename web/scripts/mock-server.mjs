#!/usr/bin/env node
// Canned WS server for manually sanity-checking the web client without a
// real loqui server: sends config/state/stt.segment/assistant.delta/tts
// JSON frames (no binary audio) in response to text.prompt / utterance.end.
import { WebSocketServer } from "ws";

const PORT = 8443;
const wss = new WebSocketServer({ port: PORT, path: "/ws" });
console.log(`[mock] loqui server on ws://localhost:${PORT}/ws`);

const send = (ws, msg) => ws.send(JSON.stringify(msg));

wss.on("connection", (ws) => {
  console.log("[mock] client connected");
  send(ws, { type: "config", model: "mock-model", models: ["mock-model"], voice: "mock-voice", voices: ["mock-voice"], speed: 1 });
  send(ws, { type: "state", value: "idle" });

  ws.on("message", (data, isBinary) => {
    if (isBinary) return; // v0.1 mock ignores mic audio frames
    const msg = JSON.parse(data.toString());
    console.log("[mock] <-", msg.type);
    if (msg.type !== "text.prompt" && msg.type !== "utterance.end") return;

    send(ws, { type: "state", value: "thinking" });
    if (msg.type === "utterance.end") send(ws, { type: "stt.segment", text: "hello loqui", final: true });

    setTimeout(() => {
      send(ws, { type: "state", value: "speaking" });
      send(ws, { type: "tts.segment", id: 1, text: "Hi there! This is a mock reply." });
      send(ws, { type: "assistant.delta", text: "Hi there! " });
      send(ws, { type: "assistant.delta", text: "This is a mock reply." });
      send(ws, { type: "assistant.done", text: "Hi there! This is a mock reply." });
      setTimeout(() => send(ws, { type: "state", value: "idle" }), 400);
    }, 400);
  });
});
