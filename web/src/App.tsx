import { Suspense, lazy, useEffect, useRef, useState } from "react";
import type { ServerMessage, SessionState } from "@loqui/protocol";
import { Capacitor } from "@capacitor/core";
import { LoquiSocket } from "./lib/ws";
import { MicCapture } from "./lib/mic";
import { Player } from "./lib/player";
import type { VoiceActivity } from "./lib/vad";
import { useSession } from "./lib/session";
import {
  DEFAULT_SETTINGS,
  NATIVE_SERVER_SUGGESTION,
  loadSettings,
  resolveWsUrl,
  saveSettings,
  type Settings,
} from "./lib/settings";
import { allowSleep, keepAwake } from "./lib/wake";
import { StatusPill } from "./components/StatusPill";
import { Transcript } from "./components/Transcript";
import { ControlBar } from "./components/ControlBar";
import { HistoryDrawer } from "./components/HistoryDrawer";
import { SettingsSheet } from "./components/SettingsSheet";
import "./App.css";

// Dynamic import on purpose: code-splits three.js out of the entry chunk.
const Orb = lazy(() => import("./components/Orb").then((m) => ({ default: m.Orb })));

function greetingWord(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Morning";
  if (hour < 17) return "Afternoon";
  return "Evening";
}

function assertNever(value: never): never {
  throw new Error(`Unhandled ServerMessage type: ${JSON.stringify(value)}`);
}

function formatTimings(t: { sttMs?: number; ttfbMs?: number; firstAudioMs?: number }): string {
  const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const parts: string[] = [];
  if (t.sttMs != null) parts.push(`stt ${s(t.sttMs)}`);
  if (t.ttfbMs != null) parts.push(`first token ${s(t.ttfbMs)}`);
  if (t.firstAudioMs != null) parts.push(`first audio ${s(t.firstAudioMs)}`);
  return parts.join(" · ");
}

