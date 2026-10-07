import { useEffect, useState } from "react";
import type { ClientMessage, ServerMessage } from "@loqui/protocol";
import type { ConfigInfo } from "../lib/session";
import type { OrbSkin, Settings } from "../lib/settings";
import { resolveWsUrl, NATIVE_SERVER_SUGGESTION } from "../lib/settings";
import "./SettingsSheet.css";

export type SettingsSheetProps = {
  open: boolean;
  settings: Settings;
  onClose: () => void;
  onSave: (next: Settings) => void;
  /** Live server-side agent config (null while disconnected). */
  serverConfig: ConfigInfo | null;
  /** Apply a server-side change immediately (shared by every client). */
  onServerConfig: (patch: Omit<Extract<ClientMessage, { type: "config.set" }>, "type">) => void;
};

const SPEEDS = [0.8, 0.9, 1, 1.1, 1.25, 1.5];

type TestState = { status: "idle" | "testing" | "ok" | "fail"; message?: string };

const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? "dev";

/** Open a probe WS, resolve true iff a `config` frame arrives within 3s. */
function testConnection(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let ws: WebSocket;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 3000);
    try {
      ws = new WebSocket(url);
    } catch {
      clearTimeout(timer);
      resolve(false);
      return;
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      try {
        const msg = JSON.parse(ev.data) as ServerMessage;
        if (msg.type === "config") done(true);
      } catch {
        /* keep waiting */
      }
    };
    ws.onerror = () => done(false);
    ws.onclose = () => done(false);
  });
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="settings-row settings-row--toggle">
      <span className="settings-row__text">
        <span className="settings-row__label">{label}</span>
        {hint && <span className="settings-row__hint">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`switch${checked ? " switch--on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span className="switch__thumb" />
      </button>
    </label>
  );
}

export function SettingsSheet({
  open,
  settings,
  onClose,
  onSave,
  serverConfig,
  onServerConfig,
}: SettingsSheetProps) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [test, setTest] = useState<TestState>({ status: "idle" });

  // Re-sync the local draft whenever the sheet is (re)opened.
  useEffect(() => {
    if (open) {
      setDraft(settings);
      setTest({ status: "idle" });
    }
  }, [open, settings]);

  if (!open) return null;

  const patch = (p: Partial<Settings>) => setDraft((d) => ({ ...d, ...p }));

  const runTest = async () => {
    setTest({ status: "testing" });
    const ok = await testConnection(resolveWsUrl(draft.serverUrl));
    setTest(ok ? { status: "ok", message: "Connected" } : { status: "fail", message: "No response" });
  };

  const save = () => {
    onSave(draft);
    onClose();
  };

  return (
    <>
      <div className="sheet-overlay" onClick={onClose} />
      <div className="settings-sheet" role="dialog" aria-label="Settings" aria-modal="true">
        <div className="settings-sheet__grip" />
        <div className="settings-sheet__header">
          <span className="settings-sheet__title">Settings</span>
          <button type="button" className="settings-sheet__close" onClick={onClose} aria-label="Close settings">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="settings-sheet__body">
          <div className="settings-row settings-row--field">
            <label className="settings-row__label" htmlFor="server-url">
              Server URL
            </label>
            <span className="settings-row__hint">Full ws:// or wss:// URL incl. /ws. Empty = same origin.</span>
            <div className="server-url-row">
              <input
                id="server-url"
                type="url"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder={NATIVE_SERVER_SUGGESTION}
                value={draft.serverUrl}
                onChange={(e) => {
                  patch({ serverUrl: e.target.value });
                  setTest({ status: "idle" });
                }}
              />
              <button type="button" className="test-btn" onClick={runTest} disabled={test.status === "testing"}>
                {test.status === "testing" ? "Testing…" : "Test"}
              </button>
            </div>
            {test.status !== "idle" && test.status !== "testing" && (
              <span className={`test-result test-result--${test.status}`}>
                {test.status === "ok" ? "✓ " : "✕ "}
                {test.message}
              </span>
            )}
          </div>

          <div className="settings-section">
            <span className="settings-row__label">Assistant</span>
            <span className="settings-row__hint">
              {serverConfig
                ? "Applies immediately on the server, for every connected device."
                : "Connect to the server to change the model and voice."}
            </span>
          </div>

          {serverConfig && (
            <>
              <div className="settings-row settings-row--field">
                <label className="settings-row__label" htmlFor="agent-model">
                  Model
                </label>
                <select
                  id="agent-model"
                  className="settings-select"
                  value={serverConfig.model}
                  onChange={(e) => onServerConfig({ model: e.target.value })}
                >
                  {serverConfig.models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>

              {serverConfig.voices.length > 0 && (
                <div className="settings-row settings-row--field">
                  <label className="settings-row__label" htmlFor="tts-voice">
                    Voice
                  </label>
                  <select
                    id="tts-voice"
                    className="settings-select"
                    value={serverConfig.voice}
                    onChange={(e) => onServerConfig({ voice: e.target.value })}
                  >
                    {serverConfig.voices.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="settings-row settings-row--field">
                <label className="settings-row__label" htmlFor="tts-speed">
                  Speaking speed
                </label>
                <select
                  id="tts-speed"
                  className="settings-select"
                  value={String(serverConfig.speed)}
                  onChange={(e) => onServerConfig({ speed: Number(e.target.value) })}
                >
                  {(SPEEDS.includes(serverConfig.speed) ? SPEEDS : [...SPEEDS, serverConfig.speed].sort((x, y) => x - y))
                    .map((v) => (
                      <option key={v} value={String(v)}>
                        {v}×
                      </option>
                    ))}
                </select>
              </div>
            </>
          )}

          <Toggle
            label="Half-duplex"
            hint="Mute the mic while the assistant speaks. Turn on if you hear echo."
            checked={draft.halfDuplex}
            onChange={(v) => patch({ halfDuplex: v })}
          />

          <Toggle
            label="Push-to-talk"
            hint="Hold the mic button to talk instead of open-mic + VAD."
            checked={draft.pttMode}
            onChange={(v) => patch({ pttMode: v })}
          />

          <Toggle
            label="Show timings"
            hint="Per-turn latency debug row under the transcript."
            checked={draft.showTimings}
            onChange={(v) => patch({ showTimings: v })}
          />

          <div className="settings-row settings-row--field">
            <label className="settings-row__label" htmlFor="orb-skin">
              Orb skin
            </label>
            <select
              id="orb-skin"
              className="settings-select"
              value={draft.orbSkin}
              onChange={(e) => patch({ orbSkin: e.target.value as OrbSkin })}
            >
              <option value="mesh">Mesh</option>
              <option value="stardust">Stardust</option>
              <option value="ribbons">Ribbons</option>
            </select>
          </div>

          <div className="settings-row settings-row--about">
            <span className="settings-row__label">About</span>
            <span className="settings-row__hint">Loqui v{APP_VERSION}</span>
          </div>
        </div>

        <div className="settings-sheet__footer">
          <button type="button" className="settings-save" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </>
  );
}
