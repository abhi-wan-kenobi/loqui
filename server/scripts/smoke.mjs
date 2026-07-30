#!/usr/bin/env node
// Loqui server smoke test (no audio hardware required).
//
//  1. STT: wrap a sine-wave utterance and call transcribeUtterance directly.
//     Expects a clean HTTP 200 path (transcript may be empty/garbage — fine).
//  2. Full loop: start the server (HTTP mode), open a WS client, send a
//     text.prompt with the glm (ollama-wrapper) model, assert assistant.delta /
//     assistant.done arrive and that binary TTS frames (kokoro) arrive, print
//     latency numbers, then session.stop and exit clean.
//
// Run: node server/scripts/smoke.mjs   (from repo root, after `npm run build -w server`)

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { makeSttAdapter } from "../dist/stt.js";
import { pcmToWav } from "../dist/stt.js";
import { loadConfig, sttToken } from "../dist/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(__dirname, "..", "dist", "index.js");
const PORT = 8788; // dedicated smoke port (HTTP)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => {
  failures++;
  console.log(`  FAIL  ${m}`);
};

// ---------- 1. STT direct ----------
async function testStt() {
  console.log("\n== STT batch adapter ==");
  const cfg = loadConfig();
  const stt = makeSttAdapter(cfg, sttToken(cfg));
  // 0.5s 440Hz sine at 16k
  const n = 8000;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 16000));
  const wav = pcmToWav(pcm, 16000);
  if (wav.slice(0, 4).toString("ascii") === "RIFF") ok("pcmToWav emits a RIFF header");
  else bad("pcmToWav header wrong");
  const t0 = Date.now();
  try {
    const transcript = await stt.transcribeUtterance(pcm);
    ok(`STT HTTP 200 path (${Date.now() - t0}ms), transcript=${JSON.stringify(transcript)}`);
  } catch (e) {
    bad(`STT call threw: ${e.message}`);
  }
}

