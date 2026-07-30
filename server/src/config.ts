/**
 * Typed config load + env overlay.
 *
 * Config file path comes from LOQUI_CONFIG (default ~/.config/loqui/config.json).
 * Secrets live in the environment (LOQUI_STT_TOKEN, ...). We also manually parse
 * a `.env` next to the config (~/.config/loqui/.env) so a plain `node dist/index.js`
 * picks up secrets without a dotenv dependency — systemd uses EnvironmentFile for
 * the same file, so both paths agree.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TlsConfig {
  cert: string;
  key: string;
}

export interface ServerConfig {
  port: number;
  tls?: TlsConfig;
}

export interface SttConfig {
  adapter: string;
  url: string;
  tokenEnv: string;
  sampleRate: number;
  languages?: string;
  batchFallback?: boolean;
}

export interface TtsConfig {
  adapter: string;
  url: string;
  model: string;
  voice: string;
  speed: number;
  format: string;
  sampleRate: number;
}

export interface AgentModel {
  wrapper: "ollama" | "anthropic";
  model: string;
}

export interface AgentConfig {
  adapter: string;
  cwd: string;
  writableDir: string;
  defaultModel: string;
  models: Record<string, AgentModel>;
  dailyRotation?: boolean;
}

export interface LogConfig {
  conversationsDir: string;
}

export interface LoquiConfig {
  server: ServerConfig;
  stt: SttConfig;
  tts: TtsConfig;
  agent: AgentConfig;
  log: LogConfig;
}

export const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  ".config",
  "loqui",
  "config.json",
);

/** Directory for persisted server state (session-id resume, etc). */
export function stateDir(): string {
  return (
    process.env.LOQUI_STATE_DIR ||
    path.join(os.homedir(), ".local", "state", "loqui")
  );
}

/** Minimal, dependency-free `.env` parser. Only sets keys not already present. */
function loadDotEnv(envPath: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch {
    return; // no .env is fine (systemd provides EnvironmentFile instead)
  }
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // strip surrounding quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

export function loadConfig(): LoquiConfig {
  const configPath = process.env.LOQUI_CONFIG || DEFAULT_CONFIG_PATH;
  const raw = fs.readFileSync(configPath, "utf8");
  const cfg = JSON.parse(raw) as LoquiConfig;

  // Load the sibling .env so secrets are available (dev / manual run).
  loadDotEnv(path.join(path.dirname(configPath), ".env"));

  // Light validation of the load-bearing fields.
  if (!cfg.server?.port) throw new Error("config: server.port missing");
  if (!cfg.agent?.cwd) throw new Error("config: agent.cwd missing");
  if (!cfg.agent?.models || Object.keys(cfg.agent.models).length === 0) {
    throw new Error("config: agent.models missing");
  }
  if (!cfg.agent.models[cfg.agent.defaultModel]) {
    throw new Error(
      `config: agent.defaultModel '${cfg.agent.defaultModel}' not in agent.models`,
    );
  }
  return cfg;
}

/** Resolve the STT bearer token from the configured env var. */
export function sttToken(cfg: LoquiConfig): string | undefined {
  return process.env[cfg.stt.tokenEnv];
}
