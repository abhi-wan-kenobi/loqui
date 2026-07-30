/**
 * Tiny static file server for the built web client (web/dist).
 * No express: a content-type map + a path-traversal guard + SPA fallback.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ServerResponse } from "node:http";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

function contentType(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

export class StaticServer {
  private readonly root: string | null;

  constructor(rootDir: string) {
    // Only serve if the directory actually exists (web may be unbuilt).
    this.root = fs.existsSync(rootDir) ? fs.realpathSync(rootDir) : null;
  }

  get available(): boolean {
    return this.root !== null;
  }

  /** Serve a URL path; returns true if handled, false if the caller should 404. */
  async serve(urlPath: string, res: ServerResponse): Promise<boolean> {
    if (!this.root) return false;
    const clean = decodeURIComponent(urlPath.split("?")[0] ?? "/");
    let rel = clean.replace(/^\/+/, "");
    if (rel === "") rel = "index.html";

    const target = path.resolve(this.root, rel);
    // Path-traversal guard: resolved path must stay under root.
    if (target !== this.root && !target.startsWith(this.root + path.sep)) {
      res.writeHead(403).end("forbidden");
      return true;
    }

    if (await this.sendFile(target, res)) return true;

    // SPA fallback: unknown non-asset path -> index.html.
    if (!path.extname(rel)) {
      const index = path.join(this.root, "index.html");
      if (await this.sendFile(index, res)) return true;
    }
    return false;
  }

  private async sendFile(file: string, res: ServerResponse): Promise<boolean> {
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile()) return false;
      // The string guard in serve() doesn't stop a symlink *inside* root from
      // pointing out of it. Re-check the real path before reading.
      if (this.root) {
        const real = await fsp.realpath(file);
        if (real !== this.root && !real.startsWith(this.root + path.sep)) {
          return false;
        }
      }
      const body = await fsp.readFile(file);
      res.writeHead(200, {
        "Content-Type": contentType(file),
        "Content-Length": body.length,
      });
      res.end(body);
      return true;
    } catch {
      return false;
    }
  }
}