export function App() {
  const state = useSession((s) => s.state);
  const micLevel = useSession((s) => s.micLevel);
  const playbackLevel = useSession((s) => s.playbackLevel);
  const liveUser = useSession((s) => s.liveUser);
  const liveAssistant = useSession((s) => s.liveAssistant);
  const toolActivity = useSession((s) => s.toolActivity);
  const history = useSession((s) => s.history);
  const errorMessage = useSession((s) => s.errorMessage);
  const lastTimings = useSession((s) => s.lastTimings);
  const serverConfig = useSession((s) => s.config);
  const connected = useSession((s) => s.connected);

  const [settings, setSettings] = useState<Settings | null>(null);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [sessionActive, setSessionActiveState] = useState(false);
  const [micHeld, setMicHeld] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const wsRef = useRef<LoquiSocket | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const playerRef = useRef<Player | null>(null);
  const vadRef = useRef<VoiceActivity | null>(null);
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);
  const sessionActiveRef = useRef(false);
  const prevStateRef = useRef<SessionState>("idle");

  const setSessionActive = (active: boolean) => {
    sessionActiveRef.current = active;
    setSessionActiveState(active);
  };

  // --- one-time media graph (Player + MicCapture) -------------------------
  useEffect(() => {
    const player = new Player();
    playerRef.current = player;

    const mic = new MicCapture({
      onFrame: (pcm) => {
        // Half-duplex: don't feed the mic to the server while the assistant is
        // speaking (VAD is also paused, so barge-in is tap-only there).
        if (settingsRef.current.halfDuplex && useSession.getState().state === "speaking") return;
        wsRef.current?.sendAudio(pcm);
      },
      onLevel: (level) => useSession.getState().setMicLevel(level),
    });
    micRef.current = mic;

    return () => {
      if (mic.isActive) mic.stop();
      void vadRef.current?.destroy();
    };
  }, []);

  // --- boot: load settings, decide where (and whether) to connect ---------
  useEffect(() => {
    let cancelled = false;
    void loadSettings().then((loaded) => {
      if (cancelled) return;
      settingsRef.current = loaded;
      setSettings(loaded);
      if (Capacitor.isNativePlatform() && !loaded.serverUrl.trim()) {
        // Native shell with no server configured yet: prompt for one.
        setSettingsOpen(true);
      } else {
        setWsUrl(resolveWsUrl(loaded.serverUrl));
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // --- WS connection, re-created whenever the resolved URL changes --------
  useEffect(() => {
    if (!wsUrl) return;

    function handleMessage(msg: ServerMessage) {
      const store = useSession.getState();
      switch (msg.type) {
        case "state":
          store.setState(msg.value);
          break;
        case "stt.segment":
          store.appendSttSegment(msg.text);
          break;
        case "assistant.delta":
          store.appendAssistantDelta(msg.text);
          break;
        case "assistant.done":
          store.finalizeAssistant(msg.text, msg.timings);
          break;
        case "tool.activity":
          store.setToolActivity({ tool: msg.tool, detail: msg.detail });
          break;
        case "tts.segment":
          playerRef.current?.onSegmentStart(msg.id);
          break;
        case "tts.flush":
          playerRef.current?.flush();
          break;
        case "config":
          store.setConfig({
            model: msg.model,
            models: msg.models,
            voice: msg.voice,
            voices: msg.voices ?? [],
            speed: msg.speed,
          });
          break;
        case "error":
          console.error("[loqui] server error:", msg.message);
          store.setError(msg.message);
          break;
        default:
          assertNever(msg);
      }
    }

    const ws = new LoquiSocket(wsUrl, {
      onOpen: () => {
        useSession.getState().setConnected(true);
        useSession.getState().setError(null);
      },
      onClose: () => {
        useSession.getState().setConnected(false);
        void allowSleep();
      },
      onMessage: handleMessage,
      onAudio: (segmentId, pcm) => {
        void playerRef.current?.pushAudio(segmentId, pcm);
      },
    });
    wsRef.current = ws;
    ws.connect();

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [wsUrl]);

  // --- orb playback pulse (Player analyser level while speaking) ----------
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const current = useSession.getState().state;
      const level = current === "speaking" ? (playerRef.current?.getLevel() ?? 0) : 0;
      useSession.getState().setPlaybackLevel(level);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // --- state transitions: half-duplex VAD gating + segment-end marker -----
  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = state;
    if (!sessionActiveRef.current) return;

    if (settingsRef.current.halfDuplex && vadRef.current?.isActive) {
      if (state === "speaking") vadRef.current.pause();
      else if (prev === "speaking") vadRef.current.resume();
    }

    // A reply that finished naturally (speaking -> idle) releases its final,
    // possibly sub-threshold, TTS segment from the jitter buffer.
    if (prev === "speaking" && state === "idle") playerRef.current?.endSegment();
  }, [state]);

  const handleBargeIn = () => {
    wsRef.current?.send({ type: "barge_in" });
    playerRef.current?.flush();
  };

  const startConversation = async () => {
    if (sessionActiveRef.current) return;
    try {
      await playerRef.current?.resume();
      await micRef.current?.start();
    } catch (err) {
      console.error("[loqui] microphone start failed", err);
      useSession.getState().setError("Couldn't access the microphone.");
      return;
    }
    wsRef.current?.send({ type: "session.start" });
    setSessionActive(true);
    void keepAwake();

    if (!settingsRef.current.pttMode) {
      // Dynamic import on purpose: onnxruntime/VAD loads only when a hands-free session starts.
      const { VoiceActivity } = await import("./lib/vad");
      const vad = new VoiceActivity();
      vadRef.current = vad;
      try {
        await vad.start(
          () => {
            const stream = micRef.current?.getStream();
            if (!stream) throw new Error("mic stream unavailable for VAD");
            return stream;
          },
          {
            onSpeechStart: () => {
              if (useSession.getState().state === "speaking") handleBargeIn();
            },
            onSpeechEnd: () => {
              wsRef.current?.send({ type: "utterance.end" });
            },
          },
        );
      } catch (err) {
        console.error("[loqui] VAD init failed; use push-to-talk or text", err);
      }
    }
  };

  const endConversation = () => {
    if (micRef.current?.isActive) {
      micRef.current.stop();
      setMicHeld(false);
    }
    void vadRef.current?.destroy();
    vadRef.current = null;
    // Stop means silence NOW — drop any TTS still buffered in the worklet.
    playerRef.current?.flush();
    wsRef.current?.send({ type: "session.stop" });
    setSessionActive(false);
    void allowSleep();
  };

  // Open-mic: tap the mic button / orb to start, end, or interrupt.
  const handleMicTap = () => {
    if (!sessionActiveRef.current) {
      void startConversation();
      return;
    }
    if (useSession.getState().state === "speaking") {
      handleBargeIn();
      return;
    }
    endConversation();
  };

  // Push-to-talk fallback: hold the mic button to talk.
  const handleMicDown = async () => {
    await playerRef.current?.resume();
    if (useSession.getState().state === "speaking") handleBargeIn();
    if (!sessionActiveRef.current) {
      wsRef.current?.send({ type: "session.start" });
      setSessionActive(true);
      void keepAwake();
    }
    try {
      await micRef.current?.start();
      setMicHeld(true);
    } catch (err) {
      console.error("[loqui] microphone start failed", err);
      useSession.getState().setError("Couldn't access the microphone.");
    }
  };

  const handleMicUp = () => {
    if (!micRef.current?.isActive) return;
    micRef.current.stop();
    setMicHeld(false);
    wsRef.current?.send({ type: "utterance.end" });
  };

  const handleOrbTap = () => {
    if (settingsRef.current.pttMode) {
      // In PTT the orb only interrupts a spoken reply; talking is the mic hold.
      if (useSession.getState().state === "speaking") handleBargeIn();
      return;
    }
    handleMicTap();
  };

  const handleStop = () => endConversation();

  const handleSubmitText = (text: string) => {
    useSession.getState().addUserText(text);
    wsRef.current?.send({ type: "text.prompt", text });
  };

  const handleSaveSettings = (next: Settings) => {
    const prevResolved = resolveWsUrl(settingsRef.current.serverUrl);
    settingsRef.current = next;
    setSettings(next);
    void saveSettings(next);
    const resolved = resolveWsUrl(next.serverUrl);
    if (wsUrl === null || resolved !== prevResolved) setWsUrl(resolved);
  };

  const activeSettings = settings ?? DEFAULT_SETTINGS;
  // On native with no server yet, prefill the suggestion in the sheet.
  const sheetSettings: Settings =
    Capacitor.isNativePlatform() && !activeSettings.serverUrl.trim()
      ? { ...activeSettings, serverUrl: NATIVE_SERVER_SUGGESTION }
      : activeSettings;

  const isIdleGreeting = state === "idle" && liveUser.length === 0 && liveAssistant.length === 0;
  const orbLevel = state === "listening" ? micLevel : state === "speaking" ? playbackLevel : 0;
  const userName = import.meta.env.VITE_USER_NAME || "there";
  const showTimingsRow = activeSettings.showTimings && lastTimings !== null;

  return (
    <div className="app-shell" data-orb-skin={activeSettings.orbSkin}>
      <HistoryDrawer
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        entries={history}
        apiBase={wsUrl ? new URL(wsUrl).origin.replace(/^ws/, "http") : null}
      />

      <div className="app-main">
        <div className="app-top">
          {isIdleGreeting ? (
            <div className="greeting">
              <p className="greeting__headline">
                {greetingWord()}, {userName}.
              </p>
              <p className="greeting__subtitle">Tap to start</p>
            </div>
          ) : (
            <StatusPill state={state} toolActivity={toolActivity} />
          )}
        </div>

        <Suspense fallback={<div className={`orb-wrap state-${state}`} />}>
          <Orb state={state} level={orbLevel} onTap={handleOrbTap} />
        </Suspense>

        <div className="app-transcript-slot">
          <Transcript liveUser={liveUser} liveAssistant={liveAssistant} />
        </div>

        {showTimingsRow && lastTimings && <div className="timings-row">{formatTimings(lastTimings)}</div>}
      </div>

      <div className="app-controls">
        {errorMessage && <div className="error-banner">{errorMessage}</div>}
        <ControlBar
          pttMode={activeSettings.pttMode}
          sessionActive={sessionActive}
          micActive={activeSettings.pttMode ? micHeld : sessionActive}
          micLevel={micLevel}
          onMicTap={handleMicTap}
          onMicDown={handleMicDown}
          onMicUp={handleMicUp}
          onStop={handleStop}
          onOpenSettings={() => setSettingsOpen(true)}
          onSubmitText={handleSubmitText}
        />
      </div>

      <SettingsSheet
        open={settingsOpen}
        settings={sheetSettings}
        onClose={() => setSettingsOpen(false)}
        onSave={handleSaveSettings}
        serverConfig={connected ? serverConfig : null}
        onServerConfig={(patch) => wsRef.current?.send({ type: "config.set", ...patch })}
      />
    </div>
  );
}
