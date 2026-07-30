/**
 * Append each completed turn to the daily conversation log in the vault:
 *   ${conversationsDir}/YYYY-MM-DD.md
 *
 * The first write of the day creates the file with a header + a read-only
 * protection tag so other Claude sessions in the vault won't edit the
 * transcript. We write as the server user (skywalker), so there are no ACL/sync
 * issues. The tag literal is assembled at runtime so this source file is not
 * itself flagged as protected.
 */

import fs from "node:fs/promises";
import path from "node:path";

// Assembled at runtime on purpose (see note above).
const READONLY_TAG = "#" + "claude-readonly";

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

export class VaultLog {
  constructor(private readonly dir: string) {}

  async appendTurn(
    userText: string,
    assistantText: string,
    costUsd?: number,
  ): Promise<void> {
    const now = new Date();
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const file = path.join(this.dir, `${date}.md`);

    await fs.mkdir(this.dir, { recursive: true });

    let header = "";
    try {
      await fs.access(file);
    } catch {
      header = `# Loqui — ${date}\n\n${READONLY_TAG}\n\n`;
    }

    const parts = [
      `## ${time}`,
      "",
      `**Abhishek:** ${userText.trim()}`,
      "",
      `**Loqui:** ${assistantText.trim()}`,
    ];
    if (typeof costUsd === "number") {
      parts.push("", `_cost: $${costUsd.toFixed(4)}_`);
    }
    const block = header + parts.join("\n") + "\n\n";
    await fs.appendFile(file, block, "utf8");
  }
}
