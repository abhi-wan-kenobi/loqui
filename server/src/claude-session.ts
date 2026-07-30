/**
 * Persistent Claude Code child-process manager (one long-lived agent session).
 *
 * Ports the verified stream-json recipe from scripts/probe-claude.mjs:
 *   - spawn `claude -p --input-format stream-json --output-format stream-json
 *     --verbose --permission-prompt-tool stdio --permission-mode default
 *     --strict-mcp-config --include-partial-messages --append-system-prompt <p>`
 *   - ollama-wrapper models prefix argv with `ollama launch claude --model M --`
 *     and DROP --model from claude; anthropic models pass `--model M`.
 *   - initialize handshake, then newline-delimited user messages on stdin.
 *   - incremental text ONLY from stream_event content_block_delta text_delta
 *     (thinking_delta / signature_delta filtered out so they never reach TTS).
 *   - result ends a turn; the CLI stays alive (persistent session).
 *   - interrupt via control_request subtype "interrupt".
 *   - permission gate: Write/Edit/MultiEdit/NotebookEdit only inside writableDir;
 *     Bash + everything else denied; unknown control_request subtypes get an
 *     error response so the session never stalls.
 *   - crash respawn with --resume <session_id>; daily rotation; model switch.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AgentConfig, AgentModel } from "./config.js";

const BASE_FLAGS = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--permission-prompt-tool",
  "stdio",
  "--permission-mode",
  "default",
  "--strict-mcp-config",
  "--include-partial-messages",
  "--disallowedTools",
  "Bash",
];

const AUTO_ALLOW = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "NotebookRead",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
]);
const GATED = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// ---- kill all children on process exit -------------------------------------
const LIVE = new Set<ChildProcessWithoutNullStreams>();
function killAll(): void {
  for (const p of LIVE) {
    try {
      p.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}
process.on("exit", killAll);
process.on("SIGINT", () => {
  killAll();
  process.exit(130);
});
process.on("SIGTERM", () => {
  killAll();
  process.exit(143);
});

/** Deep-realpath the deepest existing ancestor, rejoin the non-existing tail. */
function safeResolve(cwd: string, target: string): string {
  const abs = path.resolve(cwd, target);
  let existing = abs;
  const tail: string[] = [];
  while (!fs.existsSync(existing)) {
    tail.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  let realBase: string;
  try {
    realBase = fs.realpathSync(existing);
  } catch {
    realBase = existing;
  }
  return tail.length ? path.join(realBase, ...tail) : realBase;
}

export interface ToolActivity {
  tool: string;
  detail?: string;
}

export interface TurnResult {
  costUsd?: number;
  sessionId?: string;
}

export interface ClaudeSessionCallbacks {
  onDelta?(text: string): void;
  onToolActivity?(a: ToolActivity): void;
  onResult?(r: TurnResult): void;
  onInit?(info: { sessionId: string; model: string }): void;
  onError?(message: string): void;
}

interface PersistedState {
  sessionId?: string;
  modelKey?: string;
  date?: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export class ClaudeSession {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private sessionId: string | undefined;
  private currentDate = today();
  private modelKey: string;
  private ready = false;
  private disposing = false;
  private busy = false;
  private restartCount = 0;
  private lastRestartAt = 0;
  private interruptSeq = 0;
  private readonly writableReal: string;
  private readonly statePath: string;

  constructor(
    private readonly agent: AgentConfig,
    private readonly persona: string,
    private readonly stateDir: string,
    private cb: ClaudeSessionCallbacks = {},
  ) {
    this.modelKey = agent.defaultModel;
    this.statePath = path.join(stateDir, "state.json");
    try {
      fs.mkdirSync(stateDir, { recursive: true });
    } catch {
      /* ignore */
    }
    try {
      this.writableReal = fs.realpathSync(agent.writableDir);
    } catch {
      this.writableReal = path.resolve(agent.writableDir);
    }
    const persisted = this.loadState();
    if (persisted.modelKey && agent.models[persisted.modelKey]) {
      this.modelKey = persisted.modelKey;
    }
    if (persisted.date === this.currentDate && persisted.sessionId) {
      this.sessionId = persisted.sessionId;
    }
  }

  setCallbacks(cb: ClaudeSessionCallbacks): void {
    this.cb = cb;
  }

  get model(): string {
    return this.modelKey;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  private loadState(): PersistedState {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, "utf8")) as PersistedState;
    } catch {
      return {};
    }
  }

  private saveState(): void {
    const s: PersistedState = {
      sessionId: this.sessionId,
      modelKey: this.modelKey,
      date: this.currentDate,
    };
    try {
      fs.writeFileSync(this.statePath, JSON.stringify(s, null, 2));
    } catch {
      /* ignore */
    }
  }

  private buildArgv(resume: boolean): { cmd: string; args: string[] } {
    const spec: AgentModel | undefined = this.agent.models[this.modelKey];
    if (!spec) throw new Error(`unknown model key: ${this.modelKey}`);
    const claudeFlags = [...BASE_FLAGS, "--append-system-prompt", this.persona];
    if (resume && this.sessionId) {
      claudeFlags.push("--resume", this.sessionId);
    }
    if (spec.wrapper === "ollama") {
      // ollama launch claude --model M -- <flags>  (DROP --model to claude)
      return {
        cmd: "ollama",
        args: ["launch", "claude", "--model", spec.model, "--", ...claudeFlags],
      };
    }
    // anthropic: pass --model to claude
    return { cmd: "claude", args: [...claudeFlags, "--model", spec.model] };
  }

  /** Start (or restart) the child and wait until the init event lands. */
  async start(resume = true): Promise<void> {
    this.spawnChild(resume && !!this.sessionId);
    await this.waitReady(15_000);
  }

  private spawnChild(resume: boolean): void {
    const { cmd, args } = this.buildArgv(resume);
    this.ready = false;
    this.buf = "";
    const proc = spawn(cmd, args, {
      cwd: this.agent.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.proc = proc;
    LIVE.add(proc);
    proc.stdout.on("data", (d: Buffer) => this.onStdout(d));
    proc.stderr.on("data", (d: Buffer) => {
      const s = d.toString().trim();
      if (s) {
        process.stderr.write(
          `[claude:${this.modelKey} stderr] ${s.split("\n").slice(0, 3).join(" | ")}\n`,
        );
      }
    });
    proc.on("exit", (code, sig) => this.onExit(code, sig));
    // Kick off the initialize handshake.
    this.send({
      type: "control_request",
      request_id: "init-1",
      request: { subtype: "initialize" },
    });
  }

  private async waitReady(timeoutMs: number): Promise<void> {
    const t0 = Date.now();
    while (!this.ready && Date.now() - t0 < timeoutMs) {
      if (!this.proc || this.proc.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!this.ready) {
      // Not fatal — some wrappers emit init lazily; the first turn still works.
      process.stderr.write(
        `[claude:${this.modelKey}] init not confirmed within ${timeoutMs}ms; continuing\n`,
      );
    }
  }

  private onExit(code: number | null, sig: NodeJS.Signals | null): void {
    if (this.proc) LIVE.delete(this.proc);
    this.proc = null;
    this.ready = false;
    if (this.disposing) return;
    // Unexpected exit: respawn with resume, with basic loop protection.
    const now = Date.now();
    if (now - this.lastRestartAt < 4000) this.restartCount++;
    else this.restartCount = 0;
    this.lastRestartAt = now;
    if (this.restartCount > 5) {
      this.cb.onError?.("agent keeps crashing; giving up auto-restart");
      return;
    }
    process.stderr.write(
      `[claude:${this.modelKey}] exited (code=${code} sig=${sig}); respawning\n`,
    );
    try {
      this.spawnChild(!!this.sessionId);
    } catch (e) {
      this.cb.onError?.(`respawn failed: ${String(e)}`);
    }
  }

  private onStdout(chunk: Buffer): void {
    this.buf += chunk.toString();
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // non-JSON banner lines
      }
      this.handle(obj);
    }
  }

  private handle(obj: any): void {
    switch (obj.type) {
      case "system":
        if (obj.subtype === "init") {
          this.ready = true;
          if (typeof obj.session_id === "string") this.sessionId = obj.session_id;
          const model = obj.model ?? this.agent.models[this.modelKey]?.model ?? "";
          this.saveState();
          this.cb.onInit?.({ sessionId: this.sessionId ?? "", model });
        }
        return;

      case "stream_event": {
        const ev = obj.event;
        if (
          ev?.type === "content_block_delta" &&
          ev.delta?.type === "text_delta" &&
          typeof ev.delta.text === "string"
        ) {
          this.cb.onDelta?.(ev.delta.text);
        }
        // thinking_delta / signature_delta intentionally ignored.
        return;
      }

      case "assistant": {
        const blocks = obj.message?.content ?? [];
        for (const b of blocks) {
          if (b?.type === "tool_use") {
            this.cb.onToolActivity?.({
              tool: b.name,
              detail: this.toolDetail(b.name, b.input ?? {}),
            });
          }
        }
        return;
      }

      case "result": {
        this.busy = false;
        if (typeof obj.session_id === "string") this.sessionId = obj.session_id;
        this.saveState();
        this.cb.onResult?.({
          costUsd:
            typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : undefined,
          sessionId: this.sessionId,
        });
        return;
      }

      case "control_request":
        this.handleControlRequest(obj);
        return;

      default:
        return;
    }
  }

  private toolDetail(tool: string, input: Record<string, any>): string | undefined {
    if (tool === "Grep" || tool === "Glob") return input.pattern;
    if (input.file_path) return path.basename(String(input.file_path));
    if (input.path) return path.basename(String(input.path));
    if (tool === "Bash" && input.command) return String(input.command).slice(0, 60);
    return undefined;
  }

  private handleControlRequest(obj: any): void {
    const rid = obj.request_id;
    const req = obj.request ?? {};
    if (req.subtype !== "can_use_tool") {
      // Never ignore an unknown control_request — the session would stall.
      if (typeof rid === "string") {
        this.send({
          type: "control_response",
          response: { subtype: "error", request_id: rid, error: "unsupported" },
        });
      }
      return;
    }
    const tool: string = req.tool_name;
    const input: Record<string, any> = req.input ?? {};
    const decision = this.gate(tool, input);
    if (decision.allow) {
      this.send({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: rid,
          response: { behavior: "allow", updatedInput: input },
        },
      });
    } else {
      this.send({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: rid,
          response: { behavior: "deny", message: decision.message },
        },
      });
    }
  }

  private gate(
    tool: string,
    input: Record<string, any>,
  ): { allow: boolean; message?: string } {
    if (GATED.has(tool)) {
      const target = input.file_path || input.path || input.filePath || "";
      const resolved = safeResolve(this.agent.cwd, String(target));
      const inside =
        resolved === this.writableReal ||
        resolved.startsWith(this.writableReal + path.sep);
      return inside
        ? { allow: true }
        : { allow: false, message: "read-only vault — save under Assistant/ instead" };
    }
    if (tool === "Bash") {
      return { allow: false, message: "shell access is disabled" };
    }
    if (AUTO_ALLOW.has(tool)) return { allow: true };
    // Any other (mutating / unknown) tool is denied by default.
    return { allow: false, message: "that tool is not available" };
  }

  private send(obj: unknown): void {
    const p = this.proc;
    if (!p || !p.stdin.writable) return;
    try {
      p.stdin.write(JSON.stringify(obj) + "\n");
    } catch {
      /* ignore */
    }
  }

  /** Send a user turn. Handles daily rotation transparently. */
  async sendUser(text: string): Promise<void> {
    if (this.agent.dailyRotation && today() !== this.currentDate) {
      await this.newConversation();
    }
    if (!this.proc) {
      await this.start(true);
    }
    this.busy = true;
    this.send({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    });
  }

  /** Barge-in / interrupt the in-flight turn. Same session survives. */
  interrupt(): void {
    if (!this.proc) return;
    this.interruptSeq += 1;
    this.send({
      type: "control_request",
      request_id: `int-${this.interruptSeq}`,
      request: { subtype: "interrupt" },
    });
  }

  /** Start a brand-new conversation (fresh session id). */
  async newConversation(): Promise<void> {
    this.interrupt();
    await this.killChild();
    this.sessionId = undefined;
    this.currentDate = today();
    this.saveState();
    await this.start(false);
  }

  /** Switch model with a graceful restart. Keeps the conversation only if the
   *  wrapper (provider) is unchanged and a resume is possible. */
  async switchModel(newKey: string): Promise<void> {
    if (!this.agent.models[newKey]) throw new Error(`unknown model: ${newKey}`);
    if (newKey === this.modelKey) return;
    const oldWrapper = this.agent.models[this.modelKey]?.wrapper;
    const newWrapper = this.agent.models[newKey]?.wrapper;
    const sameProvider = oldWrapper === newWrapper;
    if (this.busy) this.interrupt();
    await this.killChild();
    this.modelKey = newKey;
    if (!sameProvider) this.sessionId = undefined; // fresh across providers
    this.saveState();
    await this.start(sameProvider);
  }

  private async killChild(): Promise<void> {
    const p = this.proc;
    if (!p) return;
    this.disposing = true; // suppress auto-respawn during the swap
    try {
      p.stdin.end();
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          p.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        resolve();
      }, 1500);
      p.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    LIVE.delete(p);
    this.proc = null;
    this.ready = false;
    this.busy = false;
    this.disposing = false;
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    await this.killChild();
    this.disposing = true;
  }
}
