# Loqui

**Talk to your own AI.** Loqui is a self-hosted, open-source voice assistant: you
speak, it thinks, it speaks back — through an installable phone-first web app with
a glowing orb and live transcription. No cloud voice service, no vendor lock-in.

Its distinguishing idea is the **brain is pluggable**. Point it at a persistent
[Claude Code](https://claude.ai/code) session running inside a folder of notes and
it answers from *your* knowledge — with read-only access everywhere except one
folder you designate. Or point it at any OpenAI-compatible chat endpoint. Same for
speech: any Deepgram-style STT and any OpenAI-`/v1/audio/speech` TTS drop in via
config.

```
  🗣  you speak  ──▶  STT  ──▶  agent  ──▶  TTS  ──▶  🔊 it speaks
                     (WS)      (your AI)   (stream)
        └──────────── one orb PWA over one WebSocket ───────────┘
```

## Why it exists

Commercial voice assistants are restrictive and don't know your world. Loqui talks
to a model you control, over knowledge you own, on hardware you run. The reference
deployment replaces Gemini Voice with a Claude Code session whose working directory
is an Obsidian vault — so "what's on my roadmap?" is answered from the actual notes,
and the assistant can *save* a thought back to one dedicated folder but can never
edit anything else.

## Features

- **Android app + browser PWA from one codebase** — install the APK from Releases
  (no certificates, plain `ws://` on your LAN), or add the PWA to your home screen.
- **Open mic + barge-in** — talk naturally, interrupt mid-sentence. Barge-in
  uses the agent's native interrupt, so context is preserved. Streaming STT
  transcribes while you speak.
- **Reactive WebGL orb** — three skins (Mesh wireframe, Stardust particle cloud,
  Ribbons strand loops), each driven by the session state (idle / listening /
  thinking / speaking) and the live mic or playback level. Pick one in Settings.
- **Live model + voice picker** — Settings switches the agent model (any key under
  `agent.models`), TTS voice and speaking speed on the server, for every connected device.
- **Pluggable adapters** — STT (`deepgram-ws`), TTS (`openai-speech`), agent
  (`claude-code` | `openai-chat`). Add your own by implementing one interface.
- **Read-only by construction** — the Claude Code agent adapter gates every write
  through a path check; only a configured folder is writable. Symlink/`..`/broken-link
  escapes are blocked and regression-tested.
- **Streaming everywhere** — token-level agent deltas are chunked into sentences and
  spoken as they arrive, so you hear the first words in ~1s after the model starts.
- **Conversations saved and browsable** — each turn is appended to a dated Markdown
  log; the history drawer's **Past** tab lists every logged day and replays it
  (served read-only at `GET /api/conversations[/YYYY-MM-DD]`).

## Architecture

A single Node/TypeScript server plumbs four duplex streams:

| Piece | Default | Swap via |
|---|---|---|
| **STT** | a Deepgram-compatible WS server (batch in v0.1, streaming v0.2) | `stt.adapter` |
| **TTS** | [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) (OpenAI `/v1/audio/speech`) | `tts.adapter` |
| **Agent** | a persistent `claude` CLI session (stream-json) | `agent.adapter` |
| **Client** | React app — Android APK (Capacitor) or browser PWA, orb + live transcript | — |

The client talks to the server over one WebSocket carrying JSON control frames and
binary audio (16 kHz int16 up, 24 kHz int16 down). See
[`packages/protocol`](packages/protocol/src/index.ts) for the wire contract.

## Quick start

### 1. Run the server (your home box)

```bash
git clone https://github.com/abhi-wan-kenobi/loqui && cd loqui
npm install
npm run build

cp config.example.json ~/.config/loqui/config.json   # then edit it
# secrets go in ~/.config/loqui/.env  (e.g. LOQUI_STT_TOKEN=…)

npm start
```

The server listens on two ports (both optional, at least one required):

- `server.httpPort` (e.g. **8480**) — plain HTTP/`ws://`. Zero-setup path for the
  **Android app** on your LAN.
- `server.port` + `server.tls` (e.g. **8443**) — HTTPS/`wss://` for the **browser
  PWA** (browsers require a secure origin for mic access; `mkcert` works well:
  `mkcert -install && mkcert -cert-file cert.pem -key-file key.pem <your-ip>`).

### 2. Install the Android app

Grab the latest APK from [**Releases**](https://github.com/abhi-wan-kenobi/loqui/releases),
install it, open Settings (gear) and set your server URL, e.g.
`ws://192.168.0.42:8480/ws`. Tap the orb and talk. No certificates needed.

Or use the browser PWA instead: open `https://<host>:8443`, "Add to Home Screen".

### Requirements

- Node 22+
- An STT server (any Deepgram-compatible endpoint) and a TTS server (any
  OpenAI-`/v1/audio/speech` endpoint — Kokoro-FastAPI is a great CPU-only choice).
- For the `claude-code` agent adapter: the `claude` CLI, authenticated. Model is
  configurable — a real Claude model, or an Ollama-cloud model via
  `ollama launch claude --model <m>`.

## Configuration

See [`config.example.json`](config.example.json). Highlights:

- `agent.cwd` — the directory the agent runs in (its knowledge).
- `agent.writableDir` — the **only** path the agent may write to. Everything else is
  read-only, enforced in the process.
- `agent.models` — named model presets; switch live from the app's settings.

## Status

**v0.2** (current): Android APK, open-mic + VAD + barge-in, streaming STT, custom
WebGL orb, the read-only Claude Code brain, conversation logging. **v0.1**:
push-to-talk browser PWA, batch STT, streaming TTS. **v0.3** (in progress): three
orb skins (Mesh, Stardust, Ribbons), settings/model picker, conversation browser.

## Sponsor

Built in evenings around a full-time job, and released free. Sponsorship pays for the
parts that cost real money — Apple Developer membership, code-signing certificates, and
the hours to keep releases working across three platforms.

[Sponsor this work](https://github.com/sponsors/abhi-wan-kenobi) · [SPONSORS.md](SPONSORS.md)

## License

MIT — see [LICENSE](LICENSE).
