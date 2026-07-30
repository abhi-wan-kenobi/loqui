#!/usr/bin/env node
// Loqui Phase-0 protocol probes for the Claude Code CLI stream-json interface.
//
// Verified spawn recipe (CLI 2.1.207, see vault memory claude-cli-stream-json-protocol):
//   claude -p --input-format stream-json --output-format stream-json --verbose \
//          --permission-prompt-tool stdio --permission-mode default --strict-mcp-config
// then write an `initialize` control_request, then a user message; answer every
// can_use_tool control_request or the session stalls; the CLI does NOT exit after
// the `result` event — you must close stdin / kill it yourself.
//
// Four probes:
//   (a) partial deltas  — --include-partial-messages, find the incremental-text JSON path
//   (b) interrupt       — control_request subtype "interrupt" mid-stream
//   (c) ollama passthrough — same handshake via `ollama launch claude --model ...`
//   (d) permission gate — write allowed only under vault/Assistant/, else denied
//
// Plain Node ESM, no deps. Run: node scripts/probe-claude.mjs

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const SANDBOX = '/tmp/claude-1000/-home-skywalker-vaults-personal/357f1d1e-3f64-4242-99bf-681719814607/scratchpad/loqui-probe';
const HAIKU = 'claude-haiku-4-5-20251001';
const BASE_FLAGS = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--permission-prompt-tool', 'stdio',
  '--permission-mode', 'default',
  '--strict-mcp-config',
];

// ---- child process bookkeeping (kill everything on exit) -------------------
const LIVE = new Set();
function killAll() {
  for (const p of LIVE) { try { p.kill('SIGKILL'); } catch {} }
}
process.on('exit', killAll);
process.on('SIGINT', () => { killAll(); process.exit(130); });

const ALLOW_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'TodoWrite', 'WebFetch', 'WebSearch']);
const GATED_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// ---- outbound frame builders (exact shapes from threadloom) ----------------
const fInit = (id = 'init-1') =>
  JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'initialize' } });
const fUser = (text) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const fAllow = (rid, updatedInput) =>
  JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: rid, response: { behavior: 'allow', updatedInput: updatedInput || {} } } });
const fDeny = (rid, message) =>
  JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: rid, response: { behavior: 'deny', message } } });
const fUnsupported = (rid) =>
  JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: rid, error: 'unsupported' } });
const fInterrupt = (id = 'int-1') =>
  JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'interrupt' } });

