/**
 * Read side of the daily conversation logs written by VaultLog
 * (`${conversationsDir}/YYYY-MM-DD.md`), for the client's conversation browser.
 *
 * Only files whose name is exactly a date are ever touched; the requested date
 * is validated against a strict pattern before it becomes a path, so the HTTP
 * route can't be steered to any other file in (or out of) the vault.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ConversationDay, ConversationTurn } from "@loqui/protocol";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;
const TURN_HEADING_RE = /^## (\d{2}:\d{2})[ \t]*$/m;
const TURN_BODY_RE =
  /^\*\*(.+?):\*\* ([\s\S]*?)\n\n\*\*Loqui:\*\* ([\s\S]*?)(?:\n\n_cost: \$([\d.]+)_)?\s*$/;

/** Parse one day's Markdown log into turns. Blocks that don't match are skipped. */
export function parseConversation(markdown: string): ConversationTurn[] {
  const parts = markdown.replace(/\r\n/g, "\n").split(TURN_HEADING_RE);
  // split with a capture group: [preamble, time1, body1, time2, body2, ...]
  const turns: ConversationTurn[] = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const time = parts[i]!;
    const m = TURN_BODY_RE.exec(parts[i + 1]!.trim());
    if (!m) continue;
    const turn: ConversationTurn = {
      time,
      speaker: m[1]!,
      user: m[2]!.trim(),
      assistant: m[3]!.trim(),
    };
    if (m[4] !== undefined) turn.costUsd = Number(m[4]);
    turns.push(turn);
  }
  return turns;
}

/** Days that have a log, newest first, with their turn counts. */
export async function listConversations(dir: string): Promise<ConversationDay[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const dates = names
    .map((n) => FILE_RE.exec(n)?.[1])
    .filter((d): d is string => d !== undefined)
    .sort()
    .reverse();
  const days: ConversationDay[] = [];
  for (const date of dates) {
    const turns = await readConversation(dir, date);
    if (turns) days.push({ date, turns: turns.length });
  }
  return days;
}

/** One day's turns, or null if the date is malformed or has no log file. */
export async function readConversation(
  dir: string,
  date: string,
): Promise<ConversationTurn[] | null> {
  if (!DATE_RE.test(date)) return null;
  try {
    const stat = await fs.lstat(path.join(dir, `${date}.md`));
    if (!stat.isFile()) return null; // no symlinks/dirs posing as a log
    const text = await fs.readFile(path.join(dir, `${date}.md`), "utf8");
    return parseConversation(text);
  } catch {
    return null;
  }
}
