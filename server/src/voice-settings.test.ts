/**
 * Voice list comes from the TTS engine (Kokoro `GET /v1/audio/voices`) with a
 * built-in fallback, and the chosen voice/speed survive a server restart.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { ServerMessage } from "@loqui/protocol";
import type { LoquiConfig } from "./config.js";
import type { ClaudeSession } from "./claude-session.js";
import { VoiceSession } from "./session.js";
import { OpenAiSpeechAdapter, type TtsAdapter } from "./tts.js";

function ttsConfig(url: string): LoquiConfig {
  return {
    tts: { url, model: "kokoro", voice: "af_heart", speed: 1, format: "pcm", sampleRate: 24000 },
  } as unknown as LoquiConfig;
}

async function withKokoro(body: unknown, fn: (url: string) => Promise<void>): Promise<void> {
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/audio/voices") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test("voices(): reads Kokoro's list as plain ids or {id} objects", async () => {
  await withKokoro({ voices: ["af_alloy", "am_echo"] }, async (url) => {
    assert.deepEqual(await new OpenAiSpeechAdapter(ttsConfig(url)).voices(), ["af_alloy", "am_echo"]);
  });
  await withKokoro({ voices: [{ id: "af_nova", name: "af_nova" }, { name: "no-id" }] }, async (url) => {
    assert.deepEqual(await new OpenAiSpeechAdapter(ttsConfig(url)).voices(), ["af_nova"]);
  });
});

test("voices(): null when the engine is unreachable or answers junk", async () => {
  assert.equal(await new OpenAiSpeechAdapter(ttsConfig("http://127.0.0.1:1")).voices(), null);
  await withKokoro({ nope: true }, async (url) => {
    assert.equal(await new OpenAiSpeechAdapter(ttsConfig(url)).voices(), null);
  });
});

// ---- VoiceSession with fakes -------------------------------------------------

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: ServerMessage[] = [];
  send(data: string): void {
    const msg = JSON.parse(data) as ServerMessage;
    this.sent.push(msg);
    // Prefixed so a server `error` message isn't EventEmitter's throwing 'error'.
    this.emit(`sent:${msg.type}`, msg);
  }
  lastConfig(): Extract<ServerMessage, { type: "config" }> {
    const c = this.sent.filter((m) => m.type === "config").at(-1);
    assert.ok(c && c.type === "config");
    return c;
  }
}

function makeSession(stateDir: string, engineVoices: string[] | null): VoiceSession {
  const cfg = {
    tts: { voice: "af_heart", speed: 1 },
    stt: { adapter: "deepgram-ws" },
    agent: { defaultModel: "sonnet", models: { sonnet: {} }, userName: "U" },
    log: { conversationsDir: path.join(stateDir, "conv") },
  } as unknown as LoquiConfig;
  const tts = {
    sampleRate: 24000,
    ping: async () => true,
    voices: async () => engineVoices,
    synthesize: async function* () {},
  } as TtsAdapter;
  const claude = { model: "sonnet", setCallbacks: () => {} } as unknown as ClaudeSession;
  return new VoiceSession(cfg, {} as never, tts, claude, stateDir);
}

async function connect(session: VoiceSession): Promise<FakeWs> {
  const ws = new FakeWs();
  session.addClient(ws as never);
  await session.refreshVoices(); // same call addClient fired; awaiting it makes the list settled
  return ws;
}

async function configSet(ws: FakeWs, msg: { voice?: string; speed?: number }): Promise<void> {
  const applied = once(ws, "sent:config"); // applyConfig always ends by broadcasting config
  ws.emit("message", Buffer.from(JSON.stringify({ type: "config.set", ...msg })), false);
  await applied;
}

test("engine voices replace the fallback; fallback used when the engine is down", async () => {
  const live = await connect(makeSession(fs.mkdtempSync(path.join(os.tmpdir(), "loqui-v-")), ["af_nova", "bm_lewis"]));
  assert.deepEqual(live.lastConfig().voices, ["af_nova", "bm_lewis"]);
  await configSet(live, { voice: "bm_lewis" });
  assert.equal(live.lastConfig().voice, "bm_lewis");

  const down = await connect(makeSession(fs.mkdtempSync(path.join(os.tmpdir(), "loqui-v-")), null));
  assert.deepEqual(down.lastConfig().voices, ["af_heart", "af_bella", "af_sky", "am_adam", "bf_emma"]);
  await configSet(down, { voice: "bm_lewis" });
  assert.equal(down.lastConfig().voice, "af_heart");
  assert.ok(down.sent.some((m) => m.type === "error" && /unknown voice/.test(m.message)));
});

test("voice and speed persist across a restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loqui-v-"));
  const first = await connect(makeSession(dir, null));
  await configSet(first, { voice: "am_adam", speed: 1.25 });

  const restarted = await connect(makeSession(dir, null));
  assert.equal(restarted.lastConfig().voice, "am_adam");
  assert.equal(restarted.lastConfig().speed, 1.25);
});
