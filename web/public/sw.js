// Loqui service worker: an offline-capable app shell, and nothing else.
//
// - The build (web/scripts/precache.mjs) stamps BUILD below with this build's
//   id and file list. The shell cache is named after the id, so a new build
//   gets a fresh cache and the old one is deleted on activation.
// - Updates never take over a running page on their own: a new worker waits
//   until the page asks for it (SKIP_WAITING), so a live voice session is
//   never reloaded under the user.
// - Anything dynamic is left to the network: the WebSocket session, the
//   conversation logs (/api/*, private), health and CA download.

const BUILD = { id: "dev", precache: [] }; // __BUILD__

const SHELL_CACHE = `loqui-shell-${BUILD.id}`;
const RUNTIME_CACHE = "loqui-runtime-v1";
const NAVIGATION_TIMEOUT_MS = 3000;

const isDynamic = (path) =>
  path === "/ws" || path.startsWith("/ws/") || path.startsWith("/api/") || path === "/healthz" || path === "/rootCA.pem";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // `reload` bypasses the HTTP cache so the shell is never built from stale files.
      cache.addAll(BUILD.precache.map((url) => new Request(url, { cache: "reload" }))),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isDynamic(url.pathname)) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstShell(request));
  } else if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request));
  } else {
    event.respondWith(staleWhileRevalidate(request));
  }
});

// Documents: the network wins when it answers in time, so a deploy shows up on
// the next launch; otherwise the cached shell opens and the app reports the
// server as unreachable itself.
async function networkFirstShell(request) {
  const cached = () => caches.match("/index.html", { cacheName: SHELL_CACHE });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), NAVIGATION_TIMEOUT_MS);
      fetch(request).then(
        (res) => {
          clearTimeout(timer);
          resolve(res);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  } catch (err) {
    const shell = await cached();
    if (shell) return shell;
    throw err;
  }
}

// Hashed build output: a name never changes its content, so the cache is final.
async function cacheFirst(request) {
  const hit = await caches.match(request, { cacheName: SHELL_CACHE });
  if (hit) return hit;
  const res = await fetch(request);
  if (res.status === 200) {
    const copy = res.clone();
    caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
  }
  return res;
}

// Icons, manifest, worklets, VAD runtime: serve what we have, refresh behind it.
async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const hit = (await caches.match(request, { cacheName: SHELL_CACHE })) || (await cache.match(request));
  const refresh = fetch(request).then((res) => {
    if (res.status === 200) cache.put(request, res.clone()).catch(() => {});
    return res;
  });
  if (hit) {
    refresh.catch(() => {});
    return hit;
  }
  return refresh;
}
