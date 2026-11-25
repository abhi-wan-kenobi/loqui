import { useSyncExternalStore } from "react";
import { Capacitor } from "@capacitor/core";

/**
 * Browser-PWA plumbing: service-worker registration, the "new version ready"
 * signal and the install prompt. All of it is inert inside the Capacitor
 * native shell, which ships its own assets.
 */

export type PwaState = {
  /** A new build is installed and waiting; `applyUpdate()` switches to it. */
  updateReady: boolean;
  /** The browser offered an install prompt we are holding; `promptInstall()` shows it. */
  canInstall: boolean;
};

// The install prompt event isn't in lib.dom.
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let state: PwaState = { updateReady: false, canInstall: false };
const listeners = new Set<() => void>();
let waiting: ServiceWorker | null = null;
let installEvent: BeforeInstallPromptEvent | null = null;

function set(patch: Partial<PwaState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePwa(): PwaState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Activate the waiting worker; the page reloads once it has taken control. */
export function applyUpdate(): void {
  waiting?.postMessage({ type: "SKIP_WAITING" });
}

export async function promptInstall(): Promise<void> {
  const event = installEvent;
  if (!event) return;
  installEvent = null;
  set({ canInstall: false });
  await event.prompt();
  await event.userChoice;
}

function trackWaiting(registration: ServiceWorkerRegistration): void {
  // A waiting worker only counts as an *update* when a page is already
  // controlled; on first install there is nothing to switch from.
  if (registration.waiting && navigator.serviceWorker.controller) {
    waiting = registration.waiting;
    set({ updateReady: true });
  }
}

export function registerPwa(): void {
  if (Capacitor.isNativePlatform()) return;

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installEvent = e as BeforeInstallPromptEvent;
    set({ canInstall: true });
  });
  window.addEventListener("appinstalled", () => {
    installEvent = null;
    set({ canInstall: false });
  });

  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return;

  // Reload exactly once, when a worker the user asked for takes over.
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!waiting || reloading) return;
    reloading = true;
    window.location.reload();
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        trackWaiting(registration);
        registration.addEventListener("updatefound", () => {
          const incoming = registration.installing;
          incoming?.addEventListener("statechange", () => {
            if (incoming.state === "installed") trackWaiting(registration);
          });
        });
        // An installed PWA can stay open for days; look for a new build when it comes back to the foreground.
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") void registration.update().catch(() => {});
        });
      })
      .catch((err) => {
        console.warn("[sw] registration failed", err);
      });
  });
}
