import { Preferences } from "@capacitor/preferences";

/**
 * User settings. Persisted via `@capacitor/preferences`, which is backed by
 * localStorage on the web (and by native secure storage on iOS/Android), so
 * the same code path works in the PWA and the Capacitor app.
 *
 * SETTINGS KEYS CONTRACT (each field is its own Preferences key, so other
 * agents/components can read a single value without loading the whole blob):
 *   serverUrl    string  full ws(s):// URL incl. the /ws path; ""/empty = same-origin
 *   halfDuplex   bool    mute mic + pause VAD while the assistant is speaking
 *   pttMode      bool    push-to-talk fallback (hold the mic button to talk)
 *   orbSkin      string  "mesh" | "stardust"  (consumed by the orb renderer)
 *   showTimings  bool    show the per-turn latency debug row
 */
export type OrbSkin = "mesh" | "stardust";

export type Settings = {
  serverUrl: string;
  halfDuplex: boolean;
  pttMode: boolean;
  orbSkin: OrbSkin;
  showTimings: boolean;
};

export const SETTINGS_KEYS = {
  serverUrl: "serverUrl",
  halfDuplex: "halfDuplex",
  pttMode: "pttMode",
  orbSkin: "orbSkin",
  showTimings: "showTimings",
} as const;

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: "",
  halfDuplex: false,
  pttMode: false,
  orbSkin: "mesh",
  showTimings: false,
};

/**
 * Suggested URL prefilled in the native app when no server is configured.
 * A neutral LAN example — the user replaces the host with their own server's
 * address. Override at build time with VITE_DEFAULT_SERVER for a personal build.
 */
export const NATIVE_SERVER_SUGGESTION =
  import.meta.env.VITE_DEFAULT_SERVER || "ws://192.168.1.100:8480/ws";

const isOrbSkin = (v: string | null): v is OrbSkin => v === "mesh" || v === "stardust";

export async function loadSettings(): Promise<Settings> {
  const [serverUrl, halfDuplex, pttMode, orbSkin, showTimings] = await Promise.all([
    Preferences.get({ key: SETTINGS_KEYS.serverUrl }),
    Preferences.get({ key: SETTINGS_KEYS.halfDuplex }),
    Preferences.get({ key: SETTINGS_KEYS.pttMode }),
    Preferences.get({ key: SETTINGS_KEYS.orbSkin }),
    Preferences.get({ key: SETTINGS_KEYS.showTimings }),
  ]);

  return {
    serverUrl: serverUrl.value ?? DEFAULT_SETTINGS.serverUrl,
    halfDuplex: halfDuplex.value === "true",
    pttMode: pttMode.value === "true",
    orbSkin: isOrbSkin(orbSkin.value) ? orbSkin.value : DEFAULT_SETTINGS.orbSkin,
    showTimings: showTimings.value === "true",
  };
}

export async function saveSettings(s: Settings): Promise<void> {
  await Promise.all([
    Preferences.set({ key: SETTINGS_KEYS.serverUrl, value: s.serverUrl }),
    Preferences.set({ key: SETTINGS_KEYS.halfDuplex, value: String(s.halfDuplex) }),
    Preferences.set({ key: SETTINGS_KEYS.pttMode, value: String(s.pttMode) }),
    Preferences.set({ key: SETTINGS_KEYS.orbSkin, value: s.orbSkin }),
    Preferences.set({ key: SETTINGS_KEYS.showTimings, value: String(s.showTimings) }),
  ]);
}

/**
 * Resolve the effective WS URL: an explicit `serverUrl` wins; otherwise fall
 * back to same-origin `ws(s)://${location.host}/ws` (the PWA default).
 */
export function resolveWsUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim();
  if (trimmed) return trimmed;
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws`;
}