// ---- Session harness -------------------------------------------------------
class Session {
  constructor({ cmd, args, cwd, label }) {
    this.cmd = cmd; this.args = args; this.cwd = cwd; this.label = label || 'sess';
    this.proc = null; this._buf = ''; this._handlers = []; this._closed = false;
  }
  start() {
    this.proc = spawn(this.cmd, this.args, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    LIVE.add(this.proc);
    this.proc.stdout.on('data', (d) => this._onStdout(d));
    this.proc.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) process.stderr.write(`  [${this.label} stderr] ${s.split('\n').slice(0, 4).join(' | ')}\n`);
    });
    this.proc.on('exit', (code, sig) => { this._exit = { code, sig }; });
    return this;
  }
  _onStdout(chunk) {
    this._buf += chunk.toString();
    let nl;
    while ((nl = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, nl); this._buf = this._buf.slice(nl + 1);
      const t = line.trim();
      if (!t) continue;
      let obj;
      try { obj = JSON.parse(t); }
      catch { process.stderr.write(`  [${this.label} non-json] ${t.slice(0, 200)}\n`); continue; }
      for (const h of this._handlers) { try { h(obj); } catch (e) { process.stderr.write(`  handler err: ${e}\n`); } }
    }
  }
  on(fn) { this._handlers.push(fn); return this; }
  send(line) {
    if (this._closed || !this.proc || !this.proc.stdin.writable) return;
    try { this.proc.stdin.write(line + '\n'); } catch (e) { process.stderr.write(`  send err: ${e}\n`); }
  }
  close() {
    this._closed = true;
    try { this.proc?.stdin.end(); } catch {}
    setTimeout(() => { try { this.proc?.kill('SIGKILL'); } catch {} LIVE.delete(this.proc); }, 1500);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Generic permission answerer. gate(tool,input) -> {allow, message?} | null(=use defaults)
function wirePermissions(sess, log, gate) {
  sess.on((obj) => {
    if (obj.type !== 'control_request') return;
    const req = obj.request || {};
    const rid = obj.request_id;
    if (req.subtype !== 'can_use_tool') {
      if (typeof rid === 'string') sess.send(fUnsupported(rid));
      return;
    }
    const tool = req.tool_name;
    const input = req.input || {};
    let decision = gate ? gate(tool, input) : null;
    if (!decision) {
      if (ALLOW_TOOLS.has(tool)) decision = { allow: true };
      else if (GATED_TOOLS.has(tool)) decision = { allow: true };   // default: allow writes
      else if (tool === 'Bash') decision = { allow: false, message: 'Bash denied by probe policy' };
      else decision = { allow: true };
    }
    log.push({ ev: 'can_use_tool', tool, input, decision: decision.allow ? 'allow' : 'deny', message: decision.message });
    if (decision.allow) sess.send(fAllow(rid, input));
    else sess.send(fDeny(rid, decision.message || 'denied'));
  });
}

// Deep realpath of the deepest existing ancestor + rejoined non-existing tail.
function safeResolve(cwd, target) {
  const abs = path.resolve(cwd, target);
  let existing = abs;
  const tail = [];
  while (!fs.existsSync(existing)) {
    tail.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  let realBase;
  try { realBase = fs.realpathSync(existing); } catch { realBase = existing; }
  return tail.length ? path.join(realBase, ...tail) : realBase;
}

function collectTypes(sess, types) {
  sess.on((obj) => {
    const key = obj.type === 'control_request' ? `control_request/${obj.request?.subtype}`
      : obj.type === 'control_response' ? `control_response/${obj.response?.subtype}`
      : obj.type === 'stream_event' ? `stream_event/${obj.event?.type}`
      : obj.type === 'system' ? `system/${obj.subtype}`
      : obj.type === 'result' ? `result/${obj.subtype}`
      : obj.type;
    types.set(key, (types.get(key) || 0) + 1);
  });
}

// ============================================================================
// Probe (a): partial deltas
// ============================================================================
async function probeA() {
  const title = '(a) partial deltas';
  const sess = new Session({
    cmd: 'claude',
    args: [...BASE_FLAGS, '--include-partial-messages', '--model', HAIKU],
    cwd: SANDBOX, label: 'A',
  }).start();

  const types = new Map();
  collectTypes(sess, types);
  const streamSubtypes = new Set();
  const deltaSubtypes = new Set();
  let textPath = null;
  let sampleDelta = null;
  let model = null;
  let done = false;

  sess.on((obj) => {
    if (obj.type === 'system' && obj.subtype === 'init') model = obj.model;
    if (obj.type === 'stream_event') {
      const ev = obj.event || {};
      streamSubtypes.add(ev.type);
      if (ev.type === 'content_block_delta') {
        deltaSubtypes.add(ev.delta?.type);
        if (ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
          if (!textPath) { textPath = 'stream_event.event.delta.text'; sampleDelta = ev.delta.text; }
        }
      }
    }
    if (obj.type === 'result') done = true;
  });
  wirePermissions(sess, [], null);

  sess.send(fInit());
  sess.send(fUser('Count from 1 to 30 slowly, in words (one, two, three ...). No preamble.'));

  const t0 = Date.now();
  while (!done && Date.now() - t0 < 60000) await sleep(200);
  sess.close();

  const verdict = textPath ? 'PASS' : 'FAIL';
  return {
    title, verdict,
    model,
    eventTypes: [...types.entries()].sort((a, b) => b[1] - a[1]),
    streamSubtypes: [...streamSubtypes],
    deltaSubtypes: [...deltaSubtypes],
    incrementalTextPath: textPath,
    sampleDelta,
  };
}

// ============================================================================
// Probe (b): interrupt mid-stream
// ============================================================================
async function probeB() {
  const title = '(b) interrupt';
  const sess = new Session({
    cmd: 'claude',
    args: [...BASE_FLAGS, '--include-partial-messages', '--model', HAIKU],
    cwd: SANDBOX, label: 'B',
  }).start();

  let deltas = 0, resultCount = 0, firstResultAt = null, interruptSentAt = null;
  let ctrlRespForInterrupt = null;
  let deltasAfterInterrupt = 0;
  let followupAnswered = false;
  let followupSentAt = null, eventsAfterFollowup = 0, resultsAfterFollowup = 0;
  const followupToken = 'PONGVALUE-42';

  sess.on((obj) => {
    if (followupSentAt) { eventsAfterFollowup++; if (obj.type === 'result') resultsAfterFollowup++; }
    if (obj.type === 'stream_event' && obj.event?.type === 'content_block_delta') {
      deltas++;
      if (interruptSentAt) deltasAfterInterrupt++;
    }
    if (obj.type === 'result') { resultCount++; if (!firstResultAt) firstResultAt = Date.now(); }
    if (obj.type === 'control_response' && obj.response?.request_id === 'int-1') {
      ctrlRespForInterrupt = obj;
    }
    if (obj.type === 'assistant') {
      const blocks = obj.message?.content || [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text?.includes(followupToken)) followupAnswered = true;
        if (b.type === 'text' && followupSentAt) followupText += b.text;
      }
    }
  });
  let followupText = '';
  wirePermissions(sess, [], null);

  sess.send(fInit());
  sess.send(fUser('Write a 500-word story about a lighthouse keeper. Be detailed and slow.'));

  // wait for streaming to be well underway (~2s of deltas)
  const t0 = Date.now();
  while (deltas < 3 && Date.now() - t0 < 15000) await sleep(100);
  await sleep(2000);
  const deltasBefore = deltas;
  interruptSentAt = Date.now();
  sess.send(fInterrupt('int-1'));

  // observe for a few seconds whether generation halts / result arrives
  await sleep(6000);
  const stoppedEarly = resultCount > 0;
  const deltasAfter = deltasAfterInterrupt;

  // try a follow-up user message to see if the session survives
  let sessionAlive = false;
  if (!sess._exit) {
    followupSentAt = Date.now();
    sess.send(fUser(`Ignore the previous task. Reply with exactly this token and nothing else: ${followupToken}`));
    const t1 = Date.now();
    while (!followupAnswered && Date.now() - t1 < 30000) await sleep(200);
    sessionAlive = followupAnswered || !sess._exit;
  }
  sess.close();

  let ackKind = 'none';
  if (ctrlRespForInterrupt) {
    ackKind = ctrlRespForInterrupt.response?.subtype === 'success' ? 'success' : 'error';
  }
  const supported = ackKind === 'success';
  const verdict = supported ? 'PASS' : (ackKind === 'error' ? 'UNSUPPORTED' : 'FAIL');

  return {
    title, verdict,
    interruptRequestShape: JSON.parse(fInterrupt('int-1')),
    ackKind,
    ackPayloadVerbatim: ctrlRespForInterrupt || null,
    deltasBeforeInterrupt: deltasBefore,
    deltasAfterInterrupt: deltasAfter,
    resultArrived: resultCount > 0,
    generationHalted: deltasAfter <= 2,
    followupAnswered,
    followupTextSample: followupText.slice(0, 160),
    eventsAfterFollowup,
    resultsAfterFollowup,
    processExited: !!sess._exit,
    sessionAlive,
  };
}

// ============================================================================
// Probe (c): ollama passthrough
// ============================================================================
async function probeC() {
  const title = '(c) ollama passthrough';
  const sess = new Session({
    cmd: 'ollama',
    args: ['launch', 'claude', '--model', 'glm-5.2:cloud', '--', ...BASE_FLAGS],
    cwd: SANDBOX, label: 'C',
  }).start();

  const types = new Map();
  collectTypes(sess, types);
  let inited = false, model = null;
  const canUseLog = [];
  const toolsSeen = new Set();
  let text = '';
  let done = false;

  sess.on((obj) => {
    if (obj.type === 'system' && obj.subtype === 'init') { inited = true; model = obj.model; }
    if (obj.type === 'assistant') {
      for (const b of (obj.message?.content || [])) {
        if (b.type === 'text' && b.text) text += b.text;
        if (b.type === 'tool_use') toolsSeen.add(b.name);
      }
    }
    if (obj.type === 'result') done = true;
  });
  wirePermissions(sess, canUseLog, (tool, input) => {
    // allow Read + Write so it can proceed; record what asked
    if (ALLOW_TOOLS.has(tool) || GATED_TOOLS.has(tool)) return { allow: true };
    if (tool === 'Bash') return { allow: false, message: 'Bash denied by probe policy' };
    return { allow: true };
  });

  sess.send(fInit());
  sess.send(fUser('Read the file notes.md in this directory and summarize it in one sentence. Then create a file hello.txt containing exactly the word hi.'));

  const t0 = Date.now();
  while (!done && Date.now() - t0 < 180000) await sleep(300);
  sess.close();

  const readAsked = canUseLog.some((c) => c.tool === 'Read');
  const writeAsked = canUseLog.some((c) => c.tool === 'Write');
  const helloExists = fs.existsSync(path.join(SANDBOX, 'hello.txt'));

  const verdict = (inited && done && (canUseLog.length > 0) && text.length > 0) ? 'PASS' : 'FAIL';
  return {
    title, verdict,
    initialized: inited,
    modelField: model,
    canUseToolRequests: canUseLog.map((c) => ({ tool: c.tool, decision: c.decision })),
    readTriggeredEvent: readAsked,
    writeTriggeredEvent: writeAsked,
    toolsUsed: [...toolsSeen],
    helloTxtWritten: helloExists,
    textLen: text.length,
    textSample: text.slice(0, 240),
    eventTypes: [...types.entries()].sort((a, b) => b[1] - a[1]),
  };
}

// ============================================================================
// Probe (d): permission gate
// ============================================================================
async function probeD() {
  const title = '(d) permission gate';
  const vault = path.join(SANDBOX, 'vault');
  const assistantReal = fs.realpathSync(path.join(vault, 'Assistant'));

  // clean any prior artifacts
  for (const f of [path.join(vault, 'Assistant', 'probe-ok.md'), path.join(vault, 'Notes', 'hacked.md')]) {
    try { fs.unlinkSync(f); } catch {}
  }

  const sess = new Session({
    cmd: 'claude',
    args: [...BASE_FLAGS, '--model', HAIKU],
    cwd: vault, label: 'D',
  }).start();

  const gateLog = [];
  let text = '';
  let done = false;

  sess.on((obj) => {
    if (obj.type === 'assistant') {
      for (const b of (obj.message?.content || [])) if (b.type === 'text' && b.text) text += b.text;
    }
    if (obj.type === 'result') done = true;
  });

  wirePermissions(sess, [], (tool, input) => {
    if (!GATED_TOOLS.has(tool)) {
      if (tool === 'Bash') return { allow: false, message: 'Bash denied by probe policy' };
      return null; // defaults (allow Read/etc)
    }
    const target = input.file_path || input.path || input.filePath || '';
    const resolved = safeResolve(vault, target);
    const inside = resolved === assistantReal || resolved.startsWith(assistantReal + path.sep);
    const decision = inside
      ? { allow: true }
      : { allow: false, message: 'read-only vault — save under Assistant/ instead' };
    gateLog.push({ tool, target, resolved, allowed: inside });
    return decision;
  });

  sess.send(fInit());
  sess.send(fUser("Create a file Assistant/probe-ok.md containing 'hello', then create a file Notes/hacked.md containing 'oops'. Use the Write tool for each."));

  const t0 = Date.now();
  while (!done && Date.now() - t0 < 60000) await sleep(200);
  sess.close();
  await sleep(500);

  const okExists = fs.existsSync(path.join(vault, 'Assistant', 'probe-ok.md'));
  const hackedExists = fs.existsSync(path.join(vault, 'Notes', 'hacked.md'));
  const gracefulRefusal = /Assistant|read-only|permission|denied|cannot|couldn|not allowed|blocked/i.test(text);

  const verdict = (okExists && !hackedExists) ? 'PASS' : 'FAIL';
  return {
    title, verdict,
    gateDecisions: gateLog,
    assistantProbeOkExists: okExists,
    notesHackedExists: hackedExists,
    modelReportedRefusal: gracefulRefusal,
    textSample: text.slice(0, 400),
  };
}

// ============================================================================
function report(name, r) {
  console.log(`\n${'='.repeat(70)}\n${r.title}  ->  ${r.verdict}\n${'='.repeat(70)}`);
  const { title, verdict, ...rest } = r;
  for (const [k, v] of Object.entries(rest)) {
    const val = typeof v === 'object' ? JSON.stringify(v) : v;
    console.log(`  ${k}: ${val}`);
  }
}

async function main() {
  const only = process.argv.slice(2);
  const run = (n) => only.length === 0 || only.includes(n);
  const results = {};
  if (run('a')) { console.error('\n>>> running probe (a) partial deltas...'); results.a = await probeA(); report('a', results.a); }
  if (run('b')) { console.error('\n>>> running probe (b) interrupt...'); results.b = await probeB(); report('b', results.b); }
  if (run('c')) { console.error('\n>>> running probe (c) ollama passthrough...'); results.c = await probeC(); report('c', results.c); }
  if (run('d')) { console.error('\n>>> running probe (d) permission gate...'); results.d = await probeD(); report('d', results.d); }

  console.log(`\n${'#'.repeat(70)}\nSUMMARY`);
  for (const [k, r] of Object.entries(results)) console.log(`  (${k}) ${r.title}: ${r.verdict}`);
  console.log('#'.repeat(70));
  killAll();
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); killAll(); process.exit(1); });
