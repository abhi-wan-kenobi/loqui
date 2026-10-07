/**
 * Loqui server entrypoint.
 *
 *  - HTTPS (TLS from config; falls back to HTTP with a loud warning if the cert
 *    is missing) serving the built web client (web/dist) with SPA fallback.
 *  - WS endpoint at /ws (the client connects to wss://host/ws).
 *  - GET /rootCA.pem   -> the mkcert root CA (phone install convenience)
 *  - GET /healthz       -> JSON health snapshot (cached reachability)
 *  - GET /api/conversations[/YYYY-MM-DD] -> logged days / one day's turns (JSON)
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { loadConfig, sttToken, stateDir, ConfigError } from "./config.js";
import { StaticServer } from "./http-static.js";
import { makeSttAdapter } from "./stt.js";
import { OpenAiSpeechAdapter } from "./tts.js";
import { ClaudeSession } from "./claude-session.js";
import { VoiceSession } from "./session.js";
import { buildPersona } from "./persona.js";
import { listConversations, readConversation } from "./conversations.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/index.js -> server/ -> repo root -> web/dist
const WEB_DIST = path.resolve(__dirname, "..", "..", "web", "dist");
const ROOT_CA = path.join(os.homedir(), ".local", "share", "mkcert", "rootCA.pem");

const PLACEHOLDER_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Loqui</title></head>
<body style="font-family:system-ui;background:#0b0b12;color:#e8e8f0;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1 style="font-weight:600">Loqui server running</h1>
<p style="opacity:.7">Web client not built yet (web/dist is missing).</p></div>
</body></html>`;

async function main(): Promise<void> {
  const cfg = loadConfig();
  const token = sttToken(cfg);
  if (!token) {
    process.stderr.write(
      "[loqui] WARNING: STT token not set (env " + cfg.stt.tokenEnv + "); STT will fail.\n",
    );
  }

  const stt = makeSttAdapter(cfg, token);
  const tts = new OpenAiSpeechAdapter(cfg);
  const claude = new ClaudeSession(cfg.agent, buildPersona(cfg.agent.userName), stateDir());
  const voice = new VoiceSession(cfg, stt, tts, claude, stateDir());
  void voice.refreshVoices();
  const staticServer = new StaticServer(WEB_DIST);

  // Warm up the agent (non-fatal if it lags).
  claude.start(true).catch((e) => process.stderr.write(`[loqui] agent start: ${String(e)}\n`));

  // ---- cached health ----
  let healthCache: { at: number; stt: boolean; tts: boolean } = {
    at: 0,
    stt: false,
    tts: false,
  };
  async function health(): Promise<{ stt: boolean; tts: boolean }> {
    const now = Date.now();
    if (now - healthCache.at < 15_000) return { stt: healthCache.stt, tts: healthCache.tts };
    const [sttOk, ttsOk] = await Promise.all([stt.ping(), tts.ping()]);
    healthCache = { at: now, stt: sttOk, tts: ttsOk };
    return { stt: sttOk, tts: ttsOk };
  }

  const requestHandler = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    const url = req.url ?? "/";
    const pathname = url.split("?")[0] ?? "/";

    if (pathname === "/healthz") {
      const h = await health();
      const snap = voice.snapshot();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          state: snap.state,
          model: snap.model,
          clients: snap.clients,
          agentAlive: snap.agentAlive,
          stt: h.stt,
          tts: h.tts,
        }),
      );
      return;
    }

    if (pathname === "/api/conversations" || pathname.startsWith("/api/conversations/")) {
      // The Android app runs on its own origin (capacitor), so allow any origin
      // to read — the same LAN clients can already open the WS.
      const headers = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      };
      const dir = cfg.log.conversationsDir;
      if (pathname === "/api/conversations") {
        res.writeHead(200, headers).end(JSON.stringify(await listConversations(dir)));
        return;
      }
      const turns = await readConversation(dir, pathname.slice("/api/conversations/".length));
      if (!turns) {
        res.writeHead(404, headers).end(JSON.stringify({ error: "no conversation for that date" }));
        return;
      }
      res.writeHead(200, headers).end(JSON.stringify(turns));
      return;
    }

    if (pathname === "/rootCA.pem") {
      try {
        const body = await fs.promises.readFile(ROOT_CA);
        res.writeHead(200, {
          "Content-Type": "application/x-pem-file",
          "Content-Disposition": 'attachment; filename="loqui-rootCA.pem"',
        });
        res.end(body);
      } catch {
        res.writeHead(404).end("rootCA.pem not found");
      }
      return;
    }

    // Static web client.
    if (staticServer.available) {
      const handled = await staticServer.serve(pathname, res);
      if (handled) return;
      res.writeHead(404).end("not found");
      return;
    }

    // No web build: friendly placeholder.
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PLACEHOLDER_HTML);
  };

  // ---- WebSocket at /ws (shared by every listener) ----
  const wss = new WebSocketServer({ noServer: true });
  const attachWs = (srv: http.Server | https.Server): void => {
    srv.on("upgrade", (req, socket, head) => {
      const pathname = (req.url ?? "/").split("?")[0];
      if (pathname !== "/ws") {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        voice.addClient(ws);
      });
    });
    srv.on("error", (err) => {
      process.stderr.write(`[loqui] server error: ${String(err)}\n`);
      process.exit(1);
    });
  };

  // ---- primary server (TLS if certs present) ----
  let server: http.Server | https.Server;
  let scheme = "https";
  const tls = cfg.server.tls;
  const haveCerts =
    !!tls && fs.existsSync(tls.cert) && fs.existsSync(tls.key);
  if (haveCerts && tls) {
    server = https.createServer(
      { cert: fs.readFileSync(tls.cert), key: fs.readFileSync(tls.key) },
      (req, res) => void requestHandler(req, res),
    );
  } else {
    scheme = "http";
    process.stderr.write(
      "\n[loqui] ***********************************************************\n" +
        "[loqui] WARNING: TLS cert not found — starting in PLAINTEXT HTTP.\n" +
        "[loqui] Microphone capture requires a secure context; browsers will\n" +
        "[loqui] refuse getUserMedia over http except on localhost.\n" +
        "[loqui] ***********************************************************\n\n",
    );
    server = http.createServer((req, res) => void requestHandler(req, res));
  }
  attachWs(server);

  const port = cfg.server.port;
  server.listen(port, () => {
    process.stdout.write(
      `[loqui] listening on ${scheme}://0.0.0.0:${port}  (ws at ${scheme === "https" ? "wss" : "ws"}://<host>:${port}/ws)\n`,
    );
    process.stdout.write(
      `[loqui] web client: ${staticServer.available ? WEB_DIST : "(not built — serving placeholder)"}\n`,
    );
  });

  // ---- optional second plaintext HTTP listener (LAN Android app, no certs) ----
  // Only start it when TLS is actually in use on the primary; otherwise the
  // primary is already plain HTTP and a duplicate on the same handler is noise.
  let httpServer: http.Server | undefined;
  const httpPort = cfg.server.httpPort;
  if (httpPort && httpPort !== port) {
    httpServer = http.createServer((req, res) => void requestHandler(req, res));
    attachWs(httpServer);
    httpServer.listen(httpPort, () => {
      process.stdout.write(
        `[loqui] plaintext listening on http://0.0.0.0:${httpPort}  (ws at ws://<host>:${httpPort}/ws)\n`,
      );
    });
  }

  const shutdown = () => {
    process.stdout.write("\n[loqui] shutting down\n");
    // Send a clean close frame to every WS client instead of a bare TCP reset.
    for (const client of wss.clients) {
      try {
        client.close(1001, "server shutting down");
      } catch {
        /* ignore */
      }
    }
    void claude.dispose().finally(() => {
      server.close(() => {
        if (httpServer) httpServer.close(() => process.exit(0));
        else process.exit(0);
      });
      setTimeout(() => process.exit(0), 2000);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  if (e instanceof ConfigError) {
    process.stderr.write(`[loqui] configuration error:\n  ${e.message}\n`);
  } else {
    process.stderr.write(`[loqui] FATAL ${e instanceof Error ? e.stack : String(e)}\n`);
  }
  process.exit(1);
});
