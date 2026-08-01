/**
 * Regression tests for the write-permission gate's path resolution.
 * The security guarantee is: a Write/Edit is allowed ONLY if the resolved
 * target lands inside the writable dir. These cases cover the escape vectors
 * a cross-model review flagged — especially the broken-symlink bypass that an
 * existsSync/realpath-based resolver misses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { safeResolve } from "./claude-session.js";

function inside(writableReal: string, resolved: string): boolean {
  return resolved === writableReal || resolved.startsWith(writableReal + path.sep);
}

test("gate path resolution blocks every escape vector", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "loqui-gate-"));
  try {
    const cwd = path.join(base, "vault");
    const assistant = path.join(cwd, "Assistant");
    const notes = path.join(cwd, "Notes");
    const outside = path.join(base, "outside");
    fs.mkdirSync(assistant, { recursive: true });
    fs.mkdirSync(notes, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    // real symlink Assistant/reallink -> ../Notes (target exists)
    fs.symlinkSync(notes, path.join(assistant, "reallink"));
    // broken symlink Assistant/brokenlink -> outside/ghost (target missing)
    fs.symlinkSync(path.join(outside, "ghost"), path.join(assistant, "brokenlink"));
    // multi-level chain: Assistant/chainC -> chainB -> chainA -> outside
    fs.symlinkSync(outside, path.join(assistant, "chainA"));
    fs.symlinkSync(path.join(assistant, "chainA"), path.join(assistant, "chainB"));
    fs.symlinkSync(path.join(assistant, "chainB"), path.join(assistant, "chainC"));
    // symlink -> symlink -> outside FILE
    fs.writeFileSync(path.join(outside, "target.txt"), "x");
    fs.symlinkSync(path.join(outside, "target.txt"), path.join(assistant, "fileLinkA"));
    fs.symlinkSync(path.join(assistant, "fileLinkA"), path.join(assistant, "fileLinkB"));
    // symlink loop
    fs.symlinkSync(path.join(assistant, "loopB"), path.join(assistant, "loopA"));
    fs.symlinkSync(path.join(assistant, "loopA"), path.join(assistant, "loopB"));

    const writableReal = fs.realpathSync(assistant);
    const check = (t: string) => inside(writableReal, safeResolve(cwd, t));

    // Allowed: plain writes under Assistant/
    assert.equal(check("Assistant/ok.md"), true);
    assert.equal(check("Assistant/sub/deep.md"), true);

    // Denied: escapes
    assert.equal(check("Assistant/reallink/hacked.md"), false); // real symlink out
    assert.equal(check("Assistant/brokenlink/hacked.md"), false); // broken symlink out
    assert.equal(check("../Notes/hacked.md"), false);
    assert.equal(check("Assistant/../Notes/x.md"), false);
    assert.equal(check("/etc/passwd"), false);
    assert.equal(check("Notes/x.md"), false);
    // Denied: kimi-found vectors (multi-level chains, link-to-link file, NUL, loops)
    assert.equal(check("Assistant/chainC/hacked.md"), false); // chain of 3 links out
    assert.equal(check("Assistant/chainB/hacked.md"), false); // chain of 2 links out
    assert.equal(check("Assistant/fileLinkB"), false); // link->link->outside file
    assert.equal(check("Assistant/ok.md\0.evil"), false); // NUL-byte path
    assert.equal(check("Assistant/loopA/x.md"), false); // symlink loop -> sentinel
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
