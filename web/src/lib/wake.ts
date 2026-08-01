import { KeepAwake } from "@capacitor-community/keep-awake";

/**
 * Keep the screen awake during an active conversation. Prefers the native
 * KeepAwake plugin (guarded by isSupported); on the web it falls back to the
 * Screen Wake Lock API where available, and is otherwise a silent no-op.
 */

let wakeLock: WakeLockSentinel | null = null;

async function nativeSupported(): Promise<boolean> {
  try {
    const { isSupported } = await KeepAwake.isSupported();
    return isSupported;
  } catch {
    return false;
  }
}

export async function keepAwake(): Promise<void> {
  if (await nativeSupported()) {
    try {
      await KeepAwake.keepAwake();
      return;
    } catch {
      /* fall through to the web wake lock */
    }
  }
  try {
    wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
  } catch {
    /* wake lock unavailable (e.g. tab not visible) — best-effort only */
  }
}

export async function allowSleep(): Promise<void> {
  if (await nativeSupported()) {
    try {
      await KeepAwake.allowSleep();
    } catch {
      /* ignore */
    }
  }
  try {
    await wakeLock?.release();
  } catch {
    /* ignore */
  }
  wakeLock = null;
}
