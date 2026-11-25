/**
 * Static file caching: fingerprinted build output is cached for good, every
 * other file (index.html, sw.js, manifest) is revalidated so a deploy reaches
 * installed clients.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { StaticServer } from "./http-static.js";

function webRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loqui-static-"));
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
  fs.writeFileSync(path.join(dir, "sw.js"), "//sw");
  fs.writeFileSync(path.join(dir, "assets", "index-abc123.js"), "//app");
  return dir;
}

async function get(server: StaticServer, urlPath: string) {
  let status = 0;
  let headers: Record<string, string | number> = {};
  const res = {
    writeHead(s: number, h?: Record<string, string | number>) {
      status = s;
      headers = h ?? {};
      return res;
    },
    end() {},
  } as unknown as ServerResponse;
  const handled = await server.serve(urlPath, res);
  return { handled, status, headers };
}

test("fingerprinted assets are immutable", async () => {
  const r = await get(new StaticServer(webRoot()), "/assets/index-abc123.js");
  assert.equal(r.status, 200);
  assert.equal(r.headers["Cache-Control"], "public, max-age=31536000, immutable");
});

test("index.html, the service worker and the SPA fallback are revalidated", async () => {
  const server = new StaticServer(webRoot());
  for (const p of ["/", "/sw.js", "/some/client/route"]) {
    const r = await get(server, p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers["Cache-Control"], "no-cache", p);
  }
});
