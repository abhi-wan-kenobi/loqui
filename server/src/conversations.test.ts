/**
 * Conversation browser read side: round-trips VaultLog's format and refuses
 * anything that isn't a plain YYYY-MM-DD.md log file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VaultLog } from "./vault-log.js";
import { listConversations, parseConversation, readConversation } from "./conversations.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loqui-conv-"));
}

test("round-trips turns written by VaultLog, including multi-line replies", async () => {
  const dir = tmpDir();
  const log = new VaultLog(dir, "Abhishek");
  await log.appendTurn("what's on my roadmap?", "Two things.\n\nFirst, the orb.", 0.1633);
  await log.appendTurn("thanks", "Any time.");

  const days = await listConversations(dir);
  assert.equal(days.length, 1);
  assert.equal(days[0]!.turns, 2);

  const turns = await readConversation(dir, days[0]!.date);
  assert.ok(turns);
  assert.match(turns[0]!.time, /^\d{2}:\d{2}$/);
  assert.equal(turns[0]!.speaker, "Abhishek");
  assert.equal(turns[0]!.user, "what's on my roadmap?");
  assert.equal(turns[0]!.assistant, "Two things.\n\nFirst, the orb.");
  assert.equal(turns[0]!.costUsd, 0.1633);
  assert.equal(turns[1]!.assistant, "Any time.");
  assert.equal(turns[1]!.costUsd, undefined);
});

test("lists only date-named logs, newest first", async () => {
  const dir = tmpDir();
  const body = "# Loqui\n\n## 09:00\n\n**User:** hi\n\n**Loqui:** hello\n\n";
  fs.writeFileSync(path.join(dir, "2026-08-01.md"), body);
  fs.writeFileSync(path.join(dir, "2026-09-15.md"), body + body.replace("# Loqui\n\n", ""));
  fs.writeFileSync(path.join(dir, "notes.md"), body);
  fs.mkdirSync(path.join(dir, "2026-10-01.md"));

  assert.deepEqual(await listConversations(dir), [
    { date: "2026-09-15", turns: 2 },
    { date: "2026-08-01", turns: 1 },
  ]);
  assert.deepEqual(await listConversations(path.join(dir, "missing")), []);
});

test("rejects traversal, non-date names, and symlinked logs", async () => {
  const dir = tmpDir();
  const outside = path.join(tmpDir(), "secret.md");
  fs.writeFileSync(outside, "## 09:00\n\n**User:** x\n\n**Loqui:** y\n");
  fs.symlinkSync(outside, path.join(dir, "2026-01-01.md"));

  assert.equal(await readConversation(dir, "../secret"), null);
  assert.equal(await readConversation(dir, "notes"), null);
  assert.equal(await readConversation(dir, "2026-01-01"), null);
  assert.equal(await readConversation(dir, "2026-02-02"), null);
});

test("skips malformed blocks instead of failing the day", () => {
  const md = "## 10:00\n\nfree text the agent scribbled\n\n## 10:05\n\n**User:** a\n\n**Loqui:** b\n";
  assert.deepEqual(parseConversation(md), [
    { time: "10:05", speaker: "User", user: "a", assistant: "b" },
  ]);
});
