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

- **Phone-first installable PWA** — add to home screen, full-screen orb, works on any
  modern browser (desktop too). One codebase.
- **Open mic + barge-in** (v0.2) — talk naturally, interrupt mid-sentence. Barge-in
  uses the agent's native interrupt, so context is preserved.
- **Pluggable adapters** — STT (`deepgram-ws`), TTS (`openai-speech`), agent
  (`claude-code` | `openai-chat`). Add your own by implementing one interface.
- **Read-only by construction** — the Claude Code agent adapter gates every write
  through a path check; only a configured folder is writable. Symlink/`..`/broken-link
  escapes are blocked and regression-tested.
- **Streaming everywhere** — token-level agent deltas are chunked into sentences and
  spoken as they arrive, so you hear the first words in ~1s after the model starts.
- **Conversations saved** — each turn is appended to a dated Markdown log.

## Architecture

A single Node/TypeScript server plumbs four duplex streams:

| Piece | Default | Swap via |
|---|---|---|
| **STT** | a Deepgram-compatible WS server (batch in v0.1, streaming v0.2) | `stt.adapter` |
| **TTS** | [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) (OpenAI `/v1/audio/speech`) | `tts.adapter` |
| **Agent** | a persistent `claude` CLI session (stream-json) | `agent.adapter` |
| **Client** | React PWA, orb + transcript, served by the same server over HTTPS | — |

The client talks to the server over one WebSocket carrying JSON control frames and
binary audio (16 kHz int16 up, 24 kHz int16 down). See
[`packages/protocol`](packages/protocol/src/index.ts) for the wire contract.

## Quick start

```bash
git clone <repo> loqui && cd loqui
npm install
npm run build

cp config.example.json ~/.config/loqui/config.json   # then edit it
# secrets go in ~/.config/loqui/.env  (e.g. LOQUI_STT_TOKEN=…)

# A secure origin is required for microphone access. Easiest for a home LAN:
#   mkcert -install && mkcert -cert-file cert.pem -key-file key.pem <your-ip>
# point config.server.tls at those files, install the mkcert root CA on your phone.

npm start                       # serves https://<host>:8443  (PWA + /ws)
```

Then open `https://<host>:8443` on your phone and "Add to Home Screen".

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

**v0.1** (current): push-to-talk, batch STT, streaming TTS, the read-only Claude Code
brain, HTTPS/PWA, conversation logging. **v0.2**: open-mic + VAD + barge-in, streaming
STT. **v0.3**: particle orb, settings/model picker, conversation browser.

## License

MIT — see [LICENSE](LICENSE).