// ---------- 2. full WS loop ----------
async function testLoop() {
  console.log("\n== full WS turn (text.prompt -> agent -> TTS) ==");
  const env = { ...process.env, LOQUI_STATE_DIR: "/tmp/loqui-smoke-state" };
  // Force HTTP by pointing at a config with no usable certs? We reuse real config
  // but bind a different port via env override handled below. Instead we spawn
  // with a patched port using LOQUI_SMOKE by writing a tiny wrapper is overkill;
  // we mutate the port through a temp config.
  const srv = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...env, LOQUI_CONFIG: TEMP_CONFIG },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  srv.stdout.on("data", (d) => (serverLog += d.toString()));
  srv.stderr.on("data", (d) => (serverLog += d.toString()));

  // wait for listen line
  const t0 = Date.now();
  while (!/listening on/.test(serverLog) && Date.now() - t0 < 10000) await sleep(100);
  if (!/listening on/.test(serverLog)) {
    bad("server did not start");
    console.log(serverLog);
    srv.kill("SIGKILL");
    return;
  }
  ok("server started");

  const scheme = /https:\/\//.test(serverLog) ? "wss" : "ws";
  const ws = new WebSocket(`${scheme}://127.0.0.1:${PORT}/ws`, {
    rejectUnauthorized: false,
  });

  const metrics = {
    connectedAt: 0,
    promptSentAt: 0,
    firstDeltaAt: 0,
    firstAudioAt: 0,
    doneAt: 0,
    deltaCount: 0,
    audioBytes: 0,
    audioFrames: 0,
    doneText: "",
    cost: undefined,
    gotConfig: false,
    gotState: false,
  };

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      if (!metrics.firstAudioAt) metrics.firstAudioAt = Date.now();
      metrics.audioFrames++;
      metrics.audioBytes += data.length - 4; // minus segment-id prefix
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === "config") metrics.gotConfig = true;
    if (msg.type === "state") metrics.gotState = true;
    if (msg.type === "assistant.delta") {
      if (!metrics.firstDeltaAt) metrics.firstDeltaAt = Date.now();
      metrics.deltaCount++;
    }
    if (msg.type === "assistant.done") {
      metrics.doneAt = Date.now();
      metrics.doneText = msg.text;
      metrics.cost = msg.costUsd;
    }
    if (msg.type === "error") console.log(`  [server error] ${msg.message}`);
  });

  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
    setTimeout(() => reject(new Error("ws connect timeout")), 8000);
  }).catch((e) => bad(`ws connect: ${e.message}`));
  metrics.connectedAt = Date.now();

  await sleep(300); // let config/state arrive
  if (metrics.gotConfig) ok("received config on connect");
  else bad("no config on connect");
  if (metrics.gotState) ok("received state on connect");
  else bad("no state on connect");

  // Select glm (ollama wrapper) explicitly, then prompt.
  ws.send(JSON.stringify({ type: "config.set", model: "glm" }));
  await sleep(500);
  metrics.promptSentAt = Date.now();
  ws.send(
    JSON.stringify({
      type: "text.prompt",
      text: "Say the word ping and nothing else.",
    }),
  );

  // wait for done
  const t1 = Date.now();
  while (!metrics.doneAt && Date.now() - t1 < 120000) await sleep(100);

  // give trailing TTS a moment
  await sleep(1500);

  if (metrics.deltaCount > 0) ok(`assistant.delta arrived (${metrics.deltaCount} deltas)`);
  else bad("no assistant.delta");
  if (metrics.doneAt) ok(`assistant.done arrived, text=${JSON.stringify(metrics.doneText.slice(0, 60))}`);
  else bad("no assistant.done");
  if (metrics.audioFrames > 0) ok(`binary TTS frames arrived (${metrics.audioFrames} frames, ${metrics.audioBytes} PCM bytes)`);
  else bad("no TTS audio frames");

  const ttfd = metrics.firstDeltaAt ? metrics.firstDeltaAt - metrics.promptSentAt : -1;
  const ttfa = metrics.firstAudioAt ? metrics.firstAudioAt - metrics.promptSentAt : -1;
  const total = metrics.doneAt ? metrics.doneAt - metrics.promptSentAt : -1;
  console.log("\n  --- latency (ms from prompt) ---");
  console.log(`  time-to-first-delta:      ${ttfd}`);
  console.log(`  time-to-first-audio-byte: ${ttfa}`);
  console.log(`  time-to-done:             ${total}`);
  console.log(`  cost usd:                 ${metrics.cost}`);
  console.log(`  audio ms (24k mono i16):  ${Math.round(metrics.audioBytes / 2 / 24000 * 1000)}`);

  ws.send(JSON.stringify({ type: "session.stop" }));
  await sleep(200);
  ws.close();
  srv.kill("SIGTERM");
  await sleep(500);
  srv.kill("SIGKILL");
}

// Build a temp config that forces HTTP (no tls) + the smoke port.
import fs from "node:fs";
import os from "node:os";
const baseCfg = JSON.parse(
  fs.readFileSync(process.env.LOQUI_CONFIG || path.join(os.homedir(), ".config/loqui/config.json"), "utf8"),
);
baseCfg.server.port = PORT;
delete baseCfg.server.tls; // force HTTP mode for the smoke test
const TEMP_CONFIG = "/tmp/loqui-smoke-config.json";
fs.writeFileSync(TEMP_CONFIG, JSON.stringify(baseCfg));
// Ensure the STT token is present for the child (it reads ~/.config/loqui/.env,
// but that dir still holds it; TEMP_CONFIG is in /tmp so load its sibling .env
// won't exist — export the token explicitly for the child).
if (!process.env.LOQUI_STT_TOKEN) {
  try {
    const envRaw = fs.readFileSync(path.join(os.homedir(), ".config/loqui/.env"), "utf8");
    for (const line of envRaw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {}
}

async function main() {
  console.log("Loqui smoke test");
  await testStt();
  await testLoop();
  console.log(`\n${failures === 0 ? "ALL GREEN" : failures + " FAILURE(S)"}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error("smoke fatal", e);
  process.exit(1);
});
