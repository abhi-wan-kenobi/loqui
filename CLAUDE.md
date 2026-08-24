# loqui — Claude context

Open-source voice assistant: STT → Claude brain → TTS. npm workspaces —
`packages/protocol`, `server/`, `web/`. Dual-port by design: **HTTPS 8443** and
**HTTP 8480** (see `config.example.json`).

## This repo is PUBLIC

`github.com/abhi-wan-kenobi/loqui`. Everything committed here is world-readable,
which changes the rules versus the rest of `~/projects`:

- No coruscant hostnames, LAN IPs, tailnet addresses, family names, or personal
  paths in code, comments, commit messages, or fixtures.
- Real config stays in `config.json` (gitignored); `config.example.json` is the
  only committed shape.
- Write commit messages for strangers — this is the repo other people read.

## ⚠️ The Paseo test script is broken

`paseo.json` declares `"test": "npm test"`, but `package.json` has **no `test`
script** — the Paseo test button fails on this repo. Either add a real `test`
script or correct `paseo.json`; until one of those happens, "tests pass" here
means nothing.

Build and run are real: `npm run build` (protocol → server → web),
`npm run dev:server`, `npm run dev:web`, `npm start`.

## Notes

- Sentence-streamed TTS is the interesting part and was ported *out* of here into
  hermes-web's call mode (`SentenceChunker` / `TtsQueue`). Changes to chunking
  logic in either repo are worth mirroring by hand — they are not shared code.
- Browser audio work is only really validated on a real handset. A passing
  headless check is not a field test.
