/**
 * A missing agent binary must not crash the server: spawn ENOENT is reported
 * through onError and the next turn fails with a catchable error.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeSession } from "./claude-session.js";

test("missing claude binary is reported, not fatal", async () => {
  const savedPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  const errors: string[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loqui-agent-"));
  const session = new ClaudeSession(
    {
      adapter: "claude-code",
      cwd: dir,
      writableDir: dir,
      defaultModel: "x",
      models: { x: { wrapper: "anthropic", model: "sonnet" } },
    } as ConstructorParameters<typeof ClaudeSession>[0],
    "persona",
    dir,
    { onError: (m) => errors.push(m) },
  );
  try {
    await session.start(true);
    await assert.rejects(session.sendUser("hi"), /agent process is not running/);
  } finally {
    process.env.PATH = savedPath;
  }
  assert.ok(errors.length >= 1);
  assert.match(errors[0]!, /ENOENT/);
});

test("chosen model survives a restart", async () => {
  const savedPath = process.env.PATH;
  process.env.PATH = "/nonexistent"; // no real agent spawns; start() fails softly
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loqui-agent-"));
  const agent = {
    adapter: "claude-code",
    cwd: dir,
    writableDir: dir,
    defaultModel: "x",
    models: {
      x: { wrapper: "anthropic", model: "sonnet" },
      y: { wrapper: "anthropic", model: "opus" },
    },
  } as ConstructorParameters<typeof ClaudeSession>[0];
  try {
    const first = new ClaudeSession(agent, "persona", dir, { onError: () => {} });
    assert.equal(first.model, "x");
    await first.switchModel("y");
    const restarted = new ClaudeSession(agent, "persona", dir, { onError: () => {} });
    assert.equal(restarted.model, "y");
  } finally {
    process.env.PATH = savedPath;
  }
});
